/**
 * Idle parking in a live engine (src/engine/idle-parking.ts): plugins that sleep, and the mixer chains only they feed, leave the
 * audio graph until a note comes. What must hold: the song sounds the same parked or not (a note handed to a parked
 * channel is never lost), a note wakes everything on its path at once, the worklet barriers and the editors' taps keep
 * working for what is parked, and offline renders never park.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@app/services';
import { MASTER, type ChannelId } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { GraphVoices } from '@agstudio/sdk';
import { Engine } from '@engine/engine';
import { R } from '@engine/meter/layout';
import { TapImpl } from '@engine/tap';
import { buildSong } from '../helpers/mix-level';
import { Probe } from '../helpers/latency';
import { retryWhenOverloaded } from '../helpers/overload';
import { EVENTUALLY } from '../helpers/wait';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Rig {
  s: Services;
  engine: Engine;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.s.engine.dispose();
});

/** A live engine on the house song; `idleParking` false is the engine as it was. */
async function songRig(idleParking: boolean): Promise<Rig> {
  let engine!: Engine;
  const s = createServices({ createEngine: (options) => (engine = Engine.realtime({ ...options, idleParking })) });
  await s.engine.resume();
  buildSong(s, 'house', { bpm: 124, low: 'bass' });
  await s.engine.ready();
  const rig = { s, engine };
  rigs.push(rig);
  return rig;
}

const parked = (engine: Engine) => engine.stats().parked ?? { channels: 0, inserts: 0 };

/** Plays `bars` bars from the start and returns the integrated loudness the master meter read. */
async function playLoudness(rig: Rig, bars: number): Promise<number> {
  const { s } = rig;
  const project = s.doc.getState().project;
  const bar = ticksPerBar(project.transport.timeSig);
  const lease = s.meters.listen(MASTER, { full: true });
  await expect.poll(() => lease.meter.active && lease.meter.blocks > 10, EVENTUALLY).toBe(true);
  s.engine.play(0);
  await expect.poll(() => s.engine.playhead() >= bars * bar, { timeout: 30_000, interval: 25 }).toBe(true);
  s.engine.stop();
  const lufs = lease.meter.readings[R.integrated] as number;
  lease.release();
  return lufs;
}

describe('idle parking in a live engine', { tags: ['realtime'] }, () => {
  it('sleeping channels and the inserts only they feed are parked, and the master never is', async () => {
    const { engine } = await songRig(true);
    await expect.poll(() => parked(engine).channels, { timeout: 15_000, interval: 50 }).toBeGreaterThan(0);
    await expect.poll(() => parked(engine).inserts, { timeout: 15_000, interval: 50 }).toBeGreaterThan(0);
    expect(engine.mixer.strip(MASTER)?.parked).toBe(false);
  });

  it('plays the song as loud as the engine without parking, from channels that were parked when it started', async (test) => {
    await retryWhenOverloaded(test, async () => {
      const without = await songRig(false);
      const withParking = await songRig(true);
      // Everything has been asleep and parked for a while when the song starts: its first notes wake it.
      await expect.poll(() => parked(withParking.engine).channels, { timeout: 15_000, interval: 50 }).toBeGreaterThan(3);
      const lufsWithout = await playLoudness(without, 4);
      const lufsWith = await playLoudness(withParking, 4);
      // A note handed to a parked channel and lost shows as more than half a LU here (it did, once).
      expect(Math.abs(lufsWith - lufsWithout), `parked ${lufsWith.toFixed(2)} LUFS, always on ${lufsWithout.toFixed(2)}`).toBeLessThan(0.15);
      for (const rig of rigs.splice(0)) await rig.s.engine.dispose();
    });
  }, 120_000);

  it('a live note wakes the channel and everything it plays through before it is heard', async () => {
    const rig = await songRig(true);
    const { engine, s } = rig;
    await expect.poll(() => parked(engine).channels, { timeout: 15_000, interval: 50 }).toBeGreaterThan(3);
    const probe = await Probe.attach(engine);
    const project = s.doc.getState().project;
    const channelId = Object.keys(project.channels).find((id) => project.channels[id as ChannelId]?.kind === 'instrument') as ChannelId;
    const before = parked(engine);
    probe.arm();
    engine.previewNoteOn(channelId, 60, 1);
    // Awake at once, on the very call (the connection is made before the note is handed over).
    const after = parked(engine);
    expect(after.channels).toBeLessThan(before.channels);
    expect(await probe.hit(2000), 'the note is heard').not.toBeNull();
    probe.dispose();
  });

  it('the worklet barrier still answers for parked plugins', async () => {
    const { engine } = await songRig(true);
    await expect.poll(() => parked(engine).channels, { timeout: 15_000, interval: 50 }).toBeGreaterThan(3);
    expect(await engine.syncWorklets(2000)).toBe(true);
  });

  it('does not park anything when switched off', async () => {
    const { engine } = await songRig(false);
    await sleep(3000);
    expect(engine.stats().parked).toBeUndefined();
  });
});

