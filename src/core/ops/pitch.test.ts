import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { clipSampleId } from '../audio/playback';
import { editSignature, snapToKey } from '../audio/pitch-edit';
import { History } from '../history/history';
import type { AudioClip, PitchEdit, Project, SampleRef } from '../model/types';
import { newId } from '../model/ids';
import { clearPitchRender, setPitchEdit, setPitchRender } from './pitch';
import { splitClip } from './playlist';
import { constantTempo } from '../time/ppq';

const MAJOR = [true, false, true, false, true, true, false, true, false, true, false, true];

function setup() {
  const samples = new TestSamples();
  const ref = samples.add([new Float32Array(48000)], 48000, 'vocal');
  const { project, clipIds, channelId } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
  let doc: Project = project;
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  const clipId = clipIds[0]!;
  const clip = () => doc.playlist.clips[clipId] as AudioClip;
  const render = (name = 'render'): SampleRef => ({
    id: newId.sample(),
    name,
    source: { kind: 'embedded', hash: (Math.random().toString(16).slice(2) + 'f'.repeat(64)).slice(0, 64), ext: 'flac' },
  });
  return { history, clipId, clip, doc: () => doc, ref, channelId, render };
}

const sung: PitchEdit = { notes: [{ from: 0.1, to: 0.6, pitch: 60.3 }, { from: 0.7, to: 1, pitch: 63.8 }] };

describe('pitch edit ops', () => {
  it('setPitchEdit is one undo step and undo restores the earlier edit', () => {
    const t = setup();
    expect(t.history.transact('Pitch edit', (d) => setPitchEdit(d, t.clipId, sung))).toBe(true);
    expect(t.clip().pitchEdit?.notes).toHaveLength(2);
    const snapped = snapToKey(sung, MAJOR);
    t.history.transact('Snap to key', (d) => setPitchEdit(d, t.clipId, snapped));
    expect(t.clip().pitchEdit?.notes[0]?.shift).toBeCloseTo(-30, 4);
    expect(t.history.undo()).toBe(true);
    expect(t.clip().pitchEdit?.notes[0]?.shift).toBeUndefined();
    expect(t.history.undo()).toBe(true);
    expect(t.clip().pitchEdit).toBeUndefined();
    expect(t.history.undo()).toBe(false); // nothing else was recorded
  });

  it('a render replaces the previous one, which goes with its sample; undo brings both back', () => {
    const t = setup();
    const edit1 = snapToKey(sung, MAJOR);
    t.history.transact('Snap', (d) => setPitchEdit(d, t.clipId, edit1));
    const r1 = t.render('r1');
    t.history.transact('Render', (d) => setPitchRender(d, t.clipId, r1, editSignature(edit1)), { amend: t.history.status().cursor });
    expect(t.history.status().undoLabel).toBe('Snap'); // folded into the edit's step
    expect(t.clip().pitchEdit?.renderedSampleId).toBe(r1.id);
    expect(t.doc().samples[r1.id]).toBeDefined();
    // A second edit keeps the (out of date) render until the new one arrives.
    const edit2 = snapToKey(sung, MAJOR, 0.5);
    t.history.transact('Snap half', (d) => setPitchEdit(d, t.clipId, edit2));
    expect(t.clip().pitchEdit?.renderedSampleId).toBe(r1.id);
    expect(t.clip().pitchEdit?.renderedFor).toBe(editSignature(edit1));
    const r2 = t.render('r2');
    t.history.transact('Render', (d) => setPitchRender(d, t.clipId, r2, editSignature(edit2)), { amend: t.history.status().cursor });
    expect(t.clip().pitchEdit?.renderedSampleId).toBe(r2.id);
    expect(t.doc().samples[r1.id]).toBeUndefined(); // nothing plays it any more
    expect(t.doc().samples[r2.id]).toBeDefined();
    // Undo: back to the first edit and its render.
    t.history.undo();
    expect(t.clip().pitchEdit?.renderedSampleId).toBe(r1.id);
    expect(t.doc().samples[r1.id]).toBeDefined();
    expect(t.doc().samples[r2.id]).toBeUndefined();
    expect(editSignature(t.clip().pitchEdit!)).toBe(t.clip().pitchEdit?.renderedFor);
  });

  it('an edit that changes nothing sends the clip back to the original audio', () => {
    const t = setup();
    const edit = snapToKey(sung, MAJOR);
    t.history.transact('Snap', (d) => setPitchEdit(d, t.clipId, edit));
    const r = t.render();
    t.history.transact('Render', (d) => setPitchRender(d, t.clipId, r, editSignature(edit)));
    const channel = t.doc().channels[t.channelId];
    expect(channel?.kind === 'audioClip' && clipSampleId(channel, t.clip())).toBe(r.id);
    t.history.transact('Reset', (d) => setPitchEdit(d, t.clipId, { notes: sung.notes }));
    expect(t.clip().pitchEdit?.renderedSampleId).toBeUndefined();
    expect(t.doc().samples[r.id]).toBeUndefined();
    expect(channel?.kind === 'audioClip' && clipSampleId(channel, t.clip())).toBe(t.ref.id);
  });

  it('a split clip shares the render; it stays while any clip plays it', () => {
    const t = setup();
    const edit = snapToKey(sung, MAJOR);
    t.history.transact('Snap', (d) => setPitchEdit(d, t.clipId, edit));
    const r = t.render();
    t.history.transact('Render', (d) => setPitchRender(d, t.clipId, r, editSignature(edit)));
    const right = newId.clip();
    t.history.transact('Split', (d) => splitClip(d, t.clipId, 3840, constantTempo(120), right));
    const rightClip = () => t.doc().playlist.clips[right] as AudioClip;
    expect(rightClip().pitchEdit?.renderedSampleId).toBe(r.id);
    // Removing the edit from one half keeps the render for the other.
    t.history.transact('Clear left', (d) => setPitchEdit(d, t.clipId, null));
    expect(t.doc().samples[r.id]).toBeDefined();
    t.history.transact('Clear right', (d) => setPitchEdit(d, right, null));
    expect(t.doc().samples[r.id]).toBeUndefined();
  });

  it('clearPitchRender keeps the edit but plays the original', () => {
    const t = setup();
    const edit = snapToKey(sung, MAJOR);
    t.history.transact('Snap', (d) => setPitchEdit(d, t.clipId, edit));
    const r = t.render();
    t.history.transact('Render', (d) => setPitchRender(d, t.clipId, r, editSignature(edit)));
    t.history.transact('Clear', (d) => clearPitchRender(d, t.clipId));
    expect(t.clip().pitchEdit?.notes).toHaveLength(2);
    expect(t.clip().pitchEdit?.renderedSampleId).toBeUndefined();
    expect(t.doc().samples[r.id]).toBeUndefined();
  });

  it('ignores clips that are not audio clips', () => {
    const t = setup();
    expect(t.history.transact('x', (d) => setPitchEdit(d, 'nope' as never, sung))).toBe(false);
  });
});
