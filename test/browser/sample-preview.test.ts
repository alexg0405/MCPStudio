/**
 * The sample browser's audition in the real engine: a loop waits for the next beat of the playing song and starts on it
 * (the song's own audio is heard at the same moment), starts at once when nothing plays, a tempo match stretches the sound
 * keeping its pitch, resampling and key shifts change the playback rate, and the preview level is the bus gain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeWav } from '@core/io/wav';
import { PPQ } from '@core/time/ppq';
import { createServices, type Services } from '@app/services';
import { Engine } from '@engine/engine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sample preview in the engine', { timeout: 60_000 }, () => {
  let engine: Engine | null = null;
  let s: Services;
  const starts: { when: number; loop: boolean; rate: number; duration: number }[] = [];
  const realStart = AudioBufferSourceNode.prototype.start;

  /** A short click then a quiet tone, so a stretched copy has an audible length to check. */
  const bytes = (seconds = 1): ArrayBuffer => {
    const sr = 44100;
    const x = Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => (i < 200 ? 0.9 * Math.sin(i / 3) : 0.3 * Math.sin(i / 20)) * Math.exp(-i / sr / 2));
    return encodeWav([x], sr, { bitDepth: 16 }).slice().buffer;
  };

  beforeAll(async () => {
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when?: number, ...rest: number[]) {
      starts.push({ when: when ?? 0, loop: this.loop, rate: this.playbackRate.value, duration: this.buffer?.duration ?? 0 });
      return realStart.call(this, when, ...rest);
    };
    s = createServices({ createEngine: (o) => (engine = Engine.realtime(o)) });
    await s.engine.resume();
    s.history.transact('Tempo', (d) => void (d.transport.bpm = 120));
  });

  afterAll(async () => {
    AudioBufferSourceNode.prototype.start = realStart;
    s.engine.stop();
    await s.engine.dispose();
  });

  it('starts at once when the song is stopped', async () => {
    starts.length = 0;
    expect(await s.engine.previewAudio(bytes(), { loop: true, onBeat: true })).toBe(true);
    const p = starts.find((x) => x.loop)!;
    expect(p).toBeDefined();
    expect(p.when).toBe(0);
    s.engine.stopPreview();
  });

  it('waits for the next beat of the playing song and starts on it (to a few ms), for several moments in a bar', async () => {
    s.engine.play(0);
    await sleep(500);
    const ctx = engine!.ctx as AudioContext;
    for (let k = 0; k < 4; k++) {
      starts.length = 0;
      expect(await s.engine.previewAudio(bytes(), { loop: true, onBeat: true })).toBe(true);
      const p = starts.find((x) => x.loop)!;
      expect(p.when).toBeGreaterThan(ctx.currentTime - 0.01);
      expect(p.when).toBeLessThan(ctx.currentTime + 1.1);
      // The song heard when the preview starts is on a beat: 120 BPM is 1.92 ticks per millisecond.
      const tick = s.engine.tickAt(p.when).tick;
      const off = Math.abs(tick - Math.round(tick / PPQ) * PPQ);
      expect(off / 1.92, `${k}: ${tick} is ${(off / 1.92).toFixed(1)} ms from a beat`).toBeLessThan(12);
      await sleep(137 + k * 90);
    }
    s.engine.stopPreview();
    s.engine.stop();
  });

  it('time-stretches a loop to the project tempo keeping its pitch (the copy is longer, the rate stays 1), and resamples with a rate', async () => {
    starts.length = 0;
    await s.engine.previewAudio(bytes(1), { stretch: 1.25, loop: true });
    const stretched = starts.at(-1)!;
    expect(stretched.rate).toBe(1);
    expect(stretched.duration).toBeGreaterThan(1.22);
    expect(stretched.duration).toBeLessThan(1.28);
    starts.length = 0;
    await s.engine.previewAudio(bytes(1), { rate: 1.5 });
    expect(starts.at(-1)!.rate).toBeCloseTo(1.5, 5);
    expect(starts.at(-1)!.duration).toBeCloseTo(1, 2);
    // Nonsense options are ignored or held to sane limits.
    await s.engine.previewAudio(bytes(1), { stretch: Number.NaN, rate: 1e9 });
    expect(starts.at(-1)!.rate).toBeLessThanOrEqual(8);
    s.engine.stopPreview();
  });

  it('a newer preview replaces the older one, and stop silences it', async () => {
    starts.length = 0;
    await Promise.all([s.engine.previewAudio(bytes(2), { loop: true }), s.engine.previewAudio(bytes(1.5), { loop: true })]);
    // Two requests in a row: only the newest is played.
    expect(starts.filter((x) => x.loop)).toHaveLength(1);
    expect(starts.find((x) => x.loop)!.duration).toBeCloseTo(1.5, 2);
    s.engine.stopPreview();
  });

  it('sets the preview level on the preview bus, held to 0..2 (a number that is not one goes back to the default)', async () => {
    const bus = engine!.output.previewBus;
    // A gain with nothing playing through it is not processed, so its value cannot be read: look at what was asked of it.
    const asked: number[] = [];
    const real = bus.gain.setTargetAtTime.bind(bus.gain);
    bus.gain.setTargetAtTime = (target: number, at: number, constant: number) => {
      asked.push(target);
      return real(target, at, constant);
    };
    for (const v of [0.3, 5, Number.NaN, -1, 0.5]) s.engine.setPreviewVolume(v);
    expect(asked).toEqual([0.3, 2, 0.8, 0, 0.5]);
    expect(await s.engine.previewAudio(bytes(), {})).toBe(true);
    s.engine.stopPreview();
  });
});
