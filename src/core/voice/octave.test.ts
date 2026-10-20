import { describe, expect, it } from 'vitest';
import { cpuNow, settle } from '../../../test/helpers/perf';
import { sing, type Formant } from '../../../test/helpers/sung';
import { hasSubharmonic, repairOctaveSlips } from './octave';
import { analyzePitch, type PitchNote } from './pitch-notes';
import { midiToHz } from './pitch';

const SR = 48000;

/** Synthetic voices whose first formant sits where the second harmonic of a note at 440 Hz or above lands. */
const VOICES: Record<string, readonly Formant[]> = {
  f900: [
    { hz: 900, bandwidth: 260, gain: 1 },
    { hz: 2400, bandwidth: 500, gain: 0.35 },
  ],
  f880: [
    { hz: 880, bandwidth: 200, gain: 1 },
    { hz: 2400, bandwidth: 500, gain: 0.35 },
  ],
  f1000: [{ hz: 1000, bandwidth: 300, gain: 1 }],
  f700: [
    { hz: 700, bandwidth: 200, gain: 1 },
    { hz: 2200, bandwidth: 400, gain: 0.3 },
  ],
};

/** Deterministic noise in [-1, 1). */
function noise(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  return Float32Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  });
}

type Verdict = 'right' | 'octave' | 'other';

/** What the analysis made of one sustained note at `midi`: right (one note within half a semitone), an octave off, or otherwise wrong. */
function verdict(notes: readonly PitchNote[], midi: number): Verdict {
  if (notes.length === 0) return 'other';
  const note = notes.reduce((p, q) => (q.to - q.from > p.to - p.from ? q : p));
  const err = note.pitch - midi;
  if (Math.abs(err) < 0.5 && notes.length === 1) return 'right';
  const oct = Math.round(err / 12);
  return oct !== 0 && Math.abs(err - 12 * oct) < 0.5 ? 'octave' : 'other';
}

function rate(formants: readonly Formant[], opts: { repairOctaves: boolean; vibrato?: boolean; noise?: number; from?: number; to?: number; step?: number }) {
  const out = { right: 0, octave: 0, other: 0 };
  for (let midi = opts.from ?? 45; midi <= (opts.to ?? 84); midi += opts.step ?? 1) {
    const f = opts.vibrato ? (t: number) => midi + 0.4 * Math.sin(2 * Math.PI * 5.5 * t) : midi;
    const x = sing([{ from: 0.1, to: 0.65, midi: f }], SR, 0.75, formants);
    if (opts.noise) {
      const n = noise(x.length, midi);
      for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) + opts.noise * (n[i] as number);
    }
    out[verdict(analyzePitch(x, SR, { repairOctaves: opts.repairOctaves }).notes, midi)]++;
  }
  return out;
}

describe('octave errors on voices with a strong formant over the second harmonic', () => {
  it('the tracker alone reads many notes an octave high; with the repair none are wrong (160 notes, MIDI 45–84)', () => {
    let before = 0;
    let after = 0;
    let total = 0;
    for (const formants of Object.values(VOICES)) {
      const a = rate(formants, { repairOctaves: false });
      const b = rate(formants, { repairOctaves: true });
      total += a.right + a.octave + a.other;
      before += a.octave + a.other;
      after += b.octave + b.other;
      expect(b.octave).toBe(0);
    }
    expect(total).toBe(160);
    // The set does exercise the tracker's weakness (14 wrong notes of 160 measured), and the repair clears all of them.
    expect(before).toBeGreaterThanOrEqual(10);
    expect(after).toBe(0);
  }, 180_000);

  it('with vibrato (±40 cents) and noise (−30 dB) as well, the repair leaves no octave errors', () => {
    let wrong = 0;
    for (const formants of Object.values(VOICES)) {
      const r = rate(formants, { repairOctaves: true, vibrato: true, noise: 0.015, from: 52, to: 80, step: 2 });
      wrong += r.octave + r.other;
    }
    expect(wrong).toBe(0);
  }, 120_000);

  it('a sung melody that has the weak-fundamental notes keeps every note, in order', () => {
    const notes = [69, 70, 62, 61, 68, 67].map((midi, i) => ({ from: 0.1 + i * 0.5, to: 0.55 + i * 0.5, midi }));
    const x = sing(notes, SR, 3.3, VOICES.f880);
    const a = analyzePitch(x, SR);
    expect(a.notes.map((n) => Math.round(n.pitch))).toEqual([69, 70, 62, 61, 68, 67]);
    a.notes.forEach((n, i) => expect(Math.abs(n.pitch - (notes[i] as { midi: number }).midi)).toBeLessThan(0.15));
  });

  it('is deterministic and the repaired track is what segmentation sees', () => {
    const x = sing([{ from: 0.1, to: 0.7, midi: 69 }], SR, 0.8, VOICES.f900);
    const a = analyzePitch(x, SR);
    expect(JSON.stringify(a.notes)).toBe(JSON.stringify(analyzePitch(x, SR).notes));
    const voiced = Array.from(a.f0).filter((f) => f > 0).sort((p, q) => p - q);
    expect(voiced[voiced.length >> 1]).toBeCloseTo(440, -1);
  });
});

