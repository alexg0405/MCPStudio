/**
 * The Clean up vocal window's before/after: the engine plays the clip as recorded (no cleanup render, and no pitch render
 * that was made from the cleaned sound) while the switch is on, without any change to the document, and the choice follows
 * the clip, not the project. Also the commands of the feature, and that every way in is there.
 */
import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { aiCommands } from '@app/ai/commands';
import { cleanupState } from '@app/cleanup/state';
import { createTestServices } from '@app/testing';
import { hearUncleaned } from '@app/actions/cleanup';
import { cleanupSignature } from '@core/audio/cleanup-edit';
import { editSignature } from '@core/audio/pitch-edit';
import type { AudioClip, ClipId, SampleId, SampleRef } from '@core/model/types';
import { setCleanup, setCleanupRender } from '@core/ops/cleanup';
import { setPitchEdit, setPitchRender } from '@core/ops/pitch';
import { hasCleanupRender, heardProject, uncleanedSound } from '@core/query/hear';
import { getMenuItems } from '../../shell/menus';
import { windowTypes } from '../../workspace/registry';
import { registerFeatures } from '..';

const SR = 48000;
const sample = (id: string, hash: string): SampleRef => ({ id: id as SampleId, name: id, source: { kind: 'embedded', hash: hash.repeat(64), ext: 'flac' } });

