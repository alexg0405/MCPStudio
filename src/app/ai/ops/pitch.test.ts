import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { sing } from '../../../../test/helpers/voice';
import type { AudioClip, ClipId } from '@core/model/types';
import { analyzeClip, currentEdit } from '../../actions/pitch';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

const SR = 48000;

function setup(key: { root: number; scale: string } | null = { root: 0, scale: 'major' }) {
  const x = sing(
    [
      { from: 0.1, to: 0.8, midi: 60.3 },
      { from: 1.0, to: 1.8, midi: 63.4 },
      { from: 2.0, to: 2.8, midi: 67.2 },
    ],
    SR,
    3,
  );
  const samples = new TestSamples();
  const ref = samples.add([x], SR, 'lead vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 3840, length: 3840 * 2 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('lead vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
  s.history.load({ ...project, transport: { ...project.transport, ...(key ? { key } : {}) } });
  return { s, clipId: clipIds[0] as ClipId };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const clipOf = (s: ReturnType<typeof createTestServices>, id: ClipId) => s.doc.getState().project.playlist.clips[id] as AudioClip;

describe('the pitch action and get_pitch', () => {
  it('before the clip is analysed, the read starts the analysis and the action waits for it (an app command)', async () => {
    const { s, clipId } = setup();
    const first = runReadTool(s, 'get_pitch', { clip: clipId }) as { state: string };
    expect(first.state).toBe('analyzing');
    // A moment later the notes are there.
    await analyzeClip(s, clipId);
    const read = runReadTool(s, 'get_pitch', { clip: clipId }) as { state: string; notes: Array<Record<string, unknown>>; song_key: string };
    expect(read.state).toBe('ready');
    expect(read.song_key).toBe('C major');
    expect(read.notes.map((n) => n.note)).toEqual(['C4', 'D#4', 'G4']);
    expect(read.notes[0]).toMatchObject({ n: 1, cents_off: 30, in_key: true });
    // The clip starts at bar 2 and the first note 0.1 s in (a 16th of a bar... 2 s per bar at 120 BPM).
    expect(read.notes[0]!.bar as number).toBeCloseTo(2.05, 1);
    expect(read.notes[1]).toMatchObject({ in_key: false });
  });

  it('a never-analysed clip: the action asks the app to listen first, then change', () => {
    const { s, clipId } = setup();
    const res = run(s, [{ op: 'pitch', action: 'snap_to_key', clip: clipId, strength: 80 }]);
    expect(res.warnings).toEqual([]);
    expect(res.after).toContainEqual({
      kind: 'command',
      id: 'pitchEditor.apply',
      args: { clip: clipId, action: 'snap_to_key', strength: 80 },
      gesture: false,
    });
    expect(currentEdit(s.doc.getState().project, clipId)).toBeNull();
  });

  it('snaps to the song key at a strength, flattens, shifts one note and clears: one undo step each answer', async () => {
    const { s, clipId } = setup();
    await analyzeClip(s, clipId);
    const steps = () => s.history.steps().done.length;
    const n0 = steps();
    const snap = run(s, [{ op: 'pitch', action: 'snap_to_key', clip: clipId, strength: 50 }]);
    expect(snap.warnings).toEqual([]);
    expect(steps()).toBe(n0 + 1);
    const edit = currentEdit(s.doc.getState().project, clipId)!;
    expect(edit.notes[0]?.shift).toBeCloseTo(-15, 0); // half way from +30 cents to C4
    expect(edit.notes[1]?.shift).toBeCloseTo(30, 0); // the nearest note of C major to D#4 + 40 ct is E4 (60 ct up), half of it
    const full = run(s, [{ op: 'pitch', action: 'snap_to_key', clip: clipId, key: 'A minor' }]);
    expect(full.warnings).toEqual([]);
    expect(steps()).toBe(n0 + 2);
    const flat = run(s, [
      { op: 'pitch', action: 'flatten_drift', clip: clipId, notes: [2] },
      { op: 'pitch', action: 'vibrato', clip: clipId, amount: 0, notes: [2, 3] },
    ]);
    expect(flat.warnings).toEqual([]);
    expect(steps()).toBe(n0 + 3);
    const e2 = currentEdit(s.doc.getState().project, clipId)!;
    expect(e2.notes[1]).toMatchObject({ drift: 1, vibrato: 0 });
    expect(e2.notes[0]?.drift).toBeUndefined();
    const move = run(s, [{ op: 'pitch', action: 'shift', clip: clipId, notes: [3], semitones: -1 }]);
    expect(move.warnings).toEqual([]);
    const e3 = currentEdit(s.doc.getState().project, clipId)!;
    expect(e3.notes[2]!.pitch + (e3.notes[2]!.shift ?? 0) / 100).toBeCloseTo(e2.notes[2]!.pitch + (e2.notes[2]!.shift ?? 0) / 100 - 1, 5);
    // Bars: only notes starting in bar 1 (the clip starts at bar 2 of the song: its first note is at bar 2).
    const none = run(s, [{ op: 'pitch', action: 'reset', clip: clipId, from_bar: 40, to_bar: 41 }]);
    expect(none.warnings.join(' ')).toMatch(/no notes start in bars 40–41/);
    const gone = run(s, [{ op: 'pitch', action: 'clear', clip: clipId }]);
    expect(gone.warnings).toEqual([]);
    expect(clipOf(s, clipId).pitchEdit).toBeUndefined();
    // Undo takes the removal back.
    s.history.undo();
    expect(clipOf(s, clipId).pitchEdit).toBeDefined();
  });

  it('says what is wrong in plain words', async () => {
    const { s, clipId } = setup(null);
    await analyzeClip(s, clipId);
    expect(run(s, [{ op: 'pitch', action: 'snap_to_key', clip: clipId }]).warnings.join(' ')).toMatch(/no song key/);
    expect(run(s, [{ op: 'pitch', action: 'snap_to_key', clip: clipId, key: 'H flat' }]).warnings.join(' ')).toMatch(/unreadable key/);
    expect(run(s, [{ op: 'pitch', action: 'vibrato', clip: clipId }]).warnings.join(' ')).toMatch(/vibrato needs amount/);
    expect(run(s, [{ op: 'pitch', action: 'shift', clip: clipId, notes: [9], semitones: 1 }]).warnings.join(' ')).toMatch(/has 3 notes/);
    expect(run(s, [{ op: 'pitch', action: 'dance', clip: clipId }]).warnings.join(' ')).toMatch(/unknown pitch action/);
    expect(run(s, [{ op: 'pitch', action: 'reset', clip: 'clip_nope' }]).warnings.join(' ')).toMatch(/no clip/);
    s.history.transact('reverse', (d) => {
      const ch = Object.values(d.channels)[0];
      if (ch?.kind === 'audioClip') ch.reverse = true;
    });
    expect(run(s, [{ op: 'pitch', action: 'reset', clip: clipId }]).warnings.join(' ')).toMatch(/Reverse/);
  });
});
