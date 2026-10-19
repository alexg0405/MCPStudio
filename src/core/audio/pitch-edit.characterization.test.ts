/**
 * Characterization of the pitch editor's maths: the shift curve of seeded edits (shifts, drift flattening, vibrato
 * scaling, glides), the edit operations (split, merge, snap, actions, sanitising) and the rendered audio of synthetic
 * voices (exact float bits). It exists so pitch-edit.ts can be reorganised without changing a sample.
 *
 * If a deliberate change makes it fail, review the cause and regenerate the snapshots with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import type { PitchEdit, PitchEditNote } from '../model/types';
import { analyzePitch, type PitchFrames } from '../voice/pitch-notes';
import { mulberry32, noiseFloor, synthHum } from '../voice/test-signals';
import {
  applyPitchAction,
  editSignature,
  isNeutralEdit,
  mergeNotes,
  nearestAllowed,
  pitchEditFrom,
  renderPitchEdit,
  renderRange,
  type PitchAction,
  sanitizePitchEdit,
  shiftCurve,
  snapToKey,
  splitNote,
  tidyNote,
  withTarget,
} from './pitch-edit';

async function hashOf(values: Float32Array | Float64Array): Promise<string> {
  const hash = await sha256Hex(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  return hash.slice(0, 12);
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A sung track with vibrato at 5 ms frames. */
function frames(seed: number): PitchFrames {
  const rand = mulberry32(seed);
  const hop = 0.005;
  const f0: number[] = [];
  let midi = 55 + Math.floor(rand() * 8);
  for (let n = 0; n < 4; n++) {
    const next = midi + Math.round((rand() - 0.5) * 6);
    const count = 60 + Math.floor(rand() * 80);
    for (let i = 0; i < count; i++) {
      const base = i < 10 ? midi + ((next - midi) * i) / 10 : next;
      f0.push(midiToHz(base + 0.4 * Math.sin(2 * Math.PI * 5.5 * i * hop) + 0.1 * Math.sin(i / 17)));
    }
    for (let i = 0; i < Math.floor(rand() * 8); i++) f0.push(0);
    midi = next;
  }
  return { t0: 0.05, hop, f0: Float32Array.from(f0), conf: new Float32Array(f0.length).fill(0.9) };
}

function randomEdit(seed: number, f: PitchFrames): PitchEdit {
  const rand = mulberry32(seed * 13);
  const duration = f.f0.length * f.hop;
  const notes: PitchEditNote[] = [];
  let at = 0.1;
  while (at < duration - 0.3) {
    const to = at + 0.15 + rand() * 0.4;
    const note: PitchEditNote = { from: at, to, pitch: 55 + Math.round(rand() * 12) };
    if (rand() < 0.6) note.shift = Math.round((rand() - 0.5) * 600);
    if (rand() < 0.4) note.drift = rand();
    if (rand() < 0.4) note.vibrato = rand() * 2;
    notes.push(note);
    at = to + rand() * 0.1;
  }
  const edit: PitchEdit = { notes };
  if (rand() < 0.5) edit.transition = Math.round(rand() * 120);
  return edit;
}

describe('pitch edit characterization', () => {
  it('computes the same shift curves', async () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const f = frames(seed);
      const edit = randomEdit(seed, f);
      const curve = shiftCurve(f, edit);
      lines.push(`#${seed}: ${edit.notes.length} notes, ${curve.length} frames, shift hash ${await hashOf(curve)}`);
      lines.push(
        `#${seed} range ${JSON.stringify(renderRange(edit, f.f0.length * f.hop))} neutral ${isNeutralEdit(edit)} signature ${editSignature(edit)}`,
      );
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/pitch-edit-curves.txt');
  });

  it('applies the same edit operations', () => {
    const lines: string[] = [];
    const round = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x));
    for (let seed = 1; seed <= 12; seed++) {
      const f = frames(seed);
      const edit = randomEdit(seed, f);
      const detected = edit.notes.map((n) => ({
        from: n.from,
        to: n.to,
        pitch: n.pitch + 0.0004,
        drift: 0,
        vibratoDepth: 0,
        vibratoRate: 0,
      }));
      lines.push(`#${seed} from detected: ${round(pitchEditFrom(detected))}`);
      lines.push(`#${seed} split: ${round(splitNote(edit, (edit.notes[1]?.from ?? 0) + 0.1, f))}`);
      lines.push(`#${seed} merge: ${round(mergeNotes(edit, 0, f))}`);
      lines.push(`#${seed} tidy: ${round(edit.notes.map(tidyNote))}`);
      lines.push(`#${seed} target: ${round(edit.notes.map((n) => withTarget(n, 62.3)))}`);
      const allowed = [true, false, true, false, true, true, false, true, false, true, false, true];
      const actions: PitchAction[] = [
        { kind: 'snap', allowed, strength: 0.7 },
        { kind: 'drift', amount: 0.8 },
        { kind: 'vibrato', amount: 0.3 },
        { kind: 'shift', semitones: 2 },
        { kind: 'to', midi: 62.3 },
        { kind: 'transition', ms: 80 },
        { kind: 'transition', ms: 25 },
        { kind: 'reset' },
      ];
      for (const action of actions) {
        lines.push(
          `#${seed} ${action.kind}: ${round(applyPitchAction(edit, action, seed % 2 ? 'all' : new Set([0, 2])))}`,
        );
      }
      lines.push(`#${seed} snapToKey: ${round(snapToKey(edit, allowed, 0.6, new Set([1, 3])))}`);
    }
    const scale = [true, false, true, false, true, true, false, true, false, true, false, true];
    lines.push(`nearestAllowed: ${[60.2, 61.5, 70.9].map((p) => nearestAllowed(p, scale)).join(' ')}`);
    lines.push(
      `sanitize: ${round(sanitizePitchEdit({ notes: [{ from: 1, to: 0.5, pitch: 60 }, { from: 0, to: 1, pitch: 61, shift: 5000, drift: 3, vibrato: -1 }, 'x', null], transition: 9999, renderedSampleId: 3 }))} ${round(sanitizePitchEdit(7))}`,
    );
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });

  it('renders the same audio', async () => {
    const lines: string[] = [];
    for (const sr of [44100, 22050]) {
      const hum = synthHum(sr, { hz: 196, durationSec: 1.2, legato: [[247, 0.6]] });
      const x = noiseFloor(sr, 1.6, -50, 3);
      hum.forEach((v, i) => {
        x[i + Math.round(0.2 * sr)] = (x[i + Math.round(0.2 * sr)] as number) + v * 0.7;
      });
      const analysis = analyzePitch(x, sr);
      const base = pitchEditFrom(analysis.notes);
      const edits: PitchEdit[] = [
        { ...base, notes: base.notes.map((n) => ({ ...n, shift: 200 })) },
        { ...base, notes: base.notes.map((n) => ({ ...n, drift: 1, vibrato: 0 })), transition: 60 },
        { ...base, notes: base.notes.map((n, i) => (i === 0 ? { ...n, shift: -350 } : n)) },
        base,
      ];
      for (const [i, edit] of edits.entries()) {
        const out = renderPitchEdit({ channels: [x, x.map((v) => v * 0.5)], sampleRate: sr, start: 0, edit });
        lines.push(
          `${sr} Hz edit ${i}: ${base.notes.length} notes ${await hashOf(out[0] as Float32Array)} ${await hashOf(out[1] as Float32Array)}`,
        );
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/pitch-edit-render.txt');
  });
});
