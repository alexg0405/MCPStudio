import { describe, expect, it } from 'vitest';
import { formantPeak, sing, type SungNote } from '../../../../test/helpers/sung';
import { analyzePitch } from '../../voice/pitch-notes';
import { chordTonePitchClasses, planTargets, shiftsFromTargets, type LeadNote, type PlanContext } from './targets';
import { humanizeNotes, voiceSeed } from './humanize';
import { renderHarmonyVoice, type SourceNote } from './render';
import { harmonySignature, type SignatureInput } from './signature';
import { arrangeVoice } from './arrange';

const SR = 48000;
const A_MINOR = { root: 9, scale: 'minor' };
/** At 120 BPM one second is two beats = 1920 ticks. */
const TICKS_PER_SECOND = 1920;

/** A sung line in A minor: A4 B4 C5 D5 E5 D5 C5 A4, a little sharp (+15 cents), vibrato on the fifth note. */
const MELODY = [69, 71, 72, 74, 76, 74, 72, 69];
function singMelody(): Float32Array {
  const notes: SungNote[] = MELODY.map((midi, i) => ({
    from: 0.15 + i * 0.6,
    to: 0.15 + i * 0.6 + 0.5,
    midi: i === 4 ? (t: number) => midi + 0.15 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t) : midi + 0.15,
  }));
  return sing(notes, SR, 5.2);
}

/** The lead as the app sees it after analysis: sample notes and the same notes with song ticks. */
function analyseLead(x: Float32Array) {
  const analysis = analyzePitch(x, SR);
  const notes: SourceNote[] = analysis.notes.map((n) => ({ from: n.from, to: n.to, pitch: n.pitch }));
  const lead: LeadNote[] = notes.map((n) => ({ pitch: n.pitch, startTick: Math.round(n.from * TICKS_PER_SECOND), endTick: Math.round(n.to * TICKS_PER_SECOND) }));
  return { notes, lead };
}

const noChords: PlanContext = { key: A_MINOR, chordTonesAt: () => null };

/** The median pitch (MIDI) of the output's note nearest the given time, from its own analysis. */
function pitchNear(y: Float32Array, time: number): number | null {
  const found = analyzePitch(y, SR).notes.find((n) => time >= n.from - 0.05 && time <= n.to + 0.05);
  return found ? found.pitch : null;
}

describe('diatonic harmonies', () => {
  const x = singMelody();
  const { notes, lead } = analyseLead(x);

  it('finds the eight notes of the lead', () => {
    expect(notes).toHaveLength(8);
  });

  it('plans a third above on the notes of A minor', () => {
    const [targets] = planTargets(lead, [{ kind: 'interval', steps: 2 }], noChords);
    expect(targets).toEqual([72, 74, 76, 77, 79, 77, 76, 72]);
  });

  it('plans a third below, a sixth above and an octave', () => {
    const [below, sixth, octave] = planTargets(lead, [{ kind: 'interval', steps: -2 }, { kind: 'interval', steps: 5 }, { kind: 'interval', steps: 7 }], noChords);
    expect(below).toEqual([65, 67, 69, 71, 72, 71, 69, 65]);
    expect(sixth?.[0]).toBe(77);
    expect(octave).toEqual(MELODY.map((m) => m + 12));
  });

  it('a third-above voice lands each note on the scale degree, within 10 cents (median of the note)', () => {
    const [targets] = planTargets(lead, [{ kind: 'interval', steps: 2 }], noChords);
    const shifts = shiftsFromTargets(lead, targets as number[]);
    const humanize = humanizeNotes(notes.length, { timingMs: 0, driftCents: 0, vibrato: 0 }, 1);
    const [voice] = renderHarmonyVoice({ channels: [x], sampleRate: SR, start: 0, notes, shifts, humanize, formantCents: 0 });
    const expected = [72, 74, 76, 77, 79, 77, 76, 72];
    notes.forEach((n, i) => {
      const heard = pitchNear(voice as Float32Array, (n.from + n.to) / 2);
      expect(heard, `note ${i + 1}`).not.toBeNull();
      expect(Math.abs(((heard as number) - (expected[i] as number)) * 100), `note ${i + 1} cents off`).toBeLessThan(10);
    });
  });

  it('says why a diatonic rule cannot be planned without a key', () => {
    expect(() => planTargets(lead, [{ kind: 'interval', steps: 2 }], { key: null, chordTonesAt: () => null })).toThrow(/song key/);
  });
});

