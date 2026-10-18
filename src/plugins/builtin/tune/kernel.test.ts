import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SCALES } from '@agstudio/sdk/notes';
import { Yin } from '@agstudio/sdk/worklet';
import { paramBlock, runEffect, testHost, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { nearestNote, TuneKernel } from './kernel';
import source from './kernel.ts?raw';
import { TUNE_SCALES, tuneLatencyFrames, tuneParams } from './params';

const SR = 48000;
const D = tuneLatencyFrames(SR);
type Params = TestParams<typeof tuneParams>;
const sine =
  (freq: number, amp = 0.4) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * freq * i) / SR);
const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

/** Median pitch of a signal over [from, to), by YIN every 5 ms. */
function pitchOf(x: Float32Array, from: number, to: number): number {
  const yin = new Yin(SR, { minHz: 80, maxHz: 1000 });
  const found: number[] = [];
  for (let i = 0; i < to; i++) {
    yin.push(x[i] as number);
    if (i >= from && i % 240 === 0 && yin.detect() > 0) found.push(yin.frequency);
  }
  found.sort((a, b) => a - b);
  return found[Math.floor(found.length / 2)] ?? 0;
}

const tune = (x: TestSignal, params: Params, seconds = 1) =>
  runEffect(TuneKernel, tuneParams, x, Math.round(seconds * SR), { params })[0];

describe('TuneKernel', () => {
  it('its scales are the SDK’s SCALES (ids, labels, intervals, order)', () => {
    expect(TUNE_SCALES.map((s) => s.id)).toEqual(SCALES.map((s) => s.id));
    expect(TUNE_SCALES.map((s) => s.label)).toEqual(SCALES.map((s) => s.label));
    expect(TUNE_SCALES.map((s) => [...s.intervals])).toEqual(SCALES.map((s) => [...s.intervals]));
    expect(tuneParams.scale.options).toEqual(SCALES.map((s) => s.id));
  });

  it('snaps a slightly sharp A to 440 Hz (chromatic, instant)', () => {
    const out = tune(sine(446), { key: 'A', scale: 'chromatic', speed: 0 });
    expect(Math.abs(cents(pitchOf(out, SR / 2, SR), 440))).toBeLessThan(3);
  });

  it('a slow retune speed gets there later', () => {
    const fast = tune(sine(446), { scale: 'chromatic', speed: 0 }, 0.3);
    const slow = tune(sine(446), { scale: 'chromatic', speed: 300 }, 0.3);
    const early = (x: Float32Array) => Math.abs(cents(pitchOf(x, 0.15 * SR, 0.3 * SR), 440));
    expect(early(fast)).toBeLessThan(5);
    expect(early(slow)).toBeGreaterThan(8);
  });

  it('pulls to the key’s scale: in C major a sharp C# goes to D', () => {
    expect(nearestNote(61.1, 0, 0b101010110101, -1)).toBe(62);
    expect(nearestNote(61.4, 0, 0b101010110101, -1)).toBe(62);
    // Hysteresis: a note held near the middle doesn't flip.
    expect(nearestNote(61.05, 0, 0b101010110101, 60)).toBe(60);
    const out = tune(sine(277.18 * Math.pow(2, 10 / 1200)), { key: 'C', scale: 'major', speed: 0 });
    expect(Math.abs(cents(pitchOf(out, SR / 2, SR), 293.66))).toBeLessThan(3);
    // Splices line up with the waveform: the level stays steady (no dips while shifting).
    const levels: number[] = [];
    for (let from = SR / 2; from + 480 <= SR; from += 480) {
      let sum = 0;
      for (let i = from; i < from + 480; i++) sum += (out[i] as number) ** 2;
      levels.push(10 * Math.log10(sum / 480));
    }
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1);
  });

  it('mix 0 is the input, delayed by the reported latency', () => {
    const x = sine(300);
    const out = tune(x, { mix: 0 }, 0.2);
    for (let i = D; i < out.length; i += 7) expect(out[i]).toBeCloseTo(x(i - D), 6);
  });

  it('in tune (or unpitched) it passes the input through, delayed; noise never blows up', () => {
    const x = sine(440);
    const out = tune(x, { key: 'A', scale: 'chromatic', speed: 50 }, 1);
    let worst = 0;
    for (let i = SR / 2; i < SR; i++) worst = Math.max(worst, Math.abs((out[i] as number) - x(i - D)));
    expect(worst).toBeLessThan(0.01);
    let s = 5;
    const noise: TestSignal = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2147483648 - 1;
    };
    const n = tune(noise, { speed: 0 }, 1);
    expect(n.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(n, Math.abs))).toBeLessThan(2.5);
  });
});

