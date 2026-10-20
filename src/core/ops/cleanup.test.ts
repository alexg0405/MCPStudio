import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { cleanupSignature } from '../audio/cleanup-edit';
import { clipSampleId, clipSourceSampleId } from '../audio/playback';
import { editSignature } from '../audio/pitch-edit';
import { History } from '../history/history';
import type { AudioClip, PitchEdit, Project, SampleRef, VocalCleanup } from '../model/types';
import { newId } from '../model/ids';
import { clearCleanupRender, setBreathOff, setCleanup, setCleanupRender } from './cleanup';
import { setPitchEdit, setPitchRender } from './pitch';
import { splitClip } from './playlist';
import { constantTempo } from '../time/ppq';

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
  const channel = () => doc.channels[channelId] as Extract<Project['channels'][string & keyof Project['channels']], { kind: 'audioClip' }>;
  return { history, clipId, clip, doc: () => doc, ref, channel, render };
}

const settings: VocalCleanup = {
  noise: { amountDb: 12, sensitivity: 0.5 },
  breaths: { reduceDb: 10, sensitivity: 0.5 },
  clicks: { sensitivity: 0.5 },
};
const found = { noise: { from: 0.1, to: 0.6 }, breaths: [{ from: 1, to: 1.3 }, { from: 2, to: 2.3 }] };
const pitchEdit: PitchEdit = { notes: [{ from: 0.1, to: 0.6, pitch: 60, shift: -30 }] };

