/**
 * Audio latency, measured end to end with the real app services and the real-time engine in headless Chrome:
 * key → sound, MIDI → sound, play → first note, edit while playing, knob → sound (see test/helpers/latency.ts for how a
 * measurement is made and split). Run `npm run test:perf` for the full sweep (three buffers, an idle and a heavy
 * song) and read the `LAT |` lines; the regular run does a short pass with loose limits.
 *
 * The heavy song is the `?perf=mix30` fixture (26 instruments, 20 effects) playing with its ten mixer tracks muted:
 * the audio thread does all the work and the probe only hears the test tone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addInstrumentChannel } from '@app/actions/channels';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { memoryPresetStorage } from '@app/presets';
import { createServices, type Services } from '@app/services';
import type { AudioBufferSize } from '@app/stores/prefs';
import { createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ChannelId, InsertId, NoteId, PatternId } from '@core/model/types';
import { setChannelProp, setPluginParam } from '@core/ops/channels';
import { setInsertProp } from '@core/ops/mixer';
import { addNote, removeNote } from '@core/ops/notes';
import { registerFeatures } from '@ui/features';
import { installKeyboard } from '@ui/keyboard';
import { applyPerfFixture } from '@ui/perf-fixtures';
import { innerEngine, measure, Probe, row, summarize, type Sample } from '../helpers/latency';
import { perfLimit, STRICT_PERF } from '../helpers/perf';
import { defineWorkletInstrument, p } from '@agstudio/sdk';
import processor from './latency-tone.worklet.ts?worker&url';

const tone = defineWorkletInstrument({
  id: 'test.latency-tone',
  name: 'Latency tone',
  version: 1,
  params: { level: p.float(0, 1, 1) },
  processor,
  tailTime: 0.05,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PREFS_KEY = 'agstudio:prefs:v1';

interface Rig {
  s: Services;
  ctx: AudioContext;
  probe: Probe;
  channel: ChannelId;
  pattern: PatternId;
  heavy: boolean;
  /** Puts the test tone's note at tick 0 (1 beat), or takes it away. */
  startNote(on: boolean): void;
  /** Wraps the engine's entry points so a measurement knows when the engine was called. */
  callMark: { fn: (() => void) | null };
  dispose(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
});

async function boot(buffer: AudioBufferSize, heavy: boolean): Promise<Rig> {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ audioBuffer: buffer, audioBufferPicked: true, typingPiano: true, pianoOctave: 5 }));
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  plugins.sync('user', [{ path: 'test/latency-tone', def: tone }]);
  const s = createServices({ plugins, project: createEmptyProject(), presetStorage: memoryPresetStorage() });
  registerFeatures(s);
  const offKeys = installKeyboard(s);
  const pattern = s.view.getState().currentPatternId as PatternId;
  let inserts: InsertId[] = [];
  if (heavy) {
    applyPerfFixture(s, 'mix30');
    inserts = s.doc.getState().project.mixer.order.slice(1);
    s.history.transact('Mute the mix', (d) => {
      for (const id of inserts) setInsertProp(d, id, 'muted', true);
    });
  }
  const channel = addInstrumentChannel(s, 'test.latency-tone') as ChannelId;
  s.session.getState().selectChannel(channel);
  await s.engine.resume();
  await s.engine.ready();
  const inner = innerEngine(s.engine);
  const probe = await Probe.attach(inner);
  const callMark: Rig['callMark'] = { fn: null };
  // Where the engine is called from the app: live notes and playing.
  for (const name of ['previewNoteOn', 'play'] as const) {
    const orig = (inner[name] as (...a: never[]) => unknown).bind(inner);
    (inner as unknown as Record<string, unknown>)[name] = (...a: never[]) => {
      callMark.fn?.();
      return orig(...a);
    };
  }
  const startNote = (on: boolean) =>
    s.history.transact('Start note', (d) => {
      if (on) addNote(d, pattern, channel, { id: 'start' as NoteId, tick: 0, length: 960, key: 60, velocity: 1 });
      else removeNote(d, pattern, channel, 'start' as NoteId);
    });
  const rig: Rig = {
    s,
    ctx: inner.ctx as AudioContext,
    probe,
    channel,
    pattern,
    heavy,
    startNote,
    callMark,
    async dispose() {
      offKeys();
      probe.dispose();
      await s.engine.dispose();
      localStorage.removeItem(PREFS_KEY);
    },
  };
  rigs.push(rig);
  if (heavy) {
    s.engine.play(0);
    await sleep(1500);
  }
  return rig;
}