/** Pitch of a signal every 5 ms over [from, to) as cents from `ref` Hz (frames without a clear pitch are skipped). */
function pitchTrack(x: Float32Array, from: number, to: number, ref: number): number[] {
  const yin = new Yin(SR, { minHz: 80, maxHz: 1000 });
  const out: number[] = [];
  for (let i = 0; i < to; i++) {
    yin.push(x[i] as number);
    if (i >= from && i % 240 === 0 && yin.detect() > 0) out.push(cents(yin.frequency, ref));
  }
  return out;
}

/** A voice: harmonics under a fixed formant envelope (900 Hz, 260 Hz wide), at a pitch that may move. */
function voice(hzAt: (t: number) => number, amp = 0.3): TestSignal {
  let phase = 0;
  let last = -1;
  let hz = 0;
  return (frame) => {
    // The signal is asked once per frame and channel: advance on the first.
    if (frame !== last) {
      last = frame;
      hz = hzAt(frame / SR);
      phase += (2 * Math.PI * hz) / SR;
    }
    let v = 0;
    for (let k = 1; k * hz < 5000; k++) {
      const f = k * hz;
      v += (1 / (1 + ((f - 900) / 130) ** 2) + 0.02) * Math.cos(k * phase) / k;
    }
    return amp * 0.5 * v;
  };
}

/** A harmonic tone (1/k rolloff, no formant) whose pitch may move: a clean target for the pitch tracker. */
function tone(hzAt: (t: number) => number, amp = 0.3): TestSignal {
  let phase = 0;
  let last = -1;
  let hz = 0;
  return (frame) => {
    if (frame !== last) {
      last = frame;
      hz = hzAt(frame / SR);
      phase += (2 * Math.PI * hz) / SR;
    }
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.cos(k * phase) / k;
    return amp * 0.5 * v;
  };
}

/** Where the harmonics' energy sits between 400 and 2000 Hz (a stand-in for the formant), Hz. */
function centroid(x: Float32Array, f0: number, from: number, to: number): number {
  let num = 0;
  let den = 0;
  for (let k = 1; k * f0 < 2000; k++) {
    const f = k * f0;
    if (f < 400) continue;
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from - 1));
      re += w * (x[i] as number) * Math.cos((2 * Math.PI * f * i) / SR);
      im += w * (x[i] as number) * Math.sin((2 * Math.PI * f * i) / SR);
    }
    const a2 = re * re + im * im;
    num += a2 * f;
    den += a2;
  }
  return num / den;
}

describe('TuneKernel: guide notes', () => {
  it('pulls to the held note; a chord gives the nearest of its notes; no note held leaves the voice as it is', () => {
    const held = (...keys: number[]) => keys.map((key) => ({ frame: 0, key }));
    const one = runEffect(TuneKernel, tuneParams, sine(446), SR, { params: { source: 'notes', speed: 0 }, notes: held(69) })[0];
    expect(Math.abs(cents(pitchOf(one, SR / 2, SR), 440))).toBeLessThan(3);
    // 335 Hz sits between E4 (329.6) and A4 (440): the nearest is E4.
    const chord = runEffect(TuneKernel, tuneParams, sine(335), SR, { params: { source: 'notes', speed: 0 }, notes: held(64, 69, 72) })[0];
    expect(Math.abs(cents(pitchOf(chord, SR / 2, SR), 329.63))).toBeLessThan(3);
    // Nothing held: the input, delayed (a note that ends lets go at its note off).
    const x = sine(446);
    const none = runEffect(TuneKernel, tuneParams, x, SR, { params: { source: 'notes', speed: 0 } })[0];
    let worst = 0;
    for (let i = SR / 2; i < SR; i++) worst = Math.max(worst, Math.abs((none[i] as number) - x(i - D)));
    expect(worst).toBeLessThan(0.01);
    const ends = runEffect(TuneKernel, tuneParams, x, 5 * SR, {
      params: { source: 'notes', speed: 0 },
      notes: [{ frame: 0, key: 69 }, { frame: SR / 2, key: 69, off: true }],
    })[0];
    // (The read head drifts back to its resting delay slowly after a correction: look at the last stretch.)
    let after = 0;
    for (let i = Math.round(4.4 * SR); i < 5 * SR; i++) after = Math.max(after, Math.abs((ends[i] as number) - x(i - D)));
    expect(after).toBeLessThan(0.01);
  });

  it('the scale target still works when the guide channel is set (Target = scale ignores notes)', () => {
    const out = runEffect(TuneKernel, tuneParams, sine(446), SR, {
      params: { source: 'scale', key: 'A', scale: 'chromatic', speed: 0 },
      notes: [{ frame: 0, key: 72 }],
    })[0];
    expect(Math.abs(cents(pitchOf(out, SR / 2, SR), 440))).toBeLessThan(3);
  });
});

