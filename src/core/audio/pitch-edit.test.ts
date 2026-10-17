import { describe, expect, it } from 'vitest';
import { sing, type SungNote } from '../../../test/helpers/sung';
import type { PitchEdit } from '../model/types';
import { analyzePitch } from '../voice/pitch-notes';
import {
  editSignature,
  isNeutralEdit,
  mergeNotes,
  nearestAllowed,
  noteTarget,
  pitchEditFrom,
  renderPitchEdit,
  renderRange,
  sanitizePitchEdit,
  shiftCurve,
  snapToKey,
  splitNote,
  withTarget,
  mapNotes,
} from './pitch-edit';

const SR = 48000;
const C_MAJOR = [true, false, true, false, true, true, false, true, false, true, false, true];

/** A sung phrase, a little off key (+30, −35, +20 cents), with vibrato on the middle note. */
function phrase() {
  const notes: SungNote[] = [
    { from: 0.1, to: 0.8, midi: 60.3 },
    { from: 1.0, to: 1.9, midi: (t) => 64 - 0.35 + 0.45 * Math.sin(2 * Math.PI * 5.5 * t) },
    { from: 2.1, to: 2.8, midi: 67.2 },
  ];
  return { x: sing(notes, SR, 3.1), seconds: 3.1 };
}

describe('pitch edits as data', () => {
  it('nearestAllowed picks the scale note nearest (ties down)', () => {
    expect(nearestAllowed(60.3, C_MAJOR)).toBe(60);
    expect(nearestAllowed(61.2, C_MAJOR)).toBe(62);
    expect(nearestAllowed(61, C_MAJOR)).toBe(60); // tie between C and D: down
    expect(nearestAllowed(63.5, C_MAJOR)).toBe(64);
    expect(nearestAllowed(65.4, new Array(12).fill(false))).toBe(65.4);
  });

  it('snapToKey sets targets with a strength; partial strength goes part of the way', () => {
    const edit: PitchEdit = { notes: [{ from: 0, to: 1, pitch: 60.3 }, { from: 1, to: 2, pitch: 63.7 }] };
    const full = snapToKey(edit, C_MAJOR, 1);
    expect(noteTarget(full.notes[0]!)).toBeCloseTo(60, 6);
    expect(noteTarget(full.notes[1]!)).toBeCloseTo(64, 6);
    const half = snapToKey(edit, C_MAJOR, 0.5);
    expect(noteTarget(half.notes[0]!)).toBeCloseTo(60.15, 6);
    expect(snapToKey(edit, C_MAJOR, 0).notes.every((n) => n.shift === undefined)).toBe(true);
    // Only the picked notes.
    const one = snapToKey(edit, C_MAJOR, 1, new Set([1]));
    expect(one.notes[0]!.shift).toBeUndefined();
    expect(one.notes[1]!.shift).toBeCloseTo(30, 4);
  });

  it('split and merge keep the target and the neighbours', () => {
    const edit: PitchEdit = { notes: [{ from: 0, to: 2, pitch: 60, shift: 100, vibrato: 0.5 }, { from: 2, to: 3, pitch: 62 }] };
    const split = splitNote(edit, 1);
    expect(split.notes).toHaveLength(3);
    expect(split.notes[0]).toMatchObject({ from: 0, to: 1, shift: 100, vibrato: 0.5 });
    expect(split.notes[1]).toMatchObject({ from: 1, to: 2, shift: 100, vibrato: 0.5 });
    expect(splitNote(edit, 5)).toBe(edit);
    expect(splitNote(edit, 0.005)).toBe(edit); // too close to the edge
    const merged = mergeNotes(split, 0);
    expect(merged.notes).toHaveLength(2);
    expect(merged.notes[0]).toMatchObject({ from: 0, to: 2 });
    expect(noteTarget(merged.notes[0]!)).toBeCloseTo(61, 6);
  });

  it('sanitizePitchEdit repairs and drops what it must', () => {
    expect(sanitizePitchEdit(null)).toBeNull();
    expect(sanitizePitchEdit({ notes: 3 })).toBeNull();
    expect(sanitizePitchEdit({ notes: [{ from: 2, to: 1, pitch: 60 }] })).toBeNull();
    const e = sanitizePitchEdit({
      notes: [
        { from: 1, to: 2, pitch: 62, shift: 99999, drift: 3, vibrato: -1 },
        { from: 0, to: 1.5, pitch: 60 },
        { from: 'x', to: 1, pitch: 5 },
      ],
      transition: 9999,
      renderedSampleId: 'smp_1',
      renderedFor: 'x',
    });
    expect(e!.notes.map((n) => [n.from, n.to])).toEqual([[0, 1.5], [1.5, 2]]); // sorted, no overlap
    expect(e!.notes[1]).toMatchObject({ shift: 1200, drift: 1, vibrato: 0 });
    expect(e!.transition).toBe(300);
    expect(e!.renderedSampleId).toBe('smp_1');
  });

  it('the signature changes with the edit, not with the render fields; neutral edits are neutral', () => {
    const a: PitchEdit = { notes: [{ from: 0, to: 1, pitch: 60 }] };
    expect(isNeutralEdit(a)).toBe(true);
    const b = snapToKey({ notes: [{ from: 0, to: 1, pitch: 60.3 }] }, C_MAJOR);
    expect(isNeutralEdit(b)).toBe(false);
    expect(editSignature(b)).not.toBe(editSignature(a));
    expect(editSignature({ ...b, renderedSampleId: 's' as never, renderedFor: 'q' })).toBe(editSignature(b));
    expect(editSignature({ ...b, transition: 80 })).not.toBe(editSignature(b));
    expect(renderRange(a, 10)).toBeNull();
    const r = renderRange(b, 10)!;
    expect(r.from).toBeCloseTo(0, 6);
    expect(r.to).toBeCloseTo(1.3, 6);
  });
});