describe('fixed intervals and guide melodies', () => {
  const lead: LeadNote[] = [60, 62, 64].map((pitch, i) => ({ pitch: pitch + 0.2, startTick: i * 1920, endTick: i * 1920 + 1800 }));

  it('a fixed interval keeps the lead tuning', () => {
    const [fifth] = planTargets(lead, [{ kind: 'semitones', semitones: 7 }], noChords);
    expect(fifth?.[0]).toBeCloseTo(67.2, 9);
  });

  it('a guide melody is sung where it sounds, silent where it does not, and folded to the lead octave', () => {
    const notes = [
      { tick: 0, length: 1920, pitch: 55 },
      { tick: 3840, length: 1920, pitch: 52 + 24 },
    ];
    const [voice] = planTargets(lead, [{ kind: 'midi', notes }], noChords);
    // 55 is a fifth below 60.2 (within an octave); nothing sounds at the second note; 76 folds to 64 against a lead of 64.2.
    expect(voice).toEqual([55, null, 64]);
  });

  it('refuses an empty guide melody', () => {
    expect(() => planTargets(lead, [{ kind: 'midi', notes: [] }], noChords)).toThrow(/guide melody/);
  });
});

describe('chord-following voices', () => {
  // Am for two beats' worth of notes, then F, then G, one chord per 4 notes' worth of ticks.
  const chords = [
    { from: 0, to: 4 * 1920, tones: chordTonePitchClasses({ root: 9, quality: 'min' }) },
    { from: 4 * 1920, to: 8 * 1920, tones: chordTonePitchClasses({ root: 5, quality: 'maj' }) },
    { from: 8 * 1920, to: 12 * 1920, tones: chordTonePitchClasses({ root: 7, quality: 'maj' }) },
  ];
  const context: PlanContext = {
    key: A_MINOR,
    chordTonesAt: (tick) => chords.find((c) => tick >= c.from && tick < c.to)?.tones ?? null,
  };
  const leadPitches = [69, 72, 76, 72, 77, 74, 72, 69, 74, 71, 67, 71];
  const lead: LeadNote[] = leadPitches.map((pitch, i) => ({ pitch, startTick: i * 1920, endTick: i * 1920 + 1800 }));
  const rules = [{ kind: 'chord', side: 'above' }, { kind: 'chord', side: 'above' }, { kind: 'chord', side: 'below' }] as const;

  it('every voice sings a tone of the chord that sounds', () => {
    const targets = planTargets(lead, rules, context);
    lead.forEach((note, i) => {
      const tones = context.chordTonesAt(note.startTick) as readonly number[];
      for (const voice of targets) expect(tones, `note ${i}`).toContain((((voice[i] as number) % 12) + 12) % 12);
    });
  });

  it('the voices never cross: below < lead < first above < second above, with no shared notes', () => {
    const [near, far, below] = planTargets(lead, rules, context) as number[][];
    lead.forEach((note, i) => {
      expect(below![i]).toBeLessThan(note.pitch);
      expect(near![i]).toBeGreaterThan(note.pitch);
      expect(far![i]).toBeGreaterThan(near![i] as number);
      expect((far![i] as number) - note.pitch).toBeLessThanOrEqual(12);
    });
  });

  it('they move smoothly: a voice is never more than a fifth from where it was while the chord holds', () => {
    const [near] = planTargets(lead, [rules[0]], context) as number[][];
    for (let i = 1; i < 4; i++) expect(Math.abs((near![i] as number) - (near![i - 1] as number))).toBeLessThanOrEqual(7);
  });

  it('falls back to a diatonic third where the chord track is empty, and a plain third without a key', () => {
    const [keyed] = planTargets(lead.slice(0, 2), [{ kind: 'chord', side: 'above' }], noChords);
    expect(keyed).toEqual([72, 76]);
    const [plain] = planTargets(lead.slice(0, 1), [{ kind: 'chord', side: 'above' }], { key: null, chordTonesAt: () => null });
    expect(plain).toEqual([73]);
  });
});