describe('TuneKernel: feel', () => {
  it('keep natural drift leaves a slow wander in the note; 0 % straightens it', () => {
    // A slow glide 0 → +30 cents over 2 s around A4.
    const drifting = tone((t) => 440 * Math.pow(2, (30 * Math.min(1, t / 2)) / 1200));
    const run = (humanize: number) => runEffect(TuneKernel, tuneParams, drifting, 2 * SR, { params: { key: 'A', scale: 'chromatic', speed: 20, humanize } })[0];
    const flat = pitchTrack(run(0), Math.round(1.7 * SR), 2 * SR, 440);
    const kept = pitchTrack(run(1), Math.round(1.7 * SR), 2 * SR, 440);
    const median = (v: number[]) => v.slice().sort((a, b) => a - b)[v.length >> 1] as number;
    expect(Math.abs(median(flat))).toBeLessThan(4);
    expect(median(kept)).toBeGreaterThan(8);
    expect(median(kept)).toBeLessThan(30);
  });

  it('added vibrato swings the pitch by its depth at its rate, after a short fade-in', () => {
    const steady = tone(() => 440);
    const out = runEffect(TuneKernel, tuneParams, steady, 2 * SR, { params: { key: 'A', scale: 'chromatic', speed: 0, vibratoDepth: 40, vibratoRate: 5.5 } })[0];
    const track = pitchTrack(out, Math.round(1.0 * SR), 2 * SR, 440);
    expect(Math.max(...track)).toBeGreaterThan(25);
    expect(Math.min(...track)).toBeLessThan(-25);
    expect(Math.max(...track)).toBeLessThan(60);
    // Zero depth adds nothing.
    const plain = pitchTrack(runEffect(TuneKernel, tuneParams, steady, 2 * SR, { params: { key: 'A', scale: 'chromatic', speed: 0 } })[0], Math.round(1.0 * SR), 2 * SR, 440);
    expect(Math.max(...plain.map(Math.abs))).toBeLessThan(8);
  });
});

describe('TuneKernel: keep formants', () => {
  it('moves the voice’s pitch without carrying its formant along (+5 semitones)', () => {
    const f0 = 196;
    const x = voice(() => f0, 0.3);
    const notes = [{ frame: 0, key: 60 }]; // C4 = 261.6 Hz: about +500 cents from G3
    const common = { source: 'notes' as const, speed: 0 };
    const off = runEffect(TuneKernel, tuneParams, x, 2 * SR, { params: { ...common, formant: false }, notes })[0];
    const on = runEffect(TuneKernel, tuneParams, x, 2 * SR, { params: { ...common, formant: true }, notes })[0];
    const hz = 261.63;
    const from = Math.round(1.0 * SR);
    const to = Math.round(1.8 * SR);
    // Both land on the note.
    expect(Math.abs(cents(pitchOf(off, from, to), hz))).toBeLessThan(6);
    expect(Math.abs(cents(pitchOf(on, from, to), hz))).toBeLessThan(6);
    const original = centroid(Float32Array.from({ length: 2 * SR }, (_, i) => x(i, 0)), f0, from, to);
    const resampled = centroid(off, hz, from, to);
    const kept = centroid(on, hz, from, to);
    // A plain shift carries the envelope up with the pitch; keeping formants leaves it near where it was.
    expect(resampled / original).toBeGreaterThan(1.12);
    expect(Math.abs(kept / original - 1)).toBeLessThan(0.08);
    expect(on.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(on, Math.abs))).toBeLessThan(1.5);
  });

  it('keeps the level steady and is a plain delay when nothing needs correcting', () => {
    const x = voice(() => 220, 0.3);
    const out = runEffect(TuneKernel, tuneParams, x, SR, { params: { key: 'A', scale: 'chromatic', speed: 50, formant: true } })[0];
    // 220 Hz is in tune with chromatic A: the output is the input at a delay within half a period of the latency.
    const levels: number[] = [];
    for (let from = SR / 2; from + 480 <= SR; from += 480) {
      let sum = 0;
      for (let i = from; i < from + 480; i++) sum += (out[i] as number) ** 2;
      levels.push(10 * Math.log10(sum / 480));
    }
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1);
  });
});