describe('shiftCurve', () => {
  const frames = (seconds: number, midi: number) => {
    const n = Math.round(seconds / 0.005);
    return { t0: 0, hop: 0.005, f0: new Float32Array(n).fill(440 * Math.pow(2, (midi - 69) / 12)), conf: new Float32Array(n).fill(1) };
  };

  it('moves a steady note by exactly its shift, with a glide at the borders', () => {
    const f = frames(2, 60.3);
    const edit: PitchEdit = { notes: [{ from: 0.5, to: 1.5, pitch: 60.3, shift: -30 }], transition: 40 };
    const c = shiftCurve(f, edit);
    expect(c[200]).toBeCloseTo(-30, 1); // middle of the note (t = 1.0)
    expect(c[10]).toBeCloseTo(0, 6); // before it
    expect(c[320]).toBeCloseTo(0, 6); // after it
    // The glide in: monotonic between 0 and −30 around t = 0.5.
    for (let i = 90; i < 108; i++) expect(c[i + 1]!).toBeLessThanOrEqual(c[i]! + 1e-4);
    // Zero transition: a hard step.
    const hard = shiftCurve(f, { ...edit, transition: 0 });
    expect(hard[99]).toBe(0);
    expect(hard[101]).toBeCloseTo(-30, 4);
  });

  it('flattens drift and scales vibrato in cents', () => {
    const n = 400;
    const f0 = new Float32Array(n);
    const cents = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i * 0.005;
      cents[i] = 6000 - 60 * (t / 2) + 40 * Math.sin(2 * Math.PI * 5.5 * t); // sag 60 cents + ±40 vibrato
      f0[i] = 440 * Math.pow(2, (cents[i]! / 100 - 69) / 12);
    }
    const f = { t0: 0, hop: 0.005, f0, conf: new Float32Array(n).fill(1) };
    const render = (e: { drift?: number; vibrato?: number }) => {
      const edit: PitchEdit = { notes: [{ from: 0, to: 2, pitch: 59.7, ...e }], transition: 0 };
      const c = shiftCurve(f, edit);
      // The corrected pitch line.
      const out = Float64Array.from({ length: n }, (_, i) => cents[i]! + c[i]!);
      const slow = (arr: Float64Array, a: number, b: number) => arr.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
      const spread = (arr: Float64Array) => {
        // Peak to peak of the deviation from a 34-frame moving average, in the middle of the note.
        const dev: number[] = [];
        for (let i = 60; i < 340; i++) dev.push(arr[i]! - slow(arr, i - 17, i + 17));
        return Math.max(...dev) - Math.min(...dev);
      };
      const drift = Math.abs(slow(out, 40, 80) - slow(out, 320, 360));
      return { drift, vibrato: spread(out) };
    };
    const asSung = render({});
    expect(asSung.drift).toBeGreaterThan(33);
    expect(asSung.vibrato).toBeGreaterThan(70);
    expect(render({ drift: 1 }).drift).toBeLessThan(6);
    expect(render({ drift: 0.5 }).drift).toBeGreaterThan(15);
    expect(render({ drift: 0.5 }).drift).toBeLessThan(27);
    expect(render({ vibrato: 0 }).vibrato).toBeLessThan(20);
    expect(render({ vibrato: 2 }).vibrato).toBeGreaterThan(140);
  });

  it('is zero everywhere for an edit that changes nothing', () => {
    const f = frames(1, 60);
    const c = shiftCurve(f, { notes: [{ from: 0, to: 1, pitch: 60 }] });
    expect(Array.from(c).every((v) => v === 0)).toBe(true);
  });
});

