import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { clipSampleId } from '../audio/playback';
import { History } from '../history/history';
import { newId } from '../model/ids';
import type { AlignEdit, AudioClip, ClipId, PitchEdit, Project, SampleRef } from '../model/types';
import { clearAlignRender, setAlign, setAlignRender } from './align';
import { setPitchEdit, setPitchRender } from './pitch';

function setup() {
  const samples = new TestSamples();
  const ref = samples.add([new Float32Array(48000)], 48000, 'double');
  const { project, clipIds, channelId } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
  let doc: Project = project;
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  const clipId = clipIds[0] as ClipId;
  const clip = () => doc.playlist.clips[clipId] as AudioClip;
  const render = (): SampleRef => ({
    id: newId.sample(),
    name: 'render',
    source: { kind: 'embedded', hash: (Math.random().toString(16).slice(2) + 'e'.repeat(64)).slice(0, 64), ext: 'flac' },
  });
  return { history, clipId, clip, doc: () => doc, channelId, render, ref };
}

const edit: AlignEdit = { mode: 'guide', guide: 'clp_lead' as ClipId, tightness: 70, pitch: 40 };

describe('alignment ops', () => {
  it('setAlign is one undo step and undo restores the earlier settings', () => {
    const t = setup();
    expect(t.history.transact('Align', (d) => setAlign(d, t.clipId, edit))).toBe(true);
    expect(t.clip().align).toMatchObject({ mode: 'guide', tightness: 70, pitch: 40 });
    t.history.transact('Align tighter', (d) => setAlign(d, t.clipId, { ...edit, tightness: 95 }));
    expect(t.clip().align?.tightness).toBe(95);
    t.history.undo();
    expect(t.clip().align?.tightness).toBe(70);
    t.history.undo();
    expect(t.clip().align).toBeUndefined();
  });

  it('a render is folded into the settings’ step, replaces the earlier one (which goes with its sample) and undo brings both back', () => {
    const t = setup();
    t.history.transact('Align', (d) => setAlign(d, t.clipId, edit));
    const first = t.render();
    t.history.transact('Aligned', (d) => setAlignRender(d, t.clipId, first, 'sig1', [0, 5, 1, -5]), { amend: t.history.status().cursor });
    expect(t.history.status().undoLabel).toBe('Align');
    expect(t.clip().align?.renderedSampleId).toBe(first.id);
    expect(t.clip().align?.warp).toEqual([0, 5, 1, -5]);
    expect(clipSampleId({ sampleId: t.ref.id }, t.clip())).toBe(first.id);
    // Changing the settings keeps the old render (out of date) until the new one comes.
    t.history.transact('Align tighter', (d) => setAlign(d, t.clipId, { ...edit, tightness: 90 }));
    expect(t.clip().align?.renderedSampleId).toBe(first.id);
    expect(t.clip().align?.renderedFor).toBe('sig1');
    const second = t.render();
    t.history.transact('Aligned', (d) => setAlignRender(d, t.clipId, second, 'sig2', [0, 1, 1, 1]), { amend: t.history.status().cursor });
    expect(t.doc().samples[first.id]).toBeUndefined();
    expect(t.doc().samples[second.id]).toBeDefined();
    t.history.undo();
    expect(t.clip().align?.renderedSampleId).toBe(first.id);
    expect(t.doc().samples[first.id]).toBeDefined();
    expect(t.doc().samples[second.id]).toBeUndefined();
  });

  it('removing the alignment drops the render and plays the channel’s own sample again', () => {
    const t = setup();
    t.history.transact('Align', (d) => setAlign(d, t.clipId, edit));
    const render = t.render();
    t.history.transact('Aligned', (d) => setAlignRender(d, t.clipId, render, 's', [0, 1, 1, 1]));
    t.history.transact('Remove alignment', (d) => setAlign(d, t.clipId, null));
    expect(t.clip().align).toBeUndefined();
    expect(t.doc().samples[render.id]).toBeUndefined();
    expect(clipSampleId({ sampleId: t.ref.id }, t.clip())).toBe(t.ref.id);
    t.history.undo();
    expect(t.doc().samples[render.id]).toBeDefined();
    expect(t.clip().align?.renderedSampleId).toBe(render.id);
  });

  it('clearAlignRender keeps the settings but forgets the render and the overlay', () => {
    const t = setup();
    t.history.transact('Align', (d) => setAlign(d, t.clipId, edit));
    const render = t.render();
    t.history.transact('Aligned', (d) => setAlignRender(d, t.clipId, render, 's', [0, 1, 1, 1]));
    t.history.transact('Clear', (d) => clearAlignRender(d, t.clipId));
    expect(t.clip().align).toMatchObject({ mode: 'guide', tightness: 70 });
    expect(t.clip().align?.renderedSampleId).toBeUndefined();
    expect(t.clip().align?.warp).toBeUndefined();
    expect(t.doc().samples[render.id]).toBeUndefined();
  });

  it('plays the pitch render before the alignment render, and a pitch render never drops the alignment’s sample (or the other way round)', () => {
    const t = setup();
    t.history.transact('Align', (d) => setAlign(d, t.clipId, edit));
    const aligned = t.render();
    t.history.transact('Aligned', (d) => setAlignRender(d, t.clipId, aligned, 's', [0, 1, 1, 1]));
    const pitch: PitchEdit = { notes: [{ from: 0.1, to: 0.6, pitch: 60, shift: 50 }] };
    t.history.transact('Pitch', (d) => setPitchEdit(d, t.clipId, pitch));
    const tuned = t.render();
    t.history.transact('Tuned', (d) => setPitchRender(d, t.clipId, tuned, 'p'));
    expect(clipSampleId({ sampleId: t.ref.id }, t.clip())).toBe(tuned.id);
    // Without the pitch render the clip plays the aligned sound.
    t.history.transact('Remove pitch', (d) => setPitchEdit(d, t.clipId, null));
    expect(clipSampleId({ sampleId: t.ref.id }, t.clip())).toBe(aligned.id);
    expect(t.doc().samples[aligned.id]).toBeDefined();
    expect(t.doc().samples[tuned.id]).toBeUndefined();
  });

  it('ignores a clip that is not audio and a render for a clip with no alignment', () => {
    const t = setup();
    const render = t.render();
    t.history.transact('Aligned', (d) => setAlignRender(d, t.clipId, render, 's', []));
    expect(t.clip().align).toBeUndefined();
    expect(t.doc().samples[render.id]).toBeUndefined();
    expect(t.history.transact('Align', (d) => setAlign(d, 'nope' as ClipId, edit))).toBe(false);
  });
});
