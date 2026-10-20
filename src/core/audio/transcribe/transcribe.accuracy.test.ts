/**
 * How right Convert to MIDI is, on synthetic recordings with known contents (`test/helpers/transcribe-signals.ts`): a sung
 * melody, drum loops made of the Drum Pads' own sounds, chord pads, and a bassline under a kit. Each test says its target and
 * the numbers are in the failure message, so the accuracy in docs/architecture.md can be checked by running this file.
 */
import { describe, expect, it } from 'vitest';
import { formatChord } from '../../harmony/chord';
import {
  BEATS,
  bassLine,
  chordPads,
  drumLoop,
  progression,
  scoreHits,
  scoreNotes,
  sungMelody,
  timelineOf,
  TRANSCRIBE_RATE,
  type BassStep,
  type SungStep,
} from '../../../../test/helpers/transcribe-signals';
import { detectBass } from './bass';
import { chordNotes, detectChroma, readChords } from './chords';
import { detectDrums } from './drums';
import { detectMelody } from './melody';
import { planTranscription } from './plan';
import { settingsFor } from './types';

const SR = TRANSCRIBE_RATE;
const percent = (n: number, of: number) => Math.round((100 * n) / Math.max(1, of));

/** Three sung lines: a stepwise tune with long and short notes, one with repeated notes and rests, one low with wide leaps. */
const MELODIES: { name: string; steps: SungStep[] }[] = [
  { name: 'stepwise', steps: [[69, 0.4], [71, 0.3], [72, 0.6, 0.1], [74, 0.25], [76, 0.5], [74, 0.3], [72, 0.4], [69, 0.7]] },
  { name: 'repeats and rests', steps: [[64, 0.3, 0.12], [64, 0.3, 0.12], [64, 0.3, 0.2], [67, 0.45], [67, 0.2], [65, 0.35, 0.15], [62, 0.5], [60, 0.8]] },
  { name: 'low leaps', steps: [[48, 0.5], [55, 0.4], [52, 0.35], [60, 0.45, 0.1], [47, 0.6], [53, 0.3], [59, 0.5], [50, 0.7]] },
];

describe('melody', () => {
  it('finds the notes of a sung line: onset within 20 ms and the right pitch, 95 % or more', () => {
    let played = 0;
    let right = 0;
    const lines: string[] = [];
    for (const m of MELODIES) {
      const { mono, notes } = sungMelody({ steps: m.steps });
      const score = scoreNotes(notes, detectMelody(mono, SR));
      played += score.played;
      right += score.right;
      lines.push(`${m.name}: ${score.right}/${score.played}, ${score.extra} extra ${score.problems.join('; ')}`);
    }
    expect(percent(right, played), lines.join('\n')).toBeGreaterThanOrEqual(95);
  });

  it('writes the notes in song ticks on the keys that were sung, with a velocity from the loudness', () => {
    const { mono } = sungMelody({ steps: [[60, 0.5, 0.1, 0.35], [64, 0.5, 0.1, 0.1], [67, 0.5, 0.1, 0.35]], start: 0 });
    const heard = { kind: 'notes' as const, mode: 'melody' as const, notes: detectMelody(mono, SR) };
    const plan = planTranscription(heard, timelineOf({ bpm: 120 }), settingsFor('melody', { quantize: { gridTicks: 120, strength: 1, swing: 'straighten' } }));
    expect(plan.notes.map((n) => n.key)).toEqual([60, 64, 67]);
    expect(plan.notes.map((n) => n.tick % 120)).toEqual([0, 0, 0]);
    const [first, quiet, third] = plan.notes;
    expect(quiet?.velocity).toBeLessThan((first?.velocity ?? 0) - 0.1);
    expect(third?.velocity).toBeGreaterThan(0.8);
  });
});