describe('TuneKernel: the return to rest after a correction ends', () => {
  /**
   * A note 23 cents sharp for 2.5 s (pulled to the chromatic note below it), then, after `gap` seconds of silence or
   * noise, the exact note: seconds from the end of the correction until the read head is back at its centre (the
   * output is the delayed input again), and the largest sample step of the output against the input's own.
   */
  function rest(hz: number, opts: { gap?: number; noise?: boolean } = {}): { seconds: number; step: number; inputStep: number } {
    const gap = opts.gap ?? 0;
    const sharp = hz * Math.pow(2, 23 / 1200);
    const t1 = 2.5;
    const t2 = t1 + gap;
    const frames = Math.round(8 * SR);
    // The input is made once (the voice keeps phase state), then replayed.
    const base = tone((t) => (t < t2 ? sharp : hz), 1);
    const voiceNow: TestSignal = (frame, ch) => ((frame / SR >= t1 && frame / SR < t2 ? 0 : 0.3) * base(frame, ch)) / 0.5 * 0.5;
    let s = 11;
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / SR;
      if (t >= t1 && t < t2 && opts.noise) {
        s = (s * 1664525 + 1013904223) >>> 0;
        samples[i] = 0.05 * (s / 2147483648 - 1);
        voiceNow(i, 0);
      } else samples[i] = voiceNow(i, 0);
    }
    const params = { key: 'C', scale: 'chromatic', speed: 20 } as const;
    const out = runEffect(TuneKernel, tuneParams, (i) => samples[i] as number, frames, { params })[0];
    // A second copy follows the same path (the kernel is deterministic): read where its head is, block by block.
    const probe = new TuneKernel(testHost(SR));
    const pb = paramBlock(tuneParams, params);
    const block = 128;
    const inp = [new Float32Array(block), new Float32Array(block)];
    const o = [new Float32Array(block), new Float32Array(block)];
    let back = Number.NaN;
    for (let at = 0; at < frames; at += block) {
      for (let i = 0; i < block; i++) {
        (inp[0] as Float32Array)[i] = samples[at + i] as number;
        (inp[1] as Float32Array)[i] = samples[at + i] as number;
      }
      probe.process(inp, o, block, pb);
      const t = (at + block) / SR;
      if (t > t2 + 0.05 && Number.isNaN(back) && Math.abs(probe.headOffset) < 0.75) back = t - t2;
    }
    let step = 0;
    let inputStep = 0;
    // (From 0.1 s: the signal itself starts with a step at 0.)
    for (let i = Math.round(0.1 * SR); i < frames; i++) {
      step = Math.max(step, Math.abs((out[i] as number) - (out[i - 1] as number)));
      inputStep = Math.max(inputStep, Math.abs((samples[i] as number) - (samples[i - 1] as number)));
    }
    return { seconds: back, step, inputStep };
  }

  it('after a gap the head is back at its centre within 0.2 s of the next note (it took 1.1-2.5 s)', () => {
    for (const hz of [110, 164.81, 220, 261.63]) {
      const r = rest(hz, { gap: 0.4 });
      expect(r.seconds, `${hz} Hz`).toBeLessThan(0.2);
    }
  });

  it('with the voice still sounding it jumps whole periods, then drifts the rest: well under the old 1.5-2.9 s', () => {
    for (const [hz, limit] of [
      [110, 1.4],
      [164.81, 1.2],
      [220, 0.7],
      [261.63, 0.4],
    ] as const) {
      const r = rest(hz);
      expect(r.seconds, `${hz} Hz`).toBeLessThan(limit);
    }
  });

  it('makes no click: no sample step beyond the voice’s own, also across noise between notes', () => {
    for (const opts of [{}, { gap: 0.4 }, { gap: 0.4, noise: true }]) {
      const r = rest(220, opts);
      expect(r.step, JSON.stringify(opts)).toBeLessThan(r.inputStep * 1.2);
    }
  });

  it('a glide that passes a note for a moment does not send the head home: the correction goes on', () => {
    // The pitch slides up through A (440 Hz) in 0.3 s: the correction is under a cent only briefly, never for 30 ms.
    const sweep = tone((t) => 415.3 * Math.pow(2, (Math.min(t, 0.3) / 0.3) * (100 / 1200)));
    const k = new TuneKernel(testHost(SR));
    const pb = paramBlock(tuneParams, { key: 'A', scale: 'chromatic', speed: 0 });
    const block = 128;
    const inp = [new Float32Array(block), new Float32Array(block)];
    const o = [new Float32Array(block), new Float32Array(block)];
    let moved = 0;
    for (let at = 0; at < Math.round(0.5 * SR); at += block) {
      for (let i = 0; i < block; i++) {
        const v = sweep(at + i, 0);
        (inp[0] as Float32Array)[i] = v;
        (inp[1] as Float32Array)[i] = v;
      }
      k.process(inp, o, block, pb);
      moved = Math.max(moved, Math.abs(k.headOffset));
    }
    // The head really moved (it was correcting), and nothing broke.
    expect(moved).toBeGreaterThan(0.5);
  });
});

