import { describe, expect, it } from 'vitest';
import type { PitchEdit } from '@core/model/types';
import { hzToMidi } from '@core/voice/pitch';
import {
  clockText,
  curveMidi,
  dragTarget,
  drawNotes,
  hitNote,
  keyForRow,
  notesInRect,
  pitchText,
  rowForKey,
} from './model';

const MAJOR = [true, false, true, false, true, true, false, true, false, true, false, true];
const edit: PitchEdit = {
  notes: [
    { from: 1, to: 2, pitch: 60.3, shift: -30 },
    { from: 2.5, to: 3, pitch: 64.1, drift: 0.5 },
    { from: 3.2, to: 4, pitch: 67 },
  ],
};

describe('Pitch editor geometry', () => {
  it('maps rows and keys (row 0 is the top key)', () => {
    expect(keyForRow(0)).toBe(127);
    expect(rowForKey(60)).toBe(67);
    expect(keyForRow(rowForKey(33))).toBe(33);
  });

  it('draws notes at their target; a move shows on the moving ones only; edited means changed', () => {
    const notes = drawNotes(edit);
    expect(notes.map((n) => [n.fromMs, n.toMs])).toEqual([[1000, 2000], [2500, 3000], [3200, 4000]]);
    expect(notes[0]!.target).toBeCloseTo(60, 6);
    expect(notes.map((n) => n.edited)).toEqual([true, true, false]);
    const moved = drawNotes(edit, 2, new Set([2]));
    expect(moved[2]!.target).toBe(69);
    expect(moved[0]!.target).toBeCloseTo(60, 6);
  });

  it('finds the note under the pointer: inside its time and near its pitch, the nearest wins', () => {
    const notes = drawNotes(edit);
    expect(hitNote(notes, 1500, 60.2)).toBe(0);
    expect(hitNote(notes, 1500, 61.4)).toBe(0); // thin blobs: a semitone and a half counts
    expect(hitNote(notes, 1500, 63)).toBe(-1);
    expect(hitNote(notes, 2200, 60)).toBe(-1); // between notes
    expect(hitNote(notes, 3500, 67.2)).toBe(2);
    // Two notes at the same time (overlap): the nearer target.
    const stacked = drawNotes({ notes: [{ from: 0, to: 1, pitch: 60 }, { from: 0, to: 1, pitch: 62 }] });
    expect(hitNote(stacked, 500, 61.6)).toBe(1);
  });

  it('selects notes inside a rectangle', () => {
    const notes = drawNotes(edit);
    expect(notesInRect(notes, 900, 2100, 59, 61)).toEqual([0]);
    expect(notesInRect(notes, 0, 5000, 59, 70)).toEqual([0, 1, 2]);
    expect(notesInRect(notes, 2400, 2600, 40, 50)).toEqual([]);
  });

  it('drags to whole semitones, to the key’s notes, or (Alt) to the cent', () => {
    expect(dragTarget(60, 1.4, { free: false })).toBe(61);
    expect(dragTarget(60.3, 0.4, { free: false })).toBe(61);
    expect(dragTarget(60, 1.4, { free: false, mask: MAJOR })).toBe(62); // 61.4 is nearest to D: C# is not in C major
    expect(dragTarget(60, 0.37, { free: true })).toBe(60.37);
    expect(dragTarget(60, -0.004, { free: true })).toBe(60);
  });

  it('draws the corrected curve through the edit and leaves unvoiced gaps as NaN', () => {
    const f0 = new Float32Array(200).fill(440);
    f0.fill(0, 50, 60);
    const frames = { t0: 0, hop: 0.005, f0, conf: new Float32Array(200).fill(1) };
    const plain = curveMidi(frames, null);
    expect(plain[0]).toBeCloseTo(69, 6);
    expect(Number.isNaN(plain[55] as number)).toBe(true);
    const moved = curveMidi(frames, { notes: [{ from: 0.4, to: 0.9, pitch: 69, shift: 100 }], transition: 0 });
    expect(moved[120]).toBeCloseTo(70, 4);
    expect(moved[10]).toBeCloseTo(69, 6);
    expect(hzToMidi(440)).toBe(69);
  });

  it('writes pitches and times as people read them', () => {
    const name = (k: number) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][k % 12]! + Math.floor(k / 12);
    expect(pitchText(60, name)).toBe('C5');
    expect(pitchText(60.23, name)).toBe('C5 +23 ct');
    expect(pitchText(59.7, name)).toBe('C5 −30 ct');
    expect(clockText(0)).toBe('0:00.0');
    expect(clockText(75.34)).toBe('1:15.3');
  });
});