/** The kit loops and the sounds (kick, snare, clap, hats, toms…) they are made of. */
const LOOPS = [
  { name: 'house 124', bpm: 124, patterns: ['house'], rate: 44100 },
  { name: 'boom bap 90', bpm: 90, patterns: ['boomBap'], rate: 44100 },
  { name: 'trap 140', bpm: 140, patterns: ['trap'], rate: 48000 },
  { name: 'rock with a fill 110', bpm: 110, patterns: ['rock', 'rock', 'rock', 'fill'], rate: 44100 },
  { name: 'swung rock 100, hits 6 ms off', bpm: 100, patterns: ['rock'], rate: 48000, swing: 0.6, jitterMs: 6 },
];

describe('drums', () => {
  it('finds kick, snare, clap, hats and toms: the right kind within 15 ms, 90 % of what was played and 90 % of what was heard', () => {
    let played = 0;
    let right = 0;
    let heard = 0;
    const lines: string[] = [];
    for (const l of LOOPS) {
      const loop = drumLoop({ bpm: l.bpm, bars: 4, patterns: l.patterns.map((p) => BEATS[p] ?? []), rate: l.rate, swing: l.swing ?? 0, jitterMs: l.jitterMs ?? 0 });
      const found = detectDrums(loop.mono, loop.rate).hits;
      const score = scoreHits(loop.hits, found);
      played += score.played;
      right += score.rightKind;
      heard += score.heard;
      lines.push(`${l.name}: ${score.rightKind}/${score.played} right, ${score.extra} extra, worst ${Math.max(...score.errorsMs).toFixed(1)} ms ${score.problems.slice(0, 4).join('; ')}`);
    }
    const message = `${percent(right, played)} % recall, ${percent(right, heard)} % precision\n${lines.join('\n')}`;
    expect(percent(right, played), message).toBeGreaterThanOrEqual(90);
    expect(percent(right, heard), message).toBeGreaterThanOrEqual(90);
  });

  it('gets the three main kinds right on their own: kick, snare and hat each at 90 %', () => {
    const counts = { kick: [0, 0], snare: [0, 0], hat: [0, 0] } as Record<string, [number, number]>;
    for (const l of LOOPS) {
      const loop = drumLoop({ bpm: l.bpm, bars: 4, patterns: l.patterns.map((p) => BEATS[p] ?? []), rate: l.rate, swing: l.swing ?? 0, jitterMs: l.jitterMs ?? 0 });
      const found = detectDrums(loop.mono, loop.rate).hits;
      for (const kind of Object.keys(counts)) {
        const truth = loop.hits.filter((h) => h.kind === kind);
        const score = scoreHits(truth, found.filter((h) => h.kind === kind));
        (counts[kind] as [number, number])[0] += score.rightKind;
        (counts[kind] as [number, number])[1] += score.played;
      }
    }
    const message = JSON.stringify(counts);
    for (const [kind, [right, played]] of Object.entries(counts)) expect(percent(right, played), `${kind}: ${message}`).toBeGreaterThanOrEqual(90);
  });

  it('reads hits that sound together as separate hits (a hat over a kick, a clap over a kick)', () => {
    const loop = drumLoop({ bpm: 124, bars: 2, patterns: [BEATS.house ?? []] });
    const found = detectDrums(loop.mono, loop.rate).hits;
    const near = (time: number, kind: string) => found.some((h) => h.kind === kind && Math.abs(h.timeSec - time) < 0.015);
    const claps = loop.hits.filter((h) => h.kind === 'clap');
    expect(claps.length).toBeGreaterThan(0);
    for (const clap of claps) {
      expect(near(clap.timeSec, 'clap')).toBe(true);
      expect(near(clap.timeSec, 'kick')).toBe(true);
    }
  });
});

/** Chord names per beat for a progression: every beat the chord that was playing. */
function truthPerBeat(names: readonly string[], beatsEach: number | readonly number[]): string[] {
  const out: string[] = [];
  names.forEach((name, i) => {
    const beats = typeof beatsEach === 'number' ? beatsEach : (beatsEach[i] as number);
    for (let b = 0; b < beats; b++) out.push(name);
  });
  return out;
}