describe('no false repairs', () => {
  it('voices the tracker reads right are untouched (low formants, high formants, the whole range)', () => {
    const calm: Record<string, readonly Formant[]> = {
      low: [{ hz: 500, bandwidth: 150, gain: 1 }, { hz: 1500, bandwidth: 300, gain: 0.4 }],
      high: [{ hz: 1500, bandwidth: 400, gain: 1 }, { hz: 3000, bandwidth: 500, gain: 0.3 }],
    };
    for (const formants of Object.values(calm)) {
      for (let midi = 40; midi <= 84; midi += 2) {
        const x = sing([{ from: 0.1, to: 0.65, midi }], SR, 0.75, formants);
        const off = analyzePitch(x, SR, { repairOctaves: false });
        const on = analyzePitch(x, SR);
        if (verdict(off.notes, midi) !== 'right') continue; // the tracker's own mistakes are not what is measured here
        expect(JSON.stringify(on.notes), `midi ${midi}`).toBe(JSON.stringify(off.notes));
      }
    }
  });

  it('breathy, vibrato-rich voices with hum in the background keep their pitch', () => {
    for (const midi of [52, 57, 59, 64, 71, 76]) {
      const x = sing([{ from: 0.1, to: 0.7, midi: (t: number) => midi + 0.5 * Math.sin(2 * Math.PI * 6 * t) }], SR, 0.8, [{ hz: 600, bandwidth: 200, gain: 1 }]);
      const n = noise(x.length, 90 + midi);
      for (let i = 0; i < x.length; i++) {
        // −26 dB breath and 60 Hz mains hum with its second and third harmonics.
        const t = i / SR;
        x[i] = (x[i] as number) + 0.03 * (n[i] as number) + 0.008 * (Math.sin(2 * Math.PI * 60 * t) + 0.7 * Math.sin(2 * Math.PI * 120 * t) + 0.4 * Math.sin(2 * Math.PI * 180 * t));
      }
      const a = analyzePitch(x, SR);
      const off = analyzePitch(x, SR, { repairOctaves: false });
      // Hum lines at 60/120/180 Hz are not a lower fundamental (the second new line is missing): nothing is moved.
      expect(JSON.stringify(a.notes), `midi ${midi}`).toBe(JSON.stringify(off.notes));
      expect(a.notes.length, `midi ${midi}`).toBe(1);
      expect(Math.abs(a.notes[0]!.pitch - midi), `midi ${midi}`).toBeLessThan(0.3);
    }
  });

  it('a voice with no energy at its fundamental is still read at the missing fundamental', () => {
    const f0 = midiToHz(55); // G3, harmonics 2–12 only
    const x = new Float32Array(Math.round(0.8 * SR));
    for (let i = 0; i < x.length; i++) {
      let v = 0;
      for (let k = 2; k <= 12; k++) v += Math.cos((2 * Math.PI * k * f0 * i) / SR) / k;
      x[i] = 0.2 * v * Math.min(1, i / 480, (x.length - 1 - i) / 480);
    }
    const a = analyzePitch(x, SR);
    expect(a.notes.length).toBe(1);
    expect(Math.abs(a.notes[0]!.pitch - 55)).toBeLessThan(0.2);
  });

  it('an octave leap in a melody is a leap, not an error', () => {
    const x = sing(
      [
        { from: 0.1, to: 0.6, midi: 50 },
        { from: 0.6, to: 1.1, midi: 62 },
        { from: 1.1, to: 1.6, midi: 74 },
      ],
      SR,
      1.8,
      [{ hz: 600, bandwidth: 200, gain: 1 }, { hz: 1800, bandwidth: 400, gain: 0.3 }],
    );
    const a = analyzePitch(x, SR);
    expect(a.notes.map((n) => Math.round(n.pitch))).toEqual([50, 62, 74]);
  });
});