function setup() {
  const samples = new TestSamples();
  const ref = samples.add([new Float32Array(SR)], SR, 'vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 }]);
  const s = createTestServices();
  registerFeatures(s);
  s.history.load(project);
  const clipId = clipIds[0] as ClipId;
  const cleaned = sample('smp_cleaned', 'c');
  const pitched = sample('smp_pitched', 'd');
  s.history.transact('Clean up', (d) => {
    setCleanup(d, clipId, { noise: { amountDb: 12, sensitivity: 0.5 }, clicks: { sensitivity: 0.5 } });
    const cleanup = (d.playlist.clips[clipId] as AudioClip).cleanup!;
    setCleanupRender(d, clipId, cleaned, cleanupSignature(cleanup as never), {});
    setPitchEdit(d, clipId, { notes: [{ from: 0.1, to: 0.5, pitch: 60, shift: 100 }] });
    const edit = (d.playlist.clips[clipId] as AudioClip).pitchEdit!;
    setPitchRender(d, clipId, pitched, editSignature(edit as never));
  });
  const clip = () => s.doc.getState().project.playlist.clips[clipId] as AudioClip;
  const sent = () => s.fakeEngine.changes[s.fakeEngine.changes.length - 1]!.next.playlist.clips[clipId] as AudioClip;
  return { s, clipId, clip, sent, cleaned, pitched };
}

describe('before and after the cleanup', () => {
  it('uncleanedSound drops both renders for the clips asked and nothing else (memoized, the same project when nothing to do)', () => {
    const { s, clipId, cleaned } = setup();
    const p = s.doc.getState().project;
    expect(hasCleanupRender(p, clipId)).toBe(true);
    const before = uncleanedSound(p, [clipId]);
    const clip = before.playlist.clips[clipId] as AudioClip;
    expect(clip.cleanup?.renderedSampleId).toBeUndefined();
    expect(clip.pitchEdit?.renderedSampleId).toBeUndefined();
    expect(clip.cleanup?.noise).toEqual({ amountDb: 12, sensitivity: 0.5 });
    expect(clip.pitchEdit?.notes).toHaveLength(1);
    expect((p.playlist.clips[clipId] as AudioClip).cleanup?.renderedSampleId).toBe(cleaned.id);
    expect(uncleanedSound(p, [clipId])).toBe(before);
    expect(uncleanedSound(p, [])).toBe(p);
    expect(uncleanedSound(p, ['clip_none' as ClipId])).toBe(p);
    expect(heardProject(p, { audition: null, original: [], uncleaned: [] })).toBe(p);
  });

  it('the engine hears the recording while the switch is on; the document and undo are untouched', () => {
    const { s, clipId, clip, sent, cleaned, pitched } = setup();
    expect(sent().cleanup?.renderedSampleId).toBe(cleaned.id);
    const doc = s.doc.getState().project;
    const steps = s.history.steps().done.length;
    expect(hearUncleaned(s, clipId)).toBe(true);
    expect(sent().cleanup?.renderedSampleId).toBeUndefined();
    expect(sent().pitchEdit?.renderedSampleId).toBeUndefined();
    expect(clip().cleanup?.renderedSampleId).toBe(cleaned.id);
    expect(clip().pitchEdit?.renderedSampleId).toBe(pitched.id);
    expect(s.doc.getState().project).toBe(doc);
    expect(s.history.steps().done.length).toBe(steps);
    // A later edit still reaches the engine through the switch.
    s.history.transact('Rename lane', (d) => void (d.playlist.lanes[d.playlist.laneOrder[3]!]!.name = 'Vox'));
    expect(sent().cleanup?.renderedSampleId).toBeUndefined();
    expect(hearUncleaned(s, clipId)).toBe(false);
    expect(sent().cleanup?.renderedSampleId).toBe(cleaned.id);
    expect(sent().pitchEdit?.renderedSampleId).toBe(pitched.id);
  });

  it('the command switches, and a clip without a cleanup says so and keeps the engine as it was', async () => {
    const { s, clipId, sent } = setup();
    cleanupState.setState({ clipId });
    await s.commands.run('cleanup.toggleOriginal', {});
    expect(s.editor.getState().cleanupOriginal).toEqual([clipId]);
    expect(sent().cleanup?.renderedSampleId).toBeUndefined();
    await s.commands.run('cleanup.toggleOriginal', { original: false });
    expect(s.editor.getState().cleanupOriginal).toEqual([]);
    s.history.transact('Clear', (d) => setCleanup(d, clipId, null));
    await s.commands.run('cleanup.toggleOriginal', { clip: clipId });
    expect(s.editor.getState().cleanupOriginal).toEqual([]);
    cleanupState.setState({ clipId: null });
  });

  it('the switch clears when its clip goes away', () => {
    const { s, clipId } = setup();
    hearUncleaned(s, clipId, true);
    s.history.transact('Delete', (d) => void delete d.playlist.clips[clipId]);
    expect(s.editor.getState().cleanupOriginal).toEqual([]);
  });
});

describe('the ways in', () => {
  it('has the window, the clip menu entry, the Playlist and View menu entries, and commands the AI can see', () => {
    const { s } = setup();
    expect(windowTypes()).toContain('vocal-cleanup');
    const ids = (menu: string) => getMenuItems(menu).flatMap((i) => (i.kind === 'command' ? [i.command] : []));
    expect(ids('playlist')).toContain('cleanup.openClip');
    expect(ids('view')).toContain('cleanup.open');
    const catalog = aiCommands(s);
    for (const id of ['cleanup.openClip', 'cleanup.apply', 'cleanup.toggleOriginal', 'cleanup.hearRemoved', 'cleanup.learnNoise', 'cleanup.renderNow', 'cleanup.clear']) {
      expect(catalog.find((c) => c.id === id)?.argsHint, id).toBeTruthy();
    }
    // Every command and its menu entry carries a plain hint.
    for (const def of s.commands.list().filter((c) => c.id.startsWith('cleanup.'))) expect(def.hint?.length, def.id).toBeGreaterThan(20);
  });

  it('cleanup.apply sets the cleanup in one undo step, and cleanup.openClip puts the clip in the window', async () => {
    const { s, clipId } = setup();
    s.history.transact('Remove', (d) => setCleanup(d, clipId, null));
    const steps = s.history.steps().done.length;
    await s.commands.run('cleanup.apply', { clip: clipId, noise_db: 15, breaths_db: 9 });
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect((s.doc.getState().project.playlist.clips[clipId] as AudioClip).cleanup).toMatchObject({ noise: { amountDb: 15 }, breaths: { reduceDb: 9 } });
    s.editor.getState().selectClips([clipId]);
    await s.commands.run('cleanup.openClip', {});
    expect(cleanupState.getState().clipId).toBe(clipId);
    cleanupState.setState({ clipId: null });
  });
});
