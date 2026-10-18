/**
 * The Pitch editor's A/B: the engine plays the clip's original recording instead of its corrected render while the
 * switch is on, without any change to the document, and the choice follows the clip, not the project.
 */
import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { aiCommands } from '@app/ai/commands';
import { pitchState } from '@app/pitch/state';
import { createTestServices } from '@app/testing';
import { hearOriginal } from '@app/actions/pitch';
import { pitchReport } from '@app/pitch/report';
import { editSignature } from '@core/audio/pitch-edit';
import type { AudioClip, ClipId, SampleId, SampleRef } from '@core/model/types';
import { setPitchEdit, setPitchRender } from '@core/ops/pitch';
import { hasPitchRender, heardProject, originalSound } from '@core/query/hear';
import { registerFeatures } from '..';

const SR = 48000;

function setup() {
  const samples = new TestSamples();
  const ref = samples.add([new Float32Array(SR)], SR, 'vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 }]);
  const s = createTestServices();
  registerFeatures(s);
  s.history.load(project);
  const clipId = clipIds[0] as ClipId;
  const render: SampleRef = { id: 'smp_render' as SampleId, name: 'render', source: { kind: 'embedded', hash: 'c'.repeat(64), ext: 'flac' } };
  s.history.transact('Correct', (d) => {
    setPitchEdit(d, clipId, { notes: [{ from: 0.1, to: 0.5, pitch: 60, shift: 100 }] });
    const edit = (d.playlist.clips[clipId] as AudioClip).pitchEdit!;
    setPitchRender(d, clipId, render, editSignature(edit as never));
  });
  const clip = () => s.doc.getState().project.playlist.clips[clipId] as AudioClip;
  const sent = () => s.fakeEngine.changes[s.fakeEngine.changes.length - 1]!.next.playlist.clips[clipId] as AudioClip;
  return { s, clipId, clip, sent, ref, render };
}

describe('A/B: original or corrected', () => {
  it('originalSound drops the render for the clips asked and nothing else (memoized, same project when nothing to do)', () => {
    const { s, clipId } = setup();
    const p = s.doc.getState().project;
    expect(hasPitchRender(p, clipId)).toBe(true);
    const o = originalSound(p, [clipId]);
    expect((o.playlist.clips[clipId] as AudioClip).pitchEdit?.renderedSampleId).toBeUndefined();
    expect((o.playlist.clips[clipId] as AudioClip).pitchEdit?.notes).toEqual((p.playlist.clips[clipId] as AudioClip).pitchEdit?.notes);
    expect(originalSound(p, [clipId])).toBe(o);
    expect(originalSound(p, [])).toBe(p);
    expect(originalSound(p, ['clip_none' as ClipId])).toBe(p);
    expect(heardProject(p, { audition: null, original: [] })).toBe(p);
  });

  it('the engine hears the original while the switch is on; the document and undo are untouched', () => {
    const { s, clipId, clip, sent, render } = setup();
    expect(sent().pitchEdit?.renderedSampleId).toBe(render.id);
    const doc = s.doc.getState().project;
    const steps = s.history.steps().done.length;
    expect(hearOriginal(s, clipId)).toBe(true);
    expect(sent().pitchEdit?.renderedSampleId).toBeUndefined();
    expect(clip().pitchEdit?.renderedSampleId).toBe(render.id);
    expect(s.doc.getState().project).toBe(doc);
    expect(s.history.steps().done.length).toBe(steps);
    // A later edit still reaches the engine through the switch.
    s.history.transact('Rename lane', (d) => void (d.playlist.lanes[d.playlist.laneOrder[3]!]!.name = 'Vox'));
    expect(sent().pitchEdit?.renderedSampleId).toBeUndefined();
    // And back.
    expect(hearOriginal(s, clipId)).toBe(false);
    expect(sent().pitchEdit?.renderedSampleId).toBe(render.id);
  });

  it('the command switches, B is bound in the editor, and a clip without a correction says so', async () => {
    const { s, clipId, sent } = setup();
    expect(s.keymap.match('B', { focus: 'pitch-editor', inInput: false })?.command).toBe('pitchEditor.toggleOriginal');
    expect(s.keymap.match('B', { focus: 'playlist', inInput: false })?.command).not.toBe('pitchEditor.toggleOriginal');
    pitchState.setState({ clipId });
    await s.commands.run('pitchEditor.toggleOriginal', {});
    expect(s.editor.getState().pitchOriginal).toEqual([clipId]);
    expect(sent().pitchEdit?.renderedSampleId).toBeUndefined();
    await s.commands.run('pitchEditor.toggleOriginal', { original: false });
    expect(s.editor.getState().pitchOriginal).toEqual([]);
    // No correction: a message, no state.
    s.history.transact('Clear', (d) => setPitchEdit(d, clipId, null));
    await s.commands.run('pitchEditor.toggleOriginal', { clip: clipId });
    expect(s.editor.getState().pitchOriginal).toEqual([]);
    pitchState.setState({ clipId: null });
  });

  it('the AI and MCP reach it through the command catalog, and get_pitch says which sound is heard', () => {
    const { s, clipId } = setup();
    expect(aiCommands(s).find((c) => c.id === 'pitchEditor.toggleOriginal')?.argsHint).toMatch(/original: true/);
    hearOriginal(s, clipId, true);
    const report = pitchReport(s, { clip: clipId }) as { hearing?: string };
    expect(report.hearing).toBe('original recording');
    hearOriginal(s, clipId, false);
    expect((pitchReport(s, { clip: clipId }) as { hearing?: string }).hearing).toBe('corrected sound');
  });

  it('is cleared when the clip goes away', () => {
    const { s, clipId } = setup();
    hearOriginal(s, clipId, true);
    s.history.transact('Delete', (d) => void delete d.playlist.clips[clipId]);
    expect(s.editor.getState().pitchOriginal).toEqual([]);
  });
});
