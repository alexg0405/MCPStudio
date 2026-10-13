import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { ChannelId, NoteId, PatternId } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import { HostImpl } from '@engine/host';
import { ParamRegistry } from '@engine/param-lane';
import { renderOffline } from '@engine/render-offline';
import { SampleCache } from '@engine/samples';
import { defaultValues, mtof, type InstrumentInstance, type ParamValue, type PluginDef } from '@agstudio/sdk';
import bass808 from '../../src/plugins/builtin/bass808';
import { MonoBass } from '../../src/plugins/builtin/bass808/mono';
import { resolver } from '../helpers/fixtures';

const SR = 48000;
const BPM = 120;
/** Seconds per tick at 120 BPM. */
const TICK = 60 / BPM / 960;
/** renderOffline's default pre-roll and the master limiter's look-ahead, in frames. */
const PRE_ROLL = 2048;
const LIMITER_DELAY = Math.round(0.0013 * SR);
const C1 = 24;
const C2 = 36;
const G2 = 43;

interface Note {
  /** Seconds from the start of the pattern. */
  at: number;
  len: number;
  key: number;
  velocity?: number;
}

type Params = Record<string, ParamValue>;

/** Quiet defaults for measurements: no click, little drive, below the limiter. */
const MEASURE: Params = { click: 0, drive: 0, level: -6 };

function project808(notes: Note[], params: Params) {
  let project = createEmptyProject();
  const patternId = project.patternOrder[0] as PatternId;
  const values = { ...defaultValues(bass808.params), ...params };
  const ch = makeInstrumentChannel('808', makePluginInstance(bass808.id, bass808.version, values));
  project = produce(project, (d) => {
    d.transport.bpm = BPM;
    addChannel(d, ch);
    notes.forEach((n, i) =>
      addNote(d, patternId, ch.id, {
        id: `n${i}` as NoteId,
        tick: Math.round(n.at / TICK),
        length: Math.round(n.len / TICK),
        key: n.key,
        velocity: n.velocity ?? 1,
      }),
    );
  });
  return { project, patternId };
}

/** Renders one bar (2 s) plus a second of tail; returns the left channel. */
async function render(notes: Note[], params: Params = {}, chunk?: number): Promise<Float32Array> {
  const { project, patternId } = project808(notes, { ...MEASURE, ...params });
  const { buffer } = await renderOffline(project, {
    plugins: resolver(),
    view: { mode: 'pattern', patternId, loop: null },
    bars: 1,
    sampleRate: SR,
    ...(chunk ? { chunk } : {}),
  });
  return buffer.getChannelData(0);
}

/** Output frame of a note time (the 808 compensates its own shaper latency). */
const frame = (t: number) => Math.round(PRE_ROLL + t * SR) + LIMITER_DELAY;

/** Zero crossings (fractional frames) in [t0, t1); `up` keeps only upward ones. */
function crossings(d: Float32Array, t0: number, t1: number, up = true): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, frame(t0)); i < frame(t1); i++) {
    const a = d[i - 1] as number;
    const b = d[i] as number;
    if ((a < 0 && b >= 0) || (!up && a > 0 && b <= 0)) out.push(i - 1 + a / (a - b));
  }
  return out;
}

/** Mean frequency over [t0, t1) from upward zero crossings. */
function freq(d: Float32Array, t0: number, t1: number): number {
  const c = crossings(d, t0, t1);
  if (c.length < 2) return 0;
  return ((c.length - 1) * SR) / ((c[c.length - 1] as number) - (c[0] as number));
}

