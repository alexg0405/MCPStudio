import { afterEach, describe, expect, it } from 'vitest';
import { sing } from '../../../test/helpers/sung';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { editSignature } from '@core/audio/pitch-edit';
import { collectHashes } from '@core/gc/refs';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { createPitchAnalysisStore, setPitchAnalysisStore, type PitchAnalysisStore } from '../pitch/analysis-store';
import { memoryKv } from '../storage/kv';
import { pitchState } from '../pitch/state';
import { createTestServices } from '../testing';
import {
  analyzeClip,
  clearClipPitch,
  clearPitchAnalysisMemory,
  commitEdit,
  currentEdit,
  editFor,
  loadPitchClip,
  mergeAt,
  moveNote,
  resetNotes,
  setNoteSettings,
  snapClip,
  splitAt,
  startPitchRenderer,
} from './pitch';

const SR = 48000;

async function setup() {
  const x = sing(
    [
      { from: 0.1, to: 0.8, midi: 60.3 },
      { from: 1.0, to: 1.8, midi: 64 - 0.35 },
    ],
    SR,
    2.2,
  );
  const samples = new TestSamples();
  const ref = samples.add([x], SR, 'vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
  s.history.load(project);
  return { s, clipId: clipIds[0] as ClipId, x };
}

const clipOf = (p: Project, id: ClipId) => p.playlist.clips[id] as AudioClip;
async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  pitchState.setState({ clipId: null, phase: 'none', clip: null, selected: [], rendering: null, message: '' });
});