/** Repeats `fn` n times, keeps what it measured (and how many missed). */
async function repeat(n: number, fn: () => Promise<Sample | null>): Promise<{ samples: Sample[]; missed: number }> {
  const samples: Sample[] = [];
  let missed = 0;
  // The first runs warm the engine up (the first output timestamps of a context are not valid yet): not counted.
  for (let i = -2; i < n; i++) {
    const m = await fn();
    if (i < 0) {
      await sleep(150);
      continue;
    }
    if (m) samples.push(m);
    else {
      missed++;
      console.log(`LAT | miss at run ${i}`);
    }
    // Off the beat of the 5 ms and 21 ms audio callbacks, so the runs sample all their phases.
    await sleep(60 + ((i * 7) % 13));
  }
  return { samples, missed };
}

function report(label: string, r: { samples: Sample[]; missed: number }): void {
  const parts = (k: keyof Sample) => r.samples.map((x) => x[k]);
  console.log(row(`${label} total`, parts('total')));
  console.log(row(`${label}   handling`, parts('handling')));
  console.log(row(`${label}   transit`, parts('transit')));
  console.log(row(`${label}   rest (output)`, parts('rest')));
  if (r.missed) console.log(`LAT | ${label}: ${r.missed} missed`);
}

/** A key press on the typing piano (the real keyboard handler → live input → engine). */
function keyTrigger(code: string) {
  return (rig: Rig) => ({
    fire(mark: () => void) {
      rig.callMark.fn = () => {
        rig.callMark.fn = null;
        mark();
      };
      const down = new KeyboardEvent('keydown', { code, key: 'z', bubbles: true, cancelable: true });
      const t0 = down.timeStamp;
      window.dispatchEvent(down);
      // Release it again a little later, so the next press is a new note.
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'z', bubbles: true })), 20);
      return t0;
    },
  });
}

/** A MIDI note-on message into the MIDI input (what the browser's `onmidimessage` hands it). */
function midiTrigger(rig: Rig) {
  return {
    fire(mark: () => void) {
      rig.callMark.fn = () => {
        rig.callMark.fn = null;
        mark();
      };
      const t0 = performance.now();
      rig.s.midi.handle('Test keyboard', new Uint8Array([0x90, 60, 100]), t0);
      setTimeout(() => rig.s.midi.handle('Test keyboard', new Uint8Array([0x80, 60, 0]), performance.now()), 20);
      return t0;
    },
  };
}

const COMBOS: { buffer: AudioBufferSize; heavy: boolean }[] = STRICT_PERF
  ? (['small', 'medium', 'large'] as const).flatMap((buffer) => [
      { buffer, heavy: false },
      { buffer, heavy: true },
    ])
  : [
      { buffer: 'small', heavy: false },
      // Taps shorter than an audio callback must still sound with the biggest one.
      { buffer: 'large', heavy: false },
    ];
const N = STRICT_PERF ? 40 : 6;