describe('chords', () => {
  it('names the chord of every beat of a pad loop (triads, sevenths, changes on beats 1 and 3): 90 % or more of the beats', () => {
    const slow = progression(['Am', 'F', 'C', 'G'], { beatsEach: 4 });
    const fast = progression(['Dm', 'G7', 'Cmaj7', 'Am7'], { beatsEach: 2 }).map((c) => ({ ...c, fromBeat: c.fromBeat + 16 }));
    const chords = [...slow, ...fast];
    const mono = chordPads({ bpm: 100, chords });
    const timeline = timelineOf({ bpm: 100, length: 960 * 24 });
    const spans = readChords(detectChroma(mono, SR), timeline, settingsFor('chords'));
    const heardPerBeat: string[] = [];
    for (let beat = 0; beat < 24; beat++) {
      const span = spans.find((s) => s.tick <= beat * 960 + 1 && s.tick + s.length > beat * 960 + 1);
      heardPerBeat.push(span ? formatChord(span.chord) : '-');
    }
    const truth = truthPerBeat([...slow, ...fast].map((c) => c.name), [4, 4, 4, 4, 2, 2, 2, 2]);
    const right = truth.filter((name, beat) => name === heardPerBeat[beat]).length;
    expect(percent(right, truth.length), `heard ${heardPerBeat.join(' ')}\nplayed ${truth.join(' ')}`).toBeGreaterThanOrEqual(90);
  });

  it('writes the chords as notes: every sounding note is a tone of the chord that plays, and the bass option adds the root below', () => {
    const chords = progression(['Am', 'F', 'C', 'G'], { beatsEach: 4 });
    const timeline = timelineOf({ bpm: 100, length: 960 * 16 });
    const spans = readChords(detectChroma(chordPads({ bpm: 100, chords }), SR), timeline, settingsFor('chords'));
    const notes = chordNotes(spans, timeline, settingsFor('chords', { chordBass: true }));
    const pitchClasses: Record<string, number[]> = { Am: [9, 0, 4], F: [5, 9, 0], C: [0, 4, 7], G: [7, 11, 2] };
    for (const note of notes) {
      const bar = Math.floor(note.tick / 3840);
      expect(pitchClasses[chords[bar]?.name ?? '']).toContain(note.key % 12);
    }
    const lowest = Math.min(...notes.filter((n) => n.tick < 3840).map((n) => n.key));
    expect(lowest % 12).toBe(9);
  });
});

/** Bass lines played under the house kit (kicks on the beats), the roots of a progression on the offbeats. */
const BASS_STEPS: readonly (readonly BassStep[])[] = [
  [[0.5, 0.45, 33], [1.5, 0.45, 33], [2.5, 0.45, 33], [3.5, 0.45, 36]],
  [[0.5, 0.45, 29], [1.5, 0.45, 29], [2.5, 0.45, 29], [3.5, 0.45, 31]],
];

describe('bassline', () => {
  it('finds the root notes of a bass under a kit: the right pitch and the start within 40 ms, 85 % or more', () => {
    let played = 0;
    let right = 0;
    let extra = 0;
    const lines: string[] = [];
    for (const bpm of [90, 100, 110, 124, 128]) {
      const bass = bassLine({ bpm, bars: 4, steps: BASS_STEPS });
      const kit = drumLoop({ bpm, bars: 4, patterns: [BEATS.house ?? []], under: bass.mono });
      const heard = detectBass(kit.mono, SR).map((n) => ({ fromSec: n.fromSec, pitch: n.pitch }));
      const score = scoreNotes(bass.notes, heard, 0.04, 0.5);
      played += score.played;
      right += score.right;
      extra += score.extra;
      lines.push(`${bpm} BPM: ${score.right}/${score.played}, ${score.extra} extra ${score.problems.slice(0, 6).join('; ')}`);
    }
    expect(percent(right, played), lines.join('\n')).toBeGreaterThanOrEqual(85);
    // The kick's own tail is not a bass note: few notes that were not played.
    expect(percent(extra, played), lines.join('\n')).toBeLessThanOrEqual(15);
  });
});