describe('cleanup ops', () => {
  it('setCleanup is one undo step and undo removes it', () => {
    const t = setup();
    expect(t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings))).toBe(true);
    expect(t.clip().cleanup?.noise?.amountDb).toBe(12);
    expect(t.history.undo()).toBe(true);
    expect(t.clip().cleanup).toBeUndefined();
  });

  it('a render replaces the previous one, which goes with its sample; undo brings both back; the recording stays', () => {
    const t = setup();
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings));
    const r1 = t.render('r1');
    const sig1 = cleanupSignature({ ...settings, noise: { ...settings.noise!, ...found.noise }, breaths: { ...settings.breaths!, spans: found.breaths } });
    t.history.transact('Render', (d) => setCleanupRender(d, t.clipId, r1, sig1, found), { amend: t.history.status().cursor });
    expect(t.history.status().undoLabel).toBe('Clean up');
    expect(t.clip().cleanup?.renderedSampleId).toBe(r1.id);
    // What the render found is now in the settings, and the signature matches them.
    expect(t.clip().cleanup?.noise).toMatchObject(found.noise);
    expect(t.clip().cleanup?.breaths?.spans).toEqual(found.breaths);
    expect(cleanupSignature(t.clip().cleanup!)).toBe(t.clip().cleanup?.renderedFor);
    // A second edit keeps the stale render until the new one arrives.
    const next: VocalCleanup = { ...t.clip().cleanup!, noise: { ...t.clip().cleanup!.noise!, amountDb: 20 } };
    t.history.transact('More noise reduction', (d) => setCleanup(d, t.clipId, next));
    expect(t.clip().cleanup?.renderedSampleId).toBe(r1.id);
    expect(cleanupSignature(t.clip().cleanup!)).not.toBe(t.clip().cleanup?.renderedFor);
    const r2 = t.render('r2');
    t.history.transact('Render', (d) => setCleanupRender(d, t.clipId, r2, cleanupSignature(t.clip().cleanup!), {}), { amend: t.history.status().cursor });
    expect(t.clip().cleanup?.renderedSampleId).toBe(r2.id);
    expect(t.doc().samples[r1.id]).toBeUndefined();
    expect(t.doc().samples[t.ref.id]).toBeDefined();
    t.history.undo();
    expect(t.clip().cleanup?.renderedSampleId).toBe(r1.id);
    expect(t.doc().samples[r1.id]).toBeDefined();
    expect(t.doc().samples[r2.id]).toBeUndefined();
    expect(cleanupSignature(t.clip().cleanup!)).toBe(t.clip().cleanup?.renderedFor);
    t.history.undo();
    expect(t.clip().cleanup).toBeUndefined();
    expect(t.doc().samples[r1.id]).toBeUndefined();
  });

  it('settings that change nothing send the clip back to the recording and drop the render', () => {
    const t = setup();
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings));
    const r = t.render();
    t.history.transact('Render', (d) => setCleanupRender(d, t.clipId, r, 'sig', found));
    expect(clipSampleId(t.channel(), t.clip())).toBe(r.id);
    t.history.transact('Off', (d) => setCleanup(d, t.clipId, {}));
    expect(t.clip().cleanup).toBeUndefined();
    expect(t.doc().samples[r.id]).toBeUndefined();
    expect(clipSampleId(t.channel(), t.clip())).toBe(t.ref.id);
  });

  it('the chain: the pitch stage reads the cleanup render, the clip plays the pitch render', () => {
    const t = setup();
    const cleanup = t.render('cleaned');
    const pitched = t.render('pitched');
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings));
    t.history.transact('Pitch', (d) => setPitchEdit(d, t.clipId, pitchEdit));
    expect(clipSourceSampleId(t.channel(), t.clip(), 'cleanup')).toBe(t.ref.id);
    expect(clipSourceSampleId(t.channel(), t.clip(), 'pitch')).toBe(t.ref.id);
    t.history.transact('Cleanup render', (d) => setCleanupRender(d, t.clipId, cleanup, 'sig', found));
    expect(clipSourceSampleId(t.channel(), t.clip(), 'pitch')).toBe(cleanup.id);
    expect(clipSampleId(t.channel(), t.clip())).toBe(cleanup.id);
    t.history.transact('Pitch render', (d) => setPitchRender(d, t.clipId, pitched, editSignature(pitchEdit)));
    expect(clipSampleId(t.channel(), t.clip())).toBe(pitched.id);
    expect(clipSourceSampleId(t.channel(), t.clip(), 'cleanup')).toBe(t.ref.id);
    expect(clipSourceSampleId(t.channel(), t.clip(), 'pitch')).toBe(cleanup.id);
  });

  it('a new cleanup render, or taking cleanup away, marks the pitch render out of date (it is made again from the new source)', () => {
    const t = setup();
    const cleanup = t.render('cleaned');
    const pitched = t.render('pitched');
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings));
    t.history.transact('Pitch', (d) => setPitchEdit(d, t.clipId, pitchEdit));
    t.history.transact('Cleanup render', (d) => setCleanupRender(d, t.clipId, cleanup, 'sig', found));
    t.history.transact('Pitch render', (d) => setPitchRender(d, t.clipId, pitched, editSignature(pitchEdit)));
    expect(t.clip().pitchEdit?.renderedFor).toBe(editSignature(pitchEdit));
    const cleaner = t.render('cleaner');
    t.history.transact('Cleanup render', (d) => setCleanupRender(d, t.clipId, cleaner, 'sig2', {}));
    // Still plays the old pitch render, but it no longer claims to be current.
    expect(t.clip().pitchEdit?.renderedSampleId).toBe(pitched.id);
    expect(t.clip().pitchEdit?.renderedFor).toBeUndefined();
    t.history.transact('Pitch render', (d) => setPitchRender(d, t.clipId, pitched, editSignature(pitchEdit)));
    t.history.transact('Cleanup off', (d) => setCleanup(d, t.clipId, null));
    expect(t.clip().pitchEdit?.renderedFor).toBeUndefined();
    expect(t.clip().pitchEdit?.notes).toHaveLength(1);
  });

  it('a split clip shares the render; it stays while any clip plays it', () => {
    const t = setup();
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings));
    const r = t.render();
    t.history.transact('Render', (d) => setCleanupRender(d, t.clipId, r, 'sig', found));
    const right = newId.clip();
    t.history.transact('Split', (d) => splitClip(d, t.clipId, 3840, constantTempo(120), right));
    expect((t.doc().playlist.clips[right] as AudioClip).cleanup?.renderedSampleId).toBe(r.id);
    t.history.transact('Clear left', (d) => setCleanup(d, t.clipId, null));
    expect(t.doc().samples[r.id]).toBeDefined();
    t.history.transact('Clear right', (d) => setCleanup(d, right, null));
    expect(t.doc().samples[r.id]).toBeUndefined();
  });

  it('clearCleanupRender keeps the settings but plays the recording', () => {
    const t = setup();
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, settings));
    const r = t.render();
    t.history.transact('Render', (d) => setCleanupRender(d, t.clipId, r, 'sig', found));
    t.history.transact('Clear', (d) => clearCleanupRender(d, t.clipId));
    expect(t.clip().cleanup?.clicks).toBeDefined();
    expect(t.clip().cleanup?.renderedSampleId).toBeUndefined();
    expect(t.doc().samples[r.id]).toBeUndefined();
  });

  it('switches a found breath off and on, and ignores a breath that is not there', () => {
    const t = setup();
    t.history.transact('Clean up', (d) => setCleanup(d, t.clipId, { breaths: { reduceDb: 10, sensitivity: 0.5, spans: found.breaths } }));
    expect(t.history.transact('Keep a breath', (d) => void setBreathOff(d, t.clipId, 1, true))).toBe(true);
    expect(t.clip().cleanup?.breaths?.spans?.[1]).toEqual({ from: 2, to: 2.3, off: true });
    t.history.transact('Lower it again', (d) => void setBreathOff(d, t.clipId, 1, false));
    expect(t.clip().cleanup?.breaths?.spans?.[1]).toEqual({ from: 2, to: 2.3 });
    expect(t.history.transact('Nothing', (d) => void setBreathOff(d, t.clipId, 7, true))).toBe(false);
  });

  it('ignores clips that are not audio clips', () => {
    const t = setup();
    expect(t.history.transact('x', (d) => setCleanup(d, 'nope' as never, settings))).toBe(false);
  });
});

describe('the clip edit chain order', () => {
  it('runs cleanup, then alignment, then pitch: each stage reads the render of the last stage before it', async () => {
    const { clipSampleId, clipSourceSampleId } = await import('../audio/playback');
    const channel = { sampleId: 'smp_rec' as never };
    const clip = {
      cleanup: { renderedSampleId: 'smp_clean' },
      align: { renderedSampleId: 'smp_aligned' },
      pitchEdit: { renderedSampleId: 'smp_tuned' },
    } as never;
    expect(clipSourceSampleId(channel, clip, 'cleanup')).toBe('smp_rec');
    expect(clipSourceSampleId(channel, clip, 'align')).toBe('smp_clean');
    expect(clipSourceSampleId(channel, clip, 'pitch')).toBe('smp_aligned');
    expect(clipSampleId(channel, clip)).toBe('smp_tuned');
    // A stage without a render is skipped: pitch reads the cleaned sound when nothing was aligned.
    const noAlign = { cleanup: { renderedSampleId: 'smp_clean' }, pitchEdit: {} } as never;
    expect(clipSourceSampleId(channel, noAlign, 'pitch')).toBe('smp_clean');
    expect(clipSampleId(channel, noAlign)).toBe('smp_clean');
  });
});