function rmsOf(d: Float32Array, t0: number, t1: number): number {
  let sum = 0;
  const a = frame(t0);
  const b = frame(t1);
  for (let i = a; i < b; i++) sum += (d[i] as number) ** 2;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/** Peak of each half cycle (between zero crossings) in [t0, t1). */
function halfCyclePeaks(d: Float32Array, t0: number, t1: number): number[] {
  const c = crossings(d, t0, t1, false);
  const out: number[] = [];
  for (let k = 1; k < c.length; k++) {
    let m = 0;
    for (let i = Math.ceil(c[k - 1] as number); i < (c[k] as number); i++) m = Math.max(m, Math.abs(d[i] as number));
    out.push(m);
  }
  return out;
}

/** Energy of the harmonics above 150 Hz relative to the fundamental (Hann-windowed DFT at each harmonic). */
function harmonicsAbove150(d: Float32Array, f0: number, t0: number, t1: number): number {
  const a = frame(t0);
  const n = frame(t1) - a;
  const power = (f: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const x = (d[a + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      const ph = (2 * Math.PI * f * i) / SR;
      re += x * Math.cos(ph);
      im -= x * Math.sin(ph);
    }
    return re * re + im * im;
  };
  let high = 0;
  for (let k = 2; k * f0 <= 4000; k++) if (k * f0 > 150) high += power(k * f0);
  return high / power(f0);
}

function expectFinite(d: Float32Array): void {
  for (let i = 0; i < d.length; i++) if (!Number.isFinite(d[i])) throw new Error(`sample ${i} is ${d[i]}`);
}

/**
 * Drives the instrument directly (real host, OfflineAudioContext): for event orders and
 * cancellations the scheduler doesn't produce from a static project. Times are context seconds.
 */
async function direct(play: (i: InstrumentInstance) => void, params: Params = {}, seconds = 1.5) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(seconds * SR), sampleRate: SR });
  const values = { ...defaultValues(bass808.params), ...MEASURE, ...params };
  const host = new HostImpl({
    ctx,
    def: bass808 as PluginDef,
    data: makePluginInstance(bass808.id, bass808.version, values),
    owner: { kind: 'channel', channelId: 'ch_test' as ChannelId },
    project: createEmptyProject(),
    samples: new SampleCache(),
    transport: { bpm: BPM, ppq: 960, tempoAt: () => BPM, onTempo: () => () => {} },
    rootKey: 60,
    offline: true,
    registry: new ParamRegistry(),
    requestState: () => {},
    loadModule: (url) => ctx.audioWorklet.addModule(url),
    ports: new Set(),
    reportFault: (err) => {
      throw err;
    },
  });
  const inst = await bass808.create(host as never);
  inst.output.connect(ctx.destination);
  play(inst);
  const buffer = await ctx.startRendering();
  inst.dispose();
  host.dispose();
  return buffer.getChannelData(0);
}

const on = (i: InstrumentInstance, noteId: number, time: number, key: number, velocity = 1) =>
  i.noteOn({ time, noteId, key, velocity });
const off = (i: InstrumentInstance, noteId: number, time: number) => i.noteOff({ time, noteId, key: 0 });

function peakOf(d: Float32Array): number {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i] as number));
  return m;
}

function diff(a: Float32Array, b: Float32Array): number {
  let m = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}