describe('renderPitchEdit (the whole chain on a sung phrase)', () => {
  it('snaps the sung notes onto the key within a few cents', () => {
    const { x } = phrase();
    const a = analyzePitch(x, SR);
    expect(a.notes.length).toBe(3);
    const edit = snapToKey(pitchEditFrom(a.notes), C_MAJOR, 1);
    const [y] = renderPitchEdit({ channels: [x], sampleRate: SR, start: 0, edit });
    const b = analyzePitch(y!, SR);
    expect(b.notes.length).toBe(3);
    [60, 64, 67].forEach((midi, i) => expect(Math.abs(b.notes[i]!.pitch - midi), `note ${i}`).toBeLessThan(0.06));
  });

  it('a partly snapped note lands part of the way; flattening takes the sag out; no vibrato removes the wobble', () => {
    const { x } = phrase();
    const a = analyzePitch(x, SR);
    const base = pitchEditFrom(a.notes);
    const half = snapToKey(base, C_MAJOR, 0.5);
    const [y] = renderPitchEdit({ channels: [x], sampleRate: SR, start: 0, edit: half });
    const b = analyzePitch(y!, SR);
    expect(Math.abs(b.notes[0]!.pitch - (60.3 - 0.15))).toBeLessThan(0.06);
    const calm = mapNotes(base, new Set([1]), (n) => ({ ...n, vibrato: 0 }));
    const [z] = renderPitchEdit({ channels: [x], sampleRate: SR, start: 0, edit: calm });
    const c = analyzePitch(z!, SR);
    expect(a.notes[1]!.vibratoDepth).toBeGreaterThan(50);
    expect(c.notes[1]!.vibratoDepth).toBe(0);
    // The untouched notes stayed (the first one is not even processed: same samples).
    for (let i = 0; i < Math.round(0.7 * SR); i += 311) expect(z![i]).toBeCloseTo(x[i]!, 5);
  });

  it('is deterministic, works on a stretch that starts late, and leaves silence silent', () => {
    const { x } = phrase();
    const a = analyzePitch(x, SR);
    const edit = snapToKey(pitchEditFrom(a.notes), C_MAJOR, 1);
    const one = renderPitchEdit({ channels: [x], sampleRate: SR, start: 0, edit });
    const two = renderPitchEdit({ channels: [x], sampleRate: SR, start: 0, edit });
    expect(Array.from(one[0]!)).toEqual(Array.from(two[0]!));
    // The same corrected audio when only the stretch from 0.9 s on is handed over (with its start time).
    const from = Math.round(0.9 * SR);
    const tail = renderPitchEdit({ channels: [x.slice(from)], sampleRate: SR, start: 0.9, edit });
    const b = analyzePitch(tail[0]!, SR, { start: 0.9 });
    expect(b.notes.map((n) => Math.round(n.pitch))).toEqual([64, 67]);
    expect(Math.abs(b.notes[1]!.pitch - 67)).toBeLessThan(0.06);
    const silent = renderPitchEdit({ channels: [new Float32Array(SR)], sampleRate: SR, start: 0, edit: { notes: [{ from: 0, to: 1, pitch: 60, shift: 100 }] } });
    expect(Math.max(...Array.from(silent[0]!, Math.abs))).toBe(0);
  });

  it('withTarget moves one note by hand (a drag in the editor)', () => {
    const e = withTarget({ from: 0, to: 1, pitch: 60.2 }, 62);
    expect(e.shift).toBeCloseTo(180, 6);
  });
});