describe('TuneKernel: audio-thread rules', () => {
  /** The body of a method of the kernel, comments removed. */
  function body(name: string): string {
    const start = new RegExp(`^  (?:override |private )*${name}\\(`, 'm').exec(source);
    expect(start, `method ${name} exists`).not.toBeNull();
    const from = (start as RegExpExecArray).index;
    const end = source.indexOf('\n  }\n', from);
    return source
      .slice(from, end + 4)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it('the audio-thread methods allocate nothing: no new, literals, closures, spreads, copies or strings', () => {
    const forbidden: [string, RegExp][] = [
      ['new', /\bnew\s/],
      ['array literal', /(^|[=(,:?]\s*)\[/m],
      ['object literal', /(=|\(|,|return)\s*\{/],
      ['closure', /=>|\bfunction\b/],
      ['spread', /\.\.\./],
      ['template string', /`/],
      ['copying call', /\.(map|filter|slice|concat|forEach|reduce|splice|from)\(/],
    ];
    for (const method of ['process', 'grains', 'retarget', 'nearestHeld', 'noteOn', 'noteOff', 'allNotesOff', 'startSplice', 'rest', 'stopGrains']) {
      const text = body(method);
      for (const [what, re] of forbidden) expect(re.test(text), `${method}() has a ${what}`).toBe(false);
    }
  });

  it('keeps nothing between blocks that grows: the heap is the same after a long run (all features on)', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const x = tone((t) => 220 * Math.pow(2, (25 * Math.sin(t * 3)) / 1200));
    const cases: Array<[string, Params, boolean]> = [
      ['default', {}, false],
      ['notes', { source: 'notes', speed: 10 }, true],
      ['feel', { humanize: 0.7, vibratoDepth: 30, speed: 30 }, false],
      ['formant', { formant: true, key: 'D', scale: 'major', speed: 5 }, false],
    ];
    const block = 128;
    const inL = Float32Array.from({ length: block * 4 }, (_, i) => x(i, 0));
    const inputs = [0, 1, 2, 3].map((b) => [inL.subarray(b * block, (b + 1) * block), inL.subarray(b * block, (b + 1) * block)]);
    const outputs = [new Float32Array(block), new Float32Array(block)];
    for (const [name, params, notes] of cases) {
      const kernel = new TuneKernel(testHost(SR));
      const pb = paramBlock(tuneParams, params);
      if (notes) kernel.noteOn(62, 0.8, 1);
      const run = (blocks: number) => {
        for (let b = 0; b < blocks; b++) {
          kernel.process(inputs[b & 3] as Float32Array[], outputs, block, pb);
          if (notes && b % 500 === 0) {
            kernel.noteOff(1);
            kernel.noteOn(62, 0.8, 1);
          }
        }
      };
      run(2000);
      gc();
      const before = process.memoryUsage().heapUsed;
      run(30000);
      gc();
      const kept = process.memoryUsage().heapUsed - before;
      expect(kept, `${name}: heap kept after 30000 blocks`).toBeLessThan(150_000);
    }
  });
});