describe('pitch editing actions', () => {
  it('analyses a clip (cached) into its notes', async () => {
    const { s, clipId } = await setup();
    const a = await analyzeClip(s, clipId);
    expect(a.analysis.notes.map((n) => Math.round(n.pitch))).toEqual([60, 64]);
    expect(a.range.from).toBeLessThanOrEqual(0.05);
    const b = await analyzeClip(s, clipId);
    expect(b.analysis).toBe(a.analysis);
  });

  it('keeps the analysis between sessions: a stored one is used for the same sample, range and version', async () => {
    const kv = memoryKv();
    const store = createPitchAnalysisStore(kv);
    setPitchAnalysisStore(store);
    try {
      const { s, clipId } = await setup();
      clearPitchAnalysisMemory();
      const a = await analyzeClip(s, clipId);
      // Written in the background, after the answer.
      await until(() => kv.data.size === 1);
      const [key] = [...kv.data.keys()];
      expect(key).toMatch(/^pitch-analysis:v\d+:48000:0\.\d\d:\d\.\d\d:[0-9a-f]{64}$/);
      // A new session (memory forgotten) reads it back instead of listening again: prove it by what the store holds.
      const marked = { ...a.analysis, notes: a.analysis.notes.map((n) => ({ ...n, pitch: n.pitch + 5 })) };
      await store.set(key as string, marked);
      clearPitchAnalysisMemory();
      const b = await analyzeClip(s, clipId);
      expect(b.analysis.notes[0]!.pitch).toBeCloseTo(a.analysis.notes[0]!.pitch + 5, 6);
      // A different version's key is a different entry: nothing is read for it.
      expect(await store.get((key as string).replace(/:v\d+:/, ':v0:'))).toBeNull();
    } finally {
      setPitchAnalysisStore(null);
      clearPitchAnalysisMemory();
    }
  });

  it('a damaged or failing store is only a missed shortcut', async () => {
    const broken: PitchAnalysisStore = {
      get: () => Promise.reject(new Error('disk')),
      set: () => Promise.reject(new Error('disk')),
    };
    setPitchAnalysisStore(broken);
    try {
      const { s, clipId } = await setup();
      clearPitchAnalysisMemory();
      const a = await analyzeClip(s, clipId);
      expect(a.analysis.notes.length).toBe(2);
    } finally {
      setPitchAnalysisStore(null);
      clearPitchAnalysisMemory();
    }
  });

  it('refuses reversed audio with a plain message', async () => {
    const { s, clipId } = await setup();
    s.history.transact('reverse', (d) => {
      const c = d.playlist.clips[clipId] as AudioClip;
      const ch = d.channels[c.channelId];
      if (ch?.kind === 'audioClip') ch.reverse = true;
    });
    await expect(analyzeClip(s, clipId)).rejects.toThrow(/Reverse/);
    await loadPitchClip(s, clipId);
    expect(pitchState.getState().phase).toBe('error');
  });

  it('every editor operation is exactly one undo step', async () => {
    const { s, clipId } = await setup();
    const clip = await analyzeClip(s, clipId);
    const steps = () => s.history.steps().done.length;
    const n0 = steps();
    expect(snapClip(s, clip, { root: 0, scale: 'major' }, 1)).toBe(true);
    expect(steps()).toBe(n0 + 1);
    expect(moveNote(s, clip, 0, 62)).toBe(true);
    expect(steps()).toBe(n0 + 2);
    expect(setNoteSettings(s, clip, new Set([1]), { drift: 1 }, 'Flatten drift')).toBe(true);
    expect(steps()).toBe(n0 + 3);
    expect(setNoteSettings(s, clip, 'all', { vibrato: 0.5 }, 'Vibrato')).toBe(true);
    expect(steps()).toBe(n0 + 4);
    expect(splitAt(s, clip, 0.45)).toBe(true);
    expect(steps()).toBe(n0 + 5);
    expect(currentEdit(s.doc.getState().project, clipId)?.notes).toHaveLength(3);
    expect(mergeAt(s, clip, 0)).toBe(true);
    expect(steps()).toBe(n0 + 6);
    expect(resetNotes(s, clip, 'all')).toBe(true);
    expect(steps()).toBe(n0 + 7);
    // Undo walks back one at a time.
    s.history.undo();
    expect(currentEdit(s.doc.getState().project, clipId)?.notes[0]?.shift).toBeDefined();
    for (let i = 0; i < 6; i++) s.history.undo();
    expect(currentEdit(s.doc.getState().project, clipId)).toBeNull();
    expect(clearClipPitch(s, clipId)).toBe(false);
  });

  it('a drag of a slider (same merge key) is one undo step', async () => {
    const { s, clipId } = await setup();
    const clip = await analyzeClip(s, clipId);
    const n0 = s.history.steps().done.length;
    for (const v of [0.1, 0.3, 0.5, 0.9]) setNoteSettings(s, clip, new Set([0]), { drift: v }, 'Flatten drift', 'k');
    expect(s.history.steps().done.length).toBe(n0 + 1);
    expect(currentEdit(s.doc.getState().project, clipId)?.notes[0]?.drift).toBeCloseTo(0.9, 6);
  });

  it('renders the corrected audio after an edit, in the same undo step; undo restores edit and render', async () => {
    const { s, clipId, x } = await setup();
    stop = startPitchRenderer(s);
    const clip = await analyzeClip(s, clipId);
    commitEdit(s, clipId, { notes: editFor(s.doc.getState().project, clip).notes }, 'Start');
    const steps0 = s.history.steps().done.length;
    snapClip(s, clip, { root: 0, scale: 'major' }, 1);
    expect(s.history.steps().done.length).toBe(steps0 + 1);
    const first = () => clipOf(s.doc.getState().project, clipId).pitchEdit;
    expect(first()?.renderedSampleId).toBeUndefined();
    await until(() => !!first()?.renderedSampleId);
    const p = s.doc.getState().project;
    const edit = first()!;
    expect(edit.renderedFor).toBe(editSignature(edit));
    const sample = p.samples[edit.renderedSampleId!]!;
    expect(sample.source.kind).toBe('embedded');
    // Stored audio is kept while a stored value names its hash: the project does, so the clean-up leaves it.
    expect(collectHashes(p).has(sample.source.kind === 'embedded' ? sample.source.hash : '')).toBe(true);
    // Undo's patches name it too (history keeps what undo could bring back).
    expect(s.history.referencedHashes().has(sample.source.kind === 'embedded' ? sample.source.hash : '')).toBe(true);
    expect(sample.durationSec).toBeCloseTo(x.length / SR, 6);
    // The render came out as the same undo step as the edit.
    expect(s.history.steps().done.length).toBe(steps0 + 1);
    // Second edit: its render replaces the first; the old sample goes.
    const old = edit.renderedSampleId!;
    moveNote(s, clip, 0, 62);
    await until(() => first()?.renderedSampleId !== undefined && first()?.renderedSampleId !== old);
    expect(s.doc.getState().project.samples[old]).toBeUndefined();
    // Undo goes back to the first edit with its own render.
    s.history.undo();
    expect(first()?.renderedSampleId).toBe(old);
    expect(s.doc.getState().project.samples[old]).toBeDefined();
    // Undo does not start a render of its own (it is already consistent).
    await new Promise((r) => setTimeout(r, 700));
    expect(first()?.renderedSampleId).toBe(old);
    // Removing every correction takes the render out of the project.
    clearClipPitch(s, clipId);
    expect(s.doc.getState().project.samples[old]).toBeUndefined();
  });
});