describe.each(COMBOS)('latency, $buffer buffer, heavy song: $heavy', ({ buffer, heavy }) => {
  const tag = `${buffer.padEnd(6)} ${heavy ? 'heavy' : 'idle '}`;

  it('live notes: typing keyboard and MIDI', { tags: ['perf'], timeout: 300_000 }, async () => {
    const rig = await boot(buffer, heavy);
    const keys = await repeat(N, () => measure(rig.probe, rig.ctx, keyTrigger('KeyZ')(rig)));
    report(`${tag} key`, keys);
    const midi = await repeat(N, () => measure(rig.probe, rig.ctx, midiTrigger(rig)));
    report(`${tag} midi`, midi);
    console.log(
      `LAT | ${tag} base ${(rig.ctx.baseLatency * 1000).toFixed(1)} ms, output ${(rig.ctx.outputLatency * 1000).toFixed(1)} ms, keepUp ${rig.s.engine.stats().keepUp ?? '-'}, late ${rig.s.engine.stats().lateEvents}`,
    );
    // A tap shorter than an audio callback is still heard (its release used to cancel it with the large buffer).
    expect(keys.missed).toBe(0);
    expect(midi.missed).toBe(0);
    expect(summarize(keys.samples.map((x) => x.total)).median).toBeLessThan(perfLimit(120, 400));
  });

  it('play: first note at tick 0', { tags: ['perf'], timeout: 300_000 }, async () => {
    const rig = await boot(buffer, heavy);
    if (heavy) rig.s.engine.stop();
    await sleep(200);
    rig.startNote(true);
    const play = await repeat(N, async () => {
      const m = await measure(rig.probe, rig.ctx, {
        fire(mark) {
          rig.callMark.fn = () => {
            rig.callMark.fn = null;
            mark();
          };
          const t0 = performance.now();
          rig.s.engine.play(0);
          return t0;
        },
      });
      rig.s.engine.stop();
      await sleep(150);
      return m;
    });
    report(`${tag} play`, play);
    // How far after its scheduled time the first note sounded: ~0 when the notes reached the audio thread in time
    // (the heavy song's mixer delays every path by its plugins' latency, which the schedule does not know about).
    const lead = (rig.s.engine.stats().startLead ?? 0.05) * 1000;
    const onset = play.samples.map((x) => x.transit - lead - rig.s.engine.graphLatency() * 1000);
    console.log(row(`${tag} play   onset after its time (lead ${lead.toFixed(0)} ms)`, onset));
    expect(play.samples.length).toBeGreaterThan(N / 2);
    expect(summarize(play.samples.map((x) => x.total)).median).toBeLessThan(perfLimit(160, 500));
    expect(summarize(onset).median).toBeLessThan(perfLimit(3, 20));
    expect(summarize(onset).p95).toBeLessThan(perfLimit(10, 40));
  });

  it('knob: a plugin parameter and a channel volume', { tags: ['perf'], timeout: 300_000 }, async () => {
    const rig = await boot(buffer, heavy);
    const { s } = rig;
    // A held note of the tone, silent through its level knob / volume until the knob moves.
    rig.startNote(false);
    s.history.transact('Long note', (d) =>
      addNote(d, rig.pattern, rig.channel, { id: newId.note(), tick: 0, length: 3840 * 4, key: 60, velocity: 1 }),
    );
    for (const kind of ['plugin', 'volume'] as const) {
      const set = (v: number) =>
        s.history.transact('Knob', (d) => {
          if (kind === 'plugin') setPluginParam(d, { kind: 'channel', channelId: rig.channel }, 'level', v);
          else setChannelProp(d, rig.channel, 'volume', v);
        });
      set(0);
      s.engine.play(0);
      await sleep(300);
      const out = await repeat(N, async () => {
        set(0);
        await sleep(120);
        return measure(rig.probe, rig.ctx, {
          fire(mark) {
            const t0 = performance.now();
            mark();
            set(1);
            return t0;
          },
        });
      });
      report(`${tag} knob ${kind}`, out);
      expect(out.samples.length).toBeGreaterThan(N / 2);
    }
    s.engine.stop();
  });

  it('edit while playing: how soon a new note is heard', { tags: ['perf'], timeout: 600_000 }, async () => {
    const rig = await boot(buffer, heavy);
    const { s, ctx } = rig;
    const inner = innerEngine(s.engine);
    rig.startNote(false);
    const look = Number(import.meta.env?.VITE_LOOKAHEAD);
    if (look > 0) (inner as unknown as { transport: { lookahead: number } }).transport.lookahead = look;
    // The pattern the tone's notes are in, in ticks (the heavy song's clips repeat the 4-bar pattern).
    const patternTicks = heavy ? 4 * 3840 : 3840;
    s.engine.play(0);
    await sleep(600);
    const leads = STRICT_PERF ? [0, 5, 10, 15, 20, 30, 50, 100] : [10, 50];
    const per = STRICT_PERF ? 15 : 4;
    let minLead = Infinity;
    for (const lead of leads) {
      const late: number[] = [];
      let missed = 0;
      for (let i = -1; i < per; i++) {
        // Not just before the loop wraps.
        let tick: number;
        let target: number;
        for (;;) {
          target = ctx.currentTime + lead / 1000;
          tick = Math.ceil(inner.tickAt(target + inner.graphLatency()).tick) % patternTicks;
          if (tick < patternTicks - 1500 && tick > 200) break;
          await sleep(20);
        }
        rig.probe.arm();
        await sleep(1);
        rig.probe.arm();
        const id = newId.note();
        s.history.transact('Add note', (d) =>
          addNote(d, rig.pattern, rig.channel, { id, tick, length: 60, key: 60, velocity: 1 }),
        );
        const frame = await rig.probe.hit(300);
        s.history.transact('Remove note', (d) => removeNote(d, rig.pattern, rig.channel, id));
        if (i < 0) {
          await sleep(100);
          continue;
        }
        if (frame === null) missed++;
        else late.push((frame / ctx.sampleRate - (target + inner.graphLatency())) * 1000);
        await sleep(120 + ((i * 11) % 17));
      }
      const onTime = late.filter((x) => x < 4).length;
      const sum = late.length ? summarize(late) : null;
      console.log(
        `LAT | ${tag} edit lead ${String(lead).padStart(3)} ms: on time ${String(onTime).padStart(2)}/${per}, missed ${missed}` +
          (sum ? `, lateness median ${sum.median.toFixed(1)} p95 ${sum.p95.toFixed(1)} ms` : ''),
      );
      if (onTime >= per * 0.9) minLead = Math.min(minLead, lead);
    }
    console.log(`LAT | ${tag} edit: earliest lead that is heard on time: ${minLead} ms (lookahead ${(s.engine.stats().lookahead * 1000).toFixed(0)} ms, late events ${s.engine.stats().lateEvents})`);
    s.engine.stop();
    expect(minLead).toBeLessThan(perfLimit(60, 120));
  });
});

describe('the heard time', () => {
  it('is read from the output clock once per frame, so every reader of a frame sees the same time', async () => {
    const rig = await boot('small', false);
    rig.startNote(true);
    rig.s.engine.play(0);
    await sleep(200);
    const ctx = rig.ctx;
    let reads = 0;
    const orig = ctx.getOutputTimestamp.bind(ctx);
    ctx.getOutputTimestamp = () => (reads++, orig());
    // Six readers in one frame (playhead, step lights, automation, tempo...): one clock read, one answer.
    const heard = Array.from({ length: 6 }, () => rig.s.engine.playhead());
    expect(new Set(heard).size).toBe(1);
    expect(reads).toBeLessThanOrEqual(1);
    // A frame later it moves on.
    let later = heard[0];
    for (let i = 0; i < 50 && later === heard[0]; i++) {
      await sleep(20);
      later = rig.s.engine.playhead();
    }
    expect(later).not.toBe(heard[0]);
    ctx.getOutputTimestamp = orig;
    rig.s.engine.stop();
  });
});