describe('the evidence and the windows', () => {
  it('hasSubharmonic needs both new lines of the lower fundamental', () => {
    const binHz = 8800 / 1024;
    const bins = 513;
    const mag = new Float64Array(bins).fill(1e-4);
    const put = (hz: number, v: number) => {
      const k = Math.round(hz / binHz);
      mag[k - 1] = v * 0.5;
      mag[k] = v;
      mag[k + 1] = v * 0.5;
    };
    // A comb at 880 and its multiples only.
    for (let h = 1; h <= 4; h++) put(880 * h, 1);
    expect(hasSubharmonic(mag, binHz, 880, 2)).toBe(false);
    // The 440 Hz fundamental alone is not enough …
    put(440, 0.3);
    expect(hasSubharmonic(mag, binHz, 880, 2)).toBe(false);
    // … with its third multiple as well it is.
    put(1320, 0.2);
    expect(hasSubharmonic(mag, binHz, 880, 2)).toBe(true);
    // And the lower candidate (f / 3, 293 Hz) is not there.
    expect(hasSubharmonic(mag, binHz, 880, 3)).toBe(false);
    // A line that is barely above the floor is no evidence.
    const weak = new Float64Array(bins).fill(1e-4);
    for (let h = 1; h <= 4; h++) {
      const k = Math.round((880 * h) / binHz);
      weak[k] = 1;
    }
    weak[Math.round(440 / binHz)] = 0.002;
    weak[Math.round(1320 / binHz)] = 0.002;
    expect(hasSubharmonic(weak, binHz, 880, 2)).toBe(false);
  });

  it('repairs only the frames whose sound has the lower fundamental (a note read an octave high next to a true one at that pitch)', () => {
    // C#3 sung then D4: the tracker joins "C#3 read at C#4" with nothing; here a legit note stays put beside the repaired one.
    const x = sing(
      [
        { from: 0.1, to: 0.6, midi: 62 },
        { from: 0.6, to: 1.1, midi: 74 },
      ],
      SR,
      1.2,
      [{ hz: 600, bandwidth: 200, gain: 1 }, { hz: 1800, bandwidth: 400, gain: 0.3 }],
    );
    const hop = Math.round(0.005 * SR);
    const f0 = new Float32Array(Math.floor(x.length / hop));
    // A track that reads the first note an octave high (74 for 62): the second note is right.
    for (let i = 0; i < f0.length; i++) {
      const t = (i * hop) / SR;
      if (t >= 0.12 && t < 0.58) f0[i] = midiToHz(74);
      else if (t >= 0.62 && t < 1.08) f0[i] = midiToHz(74);
    }
    const moved = repairOctaveSlips(x, SR, f0, hop);
    expect(moved).toBeGreaterThan(60);
    const at = (t: number) => f0[Math.round(t / (hop / SR))] as number;
    expect(at(0.35)).toBeCloseTo(midiToHz(62), -1);
    expect(at(0.9)).toBeCloseTo(midiToHz(74), -1);
  });
});

describe('cost', () => {
  it('the repair is a small part of the analysis of a minute of singing', { tags: ['perf'] }, async () => {
    // 60 s: a note every 1.5 s across the weak-fundamental range.
    const notes = Array.from({ length: 40 }, (_, i) => ({ from: 0.2 + i * 1.5, to: 1.4 + i * 1.5, midi: 62 + (i % 9) }));
    const x = sing(notes, SR, 61, VOICES.f900);
    // CPU time, best of up to three runs: the wall clock would count the time spent waiting for a core.
    let a!: ReturnType<typeof analyzePitch>;
    const ms = await settle(
      () => {
        const t0 = cpuNow();
        a = analyzePitch(x, SR);
        return cpuNow() - t0;
      },
      (cpuMs) => cpuMs < 3000,
      { attempts: 3 },
    );
    expect(a.notes.length).toBe(40);
    // Loose bound (the limit that matters is the 112 ms of the tracker itself plus a few ms): a shared CI runner can be slow.
    expect(ms).toBeLessThan(3000);
  });
});