describe('808 Bass', () => {
  it('is discovered as a built-in instrument with presets', () => {
    const builtins = import.meta.glob<{ default: PluginDef }>('/src/plugins/builtin/*/index.ts', { eager: true });
    const def = Object.values(builtins)
      .map((m) => m.default)
      .find((d) => d.id === 'agstudio.bass808');
    expect(def?.kind).toBe('instrument');
    expect(def?.name).toBe('808 Bass');
    expect(def?.presets?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Classic 808', 'Long slide', 'Distorted', 'Short punchy', 'Sub only']),
    );
  });

  it('holds C2 in tune once the punch has settled, on the beat', async () => {
    const d = await render([{ at: 0, len: 1, key: C2 }]);
    expect(Math.abs(freq(d, 0.2, 0.4) / mtof(C2) - 1)).toBeLessThan(0.01);
    // The shaper's oversampling latency is compensated: the hit starts on its frame.
    let start = 0;
    while (Math.abs(d[start] as number) < 1e-3) start++;
    expect(Math.abs(start - frame(0))).toBeLessThanOrEqual(48);
  });

  it('punches: the pitch in the first 10 ms is clearly higher than the settled one', async () => {
    // The sine starts at zero phase on the note, so the first downward crossing ends its first
    // half cycle (within the first 10 ms when punched) and the next upward one its first cycle.
    const early = (d: Float32Array) => {
      const half = (crossings(d, 0.001, 0.03, false)[0] as number) - frame(0);
      const full = (crossings(d, 0.001, 0.03)[0] as number) - frame(0);
      return { half: SR / (2 * half), full: SR / full, halfMs: (1000 * half) / SR };
    };
    const punched = await render([{ at: 0, len: 1, key: C2 }]);
    const flat = await render([{ at: 0, len: 1, key: C2 }], { punch: 0 });
    const settled = freq(punched, 0.2, 0.4);
    const p = early(punched);
    expect(p.halfMs).toBeLessThan(10);
    expect(p.half / settled).toBeGreaterThan(1.5);
    expect(p.full / settled).toBeGreaterThan(1.25);
    const f = early(flat);
    expect(Math.abs(f.half / settled - 1)).toBeLessThan(0.03);
    expect(Math.abs(f.full / settled - 1)).toBeLessThan(0.03);
  });

  it('decays while held', async () => {
    const d = await render([{ at: 0, len: 1.9, key: C2 }], { decay: 0.5 });
    const early = rmsOf(d, 0.05, 0.15);
    expect(early).toBeGreaterThan(0.05);
    expect(rmsOf(d, 0.5, 0.6)).toBeLessThan(early * 0.2);
    expect(rmsOf(d, 1.0, 1.1)).toBeLessThan(early * 0.01);
  });

  it('glides between overlapping notes without a new attack', async () => {
    // C2 0–0.5 s, G2 0.25–0.75 s: G2 starts while C2 is held.
    const notes = [
      { at: 0, len: 0.5, key: C2 },
      { at: 0.25, len: 0.5, key: G2 },
    ];
    const d = await render(notes, { decay: 8, glide: 0.08 });
    expect(Math.abs(freq(d, 0.12, 0.24) / mtof(C2) - 1)).toBeLessThan(0.01);
    // After the glide time the pitch is G2.
    expect(Math.abs(freq(d, 0.25 + 0.08 + 0.01, 0.48) / mtof(G2) - 1)).toBeLessThan(0.02);
    // The slide starts from C2: no punch (a retrigger would start an octave above G2).
    const sliding = freq(d, 0.25, 0.29);
    expect(sliding).toBeGreaterThan(mtof(C2) * 0.98);
    expect(sliding).toBeLessThan(mtof(G2));
    // No gap: every half cycle around the transition stays near the level before it.
    const before = Math.max(...halfCyclePeaks(d, 0.15, 0.24));
    expect(Math.min(...halfCyclePeaks(d, 0.2, 0.45))).toBeGreaterThan(0.7 * before);
    // C2's note-off at 0.5 s doesn't cut the sound; G2's at 0.75 s does.
    expect(rmsOf(d, 0.5, 0.6) / rmsOf(d, 0.4, 0.5)).toBeGreaterThan(0.8);
    expect(rmsOf(d, 0.8, 0.9)).toBeLessThan(0.01 * rmsOf(d, 0.6, 0.7));
  });

  it('retriggers notes that do not overlap, with a punch at each start', async () => {
    // Touching (the second starts as the first ends), then after a gap. A big, slow punch is easy
    // to see even while the previous hit's tail is fading out.
    const notes = [
      { at: 0, len: 0.25, key: C2 },
      { at: 0.25, len: 0.25, key: C2 },
      { at: 0.75, len: 0.25, key: C2 },
    ];
    const d = await render(notes, { punch: 24, punchTime: 100, decay: 2 });
    for (const s of [0, 0.25, 0.75]) expect(freq(d, s + 0.012, s + 0.04)).toBeGreaterThan(1.4 * mtof(C2));
    // The same notes overlapping by 10 ms slide instead: no punch on the second.
    const legato = await render(
      [
        { at: 0, len: 0.26, key: C2 },
        { at: 0.25, len: 0.25, key: C2 },
      ],
      { punch: 24, punchTime: 100, decay: 2 },
    );
    expect(Math.abs(freq(legato, 0.25 + 0.012, 0.25 + 0.04) / mtof(C2) - 1)).toBeLessThan(0.02);
  });

  it('scales the level with velocity and transposes with tune', async () => {
    const loud = await render([{ at: 0, len: 1, key: C2, velocity: 1 }]);
    const soft = await render([{ at: 0, len: 1, key: C2, velocity: 0.5 }]);
    expect(rmsOf(soft, 0.1, 0.5) / rmsOf(loud, 0.1, 0.5)).toBeCloseTo(0.5, 1);
    const up = await render([{ at: 0, len: 1, key: C2 }], { tune: 12 });
    expect(Math.abs(freq(up, 0.2, 0.4) / (2 * mtof(C2)) - 1)).toBeLessThan(0.01);
  });

  it('adds harmonics with drive', async () => {
    for (const key of [C1, C2]) {
      const energy: number[] = [];
      for (const drive of [0, 0.5, 0.75, 1]) {
        const d = await render([{ at: 0, len: 1, key }], { drive, tone: 8000 });
        energy.push(harmonicsAbove150(d, mtof(key), 0.15, 0.45));
      }
      // Clean at 0, then more harmonic energy above 150 Hz with every step.
      expect(energy[0]).toBeLessThan(1e-6);
      for (let i = 1; i < energy.length; i++) expect(energy[i]).toBeGreaterThan(2 * (energy[i - 1] as number));
      expect(energy[3]).toBeGreaterThan(0.05);
    }
  });

  it('renders finite output, identically twice and whatever the render chunk', async () => {
    // Glides, a chain, touching notes, a gap and a velocity change, with the default sound.
    const notes = [
      { at: 0, len: 0.3, key: C2 },
      { at: 0.25, len: 0.25, key: G2, velocity: 0.7 },
      { at: 0.5, len: 0.25, key: C2 },
      { at: 0.7, len: 0.2, key: 31 },
      { at: 0.875, len: 0.125, key: 34 },
      { at: 1.25, len: 0.5, key: C2 },
      { at: 1.5, len: 0.1, key: 38 },
    ];
    const defaults = { click: 0.3, drive: 0.3, level: -3 };
    const a = await render(notes, defaults);
    const b = await render(notes, defaults);
    expectFinite(a);
    expect(peakOf(a)).toBeGreaterThan(0.05);
    expect(diff(a, b)).toBeLessThan(1e-6);
    // Smaller chunks deliver note-offs before later note-ons (and compute note times with
    // different rounding); the result must not depend on it.
    for (const chunk of [128 * 16, 128 * 37]) expect(diff(a, await render(notes, defaults, chunk))).toBeLessThan(1e-6);
  });

  it('renders every preset', async () => {
    for (const preset of bass808.presets ?? []) {
      const { project, patternId } = project808(
        [
          { at: 0, len: 0.4, key: C2 },
          { at: 0.3, len: 0.4, key: G2 },
          { at: 1, len: 0.5, key: C1 },
        ],
        preset.params ?? {},
      );
      const { buffer } = await renderOffline(project, {
        plugins: resolver(),
        view: { mode: 'pattern', patternId, loop: null },
        bars: 1,
        sampleRate: SR,
      });
      const d = buffer.getChannelData(0);
      expectFinite(d);
      expect(peakOf(d), preset.name).toBeGreaterThan(0.05);
    }
  });
});