describe('humanize', () => {
  const settings = { timingMs: 15, driftCents: 8, vibrato: 0.3 };

  it('stays within its bounds and is the same for the same seed', () => {
    const seed = voiceSeed(1, 7);
    const a = humanizeNotes(200, settings, seed);
    const b = humanizeNotes(200, settings, seed);
    expect(a).toEqual(b);
    for (const n of a) {
      expect(Math.abs(n.delaySec)).toBeLessThanOrEqual(0.015);
      expect(Math.abs(n.driftCents)).toBeLessThanOrEqual(8);
      expect(Math.abs(n.vibratoScale - 1)).toBeLessThanOrEqual(0.3);
    }
    expect(Math.max(...a.map((n) => n.delaySec))).toBeGreaterThan(0.01);
    expect(humanizeNotes(5, settings, voiceSeed(2, 7))).not.toEqual(a.slice(0, 5));
  });

  it('with nothing set, nothing changes', () => {
    for (const n of humanizeNotes(20, { timingMs: 0, driftCents: 0, vibrato: 0 }, 3)) {
      expect(n.delaySec).toBeCloseTo(0, 12);
      expect(n.driftCents).toBeCloseTo(0, 12);
      expect(n.vibratoScale).toBeCloseTo(1, 12);
    }
  });

  it('moves where a note starts by no more than the timing setting (and by something when asked)', () => {
    const x = singMelody();
    const { notes, lead } = analyseLead(x);
    const [targets] = planTargets(lead, [{ kind: 'interval', steps: 2 }], noChords);
    const shifts = shiftsFromTargets(lead, targets as number[]);
    const start = (humanize: ReturnType<typeof humanizeNotes>) => {
      const [voice] = renderHarmonyVoice({ channels: [x], sampleRate: SR, start: 0, notes, shifts, humanize, formantCents: 0 });
      return analyzePitch(voice as Float32Array, SR).notes.map((n) => n.from);
    };
    const straight = start(humanizeNotes(notes.length, { timingMs: 0, driftCents: 0, vibrato: 0 }, 5));
    const loose = start(humanizeNotes(notes.length, { timingMs: 30, driftCents: 0, vibrato: 0 }, 5));
    expect(straight).toHaveLength(notes.length);
    expect(loose).toHaveLength(notes.length);
    const moved = loose.map((t, i) => Math.abs(t - (straight[i] as number)));
    // The analysis's own frame (5 ms) and a note edge's pitch settling add a few ms either way.
    expect(Math.max(...moved)).toBeLessThanOrEqual(0.03 + 0.012);
    expect(Math.max(...moved)).toBeGreaterThan(0.004);
  });
});