describe('an editor tap on a parked plugin', () => {
  it('reads silence without listening to the plugin, and hears it again when it is back', async () => {
    const ctx = new AudioContext();
    try {
      await ctx.resume();
      const source = new OscillatorNode(ctx, { frequency: 1000 });
      const level = new GainNode(ctx, { gain: 0.5 });
      source.connect(level);
      source.start();
      const tap = new TapImpl(ctx, level);
      const wave = new Float32Array(1024);
      const peak = () => Math.max(...wave.map(Math.abs));
      const heard = () => {
        tap.waveform(wave);
        return peak();
      };
      await expect.poll(heard, EVENTUALLY).toBeGreaterThan(0.1);
      tap.setParked(true);
      wave.fill(1);
      expect(tap.waveform(wave)).toBe(true);
      expect(peak()).toBe(0);
      const spectrum = new Float32Array(512);
      expect(tap.spectrum(spectrum)).toBe(true);
      expect(spectrum.every((bin) => bin === -Infinity)).toBe(true);
      tap.setParked(false);
      await expect.poll(heard, EVENTUALLY).toBeGreaterThan(0.1);
      tap.dispose();
    } finally {
      await ctx.close();
    }
  });
});

describe('offline renders', () => {
  it('never park: the engine of a render has no parking at all', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: 48000 });
    const engine = new Engine(ctx, { plugins: { get: () => undefined } }, true);
    expect(engine.idle).toBeUndefined();
    expect(engine.stats().parked).toBeUndefined();
    await engine.dispose();
  });
});

describe('GraphVoices as a sleeper', () => {
  it('is awake from the moment a voice is added until the last one has been cleaned up', async () => {
    const ctx = new AudioContext();
    try {
      const out = new GainNode(ctx);
      const voices = new GraphVoices(ctx, out);
      // No voice yet: asleep, as an instrument in a new project is.
      expect(voices.sleep.asleep).toBe(true);
      const changes: boolean[] = [];
      voices.sleep.onChange((asleep) => changes.push(asleep));
      const oscillator = new OscillatorNode(ctx, { frequency: 220 });
      const gain = new GainNode(ctx);
      oscillator.connect(gain);
      oscillator.start();
      // The first voice of a sleeping instrument: cleaning up finished voices while it is added must not put the
      // instrument back to sleep before the voice is in (it did once, and the channel was taken out under the note).
      voices.add(1, { start: ctx.currentTime, sources: [oscillator], out: gain });
      expect(voices.sleep.asleep).toBe(false);
      expect(changes).toEqual([false]);
      voices.release(1, ctx.currentTime + 0.01);
      await expect.poll(() => voices.sleep.asleep, EVENTUALLY).toBe(true);
      expect(changes).toEqual([false, true]);
      voices.disposeAll();
    } finally {
      await ctx.close();
    }
  });
});