describe('808 Bass events', () => {
  it('a note-off at or before its note-on cancels the note', async () => {
    for (const t of [0.2, 0.1]) {
      const d = await direct((i) => {
        on(i, 1, 0.2, C2);
        off(i, 1, t);
      });
      expect(peakOf(d)).toBe(0);
    }
  });

  it('cancelling a glide target leaves the note it would have slid from', async () => {
    const alone = await direct((i) => {
      on(i, 1, 0.1, C2);
      off(i, 1, 0.6);
    });
    const cancelled = await direct((i) => {
      on(i, 1, 0.1, C2);
      on(i, 2, 0.35, G2);
      off(i, 1, 0.6);
      off(i, 2, 0.8);
      off(i, 2, 0.35);
    });
    expect(peakOf(alone)).toBeGreaterThan(0.05);
    expect(diff(cancelled, alone)).toBeLessThan(1e-5);
  });

  it('sounds the same whatever order the events arrive in', async () => {
    type Ev = [kind: 'on' | 'off', id: number, time: number, key: number];
    const events: Ev[] = [
      ['on', 1, 0.1, C2],
      ['off', 1, 0.3, 0],
      ['on', 2, 0.3, C2], // touches note 1: retrigger
      ['off', 2, 0.6, 0],
      ['on', 3, 0.5, G2], // overlaps note 2: glide
      ['off', 3, 0.8, 0],
      ['on', 4, 0.75, 31], // overlaps note 3: glide
      ['off', 4, 1.0, 0],
      ['on', 5, 1.1, C2], // after a gap: retrigger
      ['off', 5, 1.3, 0],
    ];
    const play = (evs: Ev[]) => (i: InstrumentInstance) => {
      for (const [kind, id, time, key] of evs) {
        if (kind === 'on') on(i, id, time, key);
        else off(i, id, time);
      }
    };
    const ordered = await direct(play(events));
    // The scheduler's order: every note-on of the window first, then the note-offs.
    const onsFirst = await direct(
      play([...events.filter((e) => e[0] === 'on'), ...events.filter((e) => e[0] === 'off')]),
    );
    // Note-ons in reverse (each note-off still after its own note-on).
    const reversed = await direct(
      play([...events.filter((e) => e[0] === 'on').reverse(), ...events.filter((e) => e[0] === 'off').reverse()]),
    );
    expect(peakOf(ordered)).toBeGreaterThan(0.05);
    expect(diff(onsFirst, ordered)).toBeLessThan(1e-5);
    expect(diff(reversed, ordered)).toBeLessThan(1e-5);
  });

  it('forgets finished notes and voices as playback goes on', async () => {
    // Like the scheduler: events for the next 100 ms delivered every 50 ms of rendering.
    const seconds = 8;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: seconds * SR, sampleRate: SR });
    const tuneNode = new ConstantSourceNode(ctx, { offset: 0 });
    tuneNode.start();
    const click = new AudioBuffer({ length: 1, numberOfChannels: 1, sampleRate: SR });
    const mono = new MonoBass({
      audioContext: ctx,
      destination: ctx.destination,
      tune: {
        node: tuneNode,
        connect(p) {
          tuneNode.connect(p);
          return () => tuneNode.disconnect(p);
        },
      },
      lead: 0,
      click,
      settings: () => ({ punch: 12, punchTau: 0.0075, decayTau: 0.4, click: 0.3, glide: 0.08 }),
    });
    // Eighth notes; every fourth one overlaps the next (a slide).
    const notes = Array.from({ length: 60 }, (_, n) => ({ at: 0.1 + n * 0.125, len: n % 4 === 3 ? 0.15 : 0.1 }));
    let maxNotes = 0;
    let maxVoices = 0;
    const step = 0.05;
    const pump = (from: number) => {
      notes.forEach((n, id) => {
        if (n.at >= from && n.at < from + step)
          mono.noteOn({ time: n.at, noteId: id, key: 36 + (id % 5), velocity: 1 });
        const end = n.at + n.len;
        if (end >= from && end < from + step) mono.noteOff({ time: end, noteId: id, key: 0 });
      });
      maxNotes = Math.max(maxNotes, mono.stats.notes);
      maxVoices = Math.max(maxVoices, mono.stats.voices);
    };
    pump(0);
    pump(step);
    // (An OfflineAudioContext can't suspend at 0, so the first two windows go in before rendering.)
    for (let t = 2 * step; t < seconds - 0.1; t += step) {
      const at = Math.round(((t - step) * SR) / 128) * 128;
      void ctx.suspend(at / SR).then(() => {
        pump(t);
        void ctx.resume();
      });
    }
    const d = (await ctx.startRendering()).getChannelData(0);
    expectFinite(d);
    expect(peakOf(d)).toBeGreaterThan(0.1);
    expect(maxNotes).toBeLessThanOrEqual(4);
    expect(maxVoices).toBeLessThanOrEqual(3);
    mono.dispose();
  });

  it('all notes off releases what is sounding and drops what is still to come', async () => {
    const d = await direct((i) => {
      on(i, 1, 0.1, C2);
      on(i, 2, 0.8, G2);
      i.allNotesOff(0.4);
    });
    // Driven directly: no pre-roll or limiter, so context time t is frame t · SR.
    const at = (s: number) => Math.round(s * SR);
    expect(peakOf(d.subarray(at(0.15), at(0.35)))).toBeGreaterThan(0.05);
    expect(peakOf(d.subarray(at(0.6), d.length))).toBeLessThan(1e-4);
  });
});