describe('rendering', () => {
  const x = singMelody();
  const { notes, lead } = analyseLead(x);
  const [targets] = planTargets(lead, [{ kind: 'interval', steps: 2 }], noChords);
  const shifts = shiftsFromTargets(lead, targets as number[]);
  const humanize = humanizeNotes(notes.length, { timingMs: 12, driftCents: 6, vibrato: 0.3 }, 11);

  it('is bit-identical when made again', () => {
    const make = () => renderHarmonyVoice({ channels: [x], sampleRate: SR, start: 0, notes, shifts, humanize, formantCents: 0 })[0] as Float32Array;
    const a = make();
    const b = make();
    expect(a.length).toBe(x.length);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  it('leaves out the breaths between phrases and mutes silent notes', () => {
    const noise = new Float32Array(x.length);
    for (let i = 0; i < noise.length; i++) noise[i] = x[i]! + 0.05 * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
    const silent = shifts.map((s, i) => (i === 2 ? null : s));
    const [voice] = renderHarmonyVoice({ channels: [noise], sampleRate: SR, start: 0, notes, shifts: silent, humanize, formantCents: 0 });
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) sum += (voice![i] as number) ** 2;
      return Math.sqrt(sum / ((to - from) * SR));
    };
    const third = notes[2] as SourceNote;
    expect(rms(third.from + 0.05, third.to - 0.05)).toBeLessThan(1e-6);
    expect(rms(0, 0.03)).toBeLessThan(1e-6);
    expect(rms((notes[0] as SourceNote).from + 0.05, (notes[0] as SourceNote).to - 0.05)).toBeGreaterThan(0.02);
  });

  it('moves the formants by the setting while keeping the pitch', () => {
    const steady = sing([{ from: 0.05, to: 1.05, midi: 60 }], SR, 1.1);
    const one: SourceNote[] = [{ from: 0.05, to: 1.05, pitch: 60 }];
    const render = (formantCents: number) =>
      renderHarmonyVoice({ channels: [steady], sampleRate: SR, start: 0, notes: one, shifts: [4], humanize: humanizeNotes(1, { timingMs: 0, driftCents: 0, vibrato: 0 }, 1), formantCents })[0] as Float32Array;
    const f0 = 440 * Math.pow(2, (64 - 69) / 12);
    const same = formantPeak(render(0), SR, f0, 20000, 40000);
    const up = formantPeak(render(200), SR, f0, 20000, 40000);
    // 200 cents is a factor of 1.122 on the vowel's peak.
    expect(up / same).toBeGreaterThan(1.07);
    expect(up / same).toBeLessThan(1.17);
  });
});

describe('arrangement', () => {
  it('a partition of unity: two touching notes with different delays never change the level of a held tone', () => {
    const tone = Float32Array.from({ length: SR }, () => 1);
    const parts = [
      { from: 0.1, to: 0.4, delaySec: 0.01, silent: false },
      { from: 0.4, to: 0.7, delaySec: -0.01, silent: false },
    ];
    const [y] = arrangeVoice([tone], SR, 0, parts);
    for (let i = Math.round(0.2 * SR); i < Math.round(0.6 * SR); i++) expect(y![i]).toBeCloseTo(1, 6);
  });
});

describe('signature', () => {
  const base: SignatureInput = {
    sound: 'abc.flac|0|off',
    from: 0.1,
    to: 5,
    start: 0,
    rule: { kind: 'chord', side: 'above' },
    formantCents: 0,
    humanize: { timingMs: 12, driftCents: 6, vibrato: 0.3 },
    seed: 3,
    key: '9:minor',
    chords: [{ tick: 0, length: 1920, root: 9, quality: 'min' }],
    bpm: 120,
  };

  it('changes with the chords for a chord rule, and not for a fixed interval', () => {
    const changed = { ...base, chords: [{ tick: 0, length: 1920, root: 5, quality: 'maj' }] };
    expect(harmonySignature(changed)).not.toBe(harmonySignature(base));
    const fixed = { ...base, rule: { kind: 'semitones', semitones: 4 } as const };
    expect(harmonySignature({ ...fixed, chords: changed.chords })).toBe(harmonySignature(fixed));
  });

  it('changes with the lead sound, the part played and the settings', () => {
    expect(harmonySignature({ ...base, sound: 'other' })).not.toBe(harmonySignature(base));
    expect(harmonySignature({ ...base, to: 6 })).not.toBe(harmonySignature(base));
    expect(harmonySignature({ ...base, formantCents: 50 })).not.toBe(harmonySignature(base));
    expect(harmonySignature({ ...base })).toBe(harmonySignature(base));
  });
});
