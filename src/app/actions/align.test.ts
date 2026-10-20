import { afterEach, describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { makeScenario } from '../../../test/helpers/align-scenario';
import { attackTime } from '../../../test/helpers/syllables';
import { pitchRenderSignature } from '@core/audio/align/edit';
import { planAlignment } from '@core/audio/align/plan';
import { decodeFlac } from '@core/io/flac';
import { collectHashes } from '@core/gc/refs';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { produce } from 'immer';
import { defaultSampleStore } from '../persistence/blob-store';
import { alignState } from '../align/state';
import { createTestServices } from '../testing';
import { alignClips, hearUnaligned, removeAlignment, tightenClips } from './align';
import { startAlignRenderer } from './align-render';

const SR = 48000;

/** A lead on track 1 and two doubles on tracks 2 and 3, all from the same synthetic phrase with different timing slips. */
async function setup() {
  const lead = makeScenario({ sampleRate: SR, seed: 3, syllables: 6, jitterSec: 0.08 });
  const second = makeScenario({ sampleRate: SR, seed: 4, syllables: 6, jitterSec: 0.08 });
  const samples = new TestSamples();
  const leadRef = samples.add([lead.lead], SR, 'lead');
  const doubleRef = samples.add([lead.double], SR, 'double one');
  const secondRef = samples.add([second.double], SR, 'double two');
  const length = 3840 * 3;
  const a = audioClipProject(leadRef, [{ start: 0, length, lane: 0 }]);
  const b = audioClipProject(doubleRef, [{ start: 0, length, lane: 1 }]);
  const c = audioClipProject(secondRef, [{ start: 0, length, lane: 2 }]);
  const project = produce(a.project, (d) => {
    [b, c].forEach((other, i) => {
      for (const ref of Object.values(other.project.samples)) d.samples[ref.id] = ref;
      d.channels[other.channelId] = other.project.channels[other.channelId]!;
      d.channelOrder.push(other.channelId);
      // Each project made its own tracks: the clip goes on this project's track number i + 2.
      for (const id of other.clipIds) d.playlist.clips[id] = { ...other.project.playlist.clips[id]!, laneId: d.playlist.laneOrder[i + 1]! };
    });
  });
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('lead', { sampleRate: SR, channels: [lead.lead], duration: lead.lead.length / SR });
  s.fakeEngine.sampleAudio.set('double one', { sampleRate: SR, channels: [lead.double], duration: lead.double.length / SR });
  s.fakeEngine.sampleAudio.set('double two', { sampleRate: SR, channels: [second.double], duration: second.double.length / SR });
  s.history.load(project);
  return { s, leadClip: a.clipIds[0] as ClipId, one: b.clipIds[0] as ClipId, two: c.clipIds[0] as ClipId, scenario: lead };
}

const clipOf = (p: Project, id: ClipId) => p.playlist.clips[id] as AudioClip;
async function until(fn: () => boolean, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  alignState.setState({ rendering: {}, problems: {}, lastStats: {}, windowClip: null });
});

/** The decoded 24-bit audio of a clip's aligned render, as floats. */
async function renderOf(s: Awaited<ReturnType<typeof setup>>['s'], id: ClipId): Promise<Float32Array> {
  const p = s.doc.getState().project;
  const sample = p.samples[clipOf(p, id).align!.renderedSampleId!]!;
  if (sample.source.kind !== 'embedded') throw new Error('not embedded');
  const blob = await defaultSampleStore().getBlob(sample.source.hash, sample.source.ext);
  if (!blob) throw new Error('the render is not in the store');
  const decoded = decodeFlac(blob.bytes);
  const scale = 2 ** (decoded.bitDepth - 1);
  return Float32Array.from(decoded.channels[0] as Int32Array, (v) => v / scale);
}

describe('align actions', () => {
  it('sets the alignment as one undo step, renders it into the same step and keeps the audio referenced', { timeout: 120_000 }, async () => {
    const { s, leadClip, one } = await setup();
    stop = startAlignRenderer(s);
    const before = s.history.steps().done.length;
    const result = alignClips(s, { clips: [one], guide: leadClip, tightness: 100, pitch: 0 });
    expect(result.aligned).toEqual([one]);
    expect(s.history.steps().done.length).toBe(before + 1);
    expect(clipOf(s.doc.getState().project, one).align).toMatchObject({ mode: 'guide', guide: leadClip, tightness: 100 });
    expect(clipOf(s.doc.getState().project, one).align?.renderedSampleId).toBeUndefined();
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId);
    const p = s.doc.getState().project;
    const align = clipOf(p, one).align!;
    const planned = planAlignment(p, one);
    expect('plan' in planned && planned.plan.signature === align.renderedFor).toBe(true);
    expect(align.warp!.length).toBeGreaterThanOrEqual(4);
    const sample = p.samples[align.renderedSampleId!]!;
    expect(collectHashes(p).has(sample.source.kind === 'embedded' ? sample.source.hash : '')).toBe(true);
    // The render came out as the same undo step.
    expect(s.history.steps().done.length).toBe(before + 1);
    // Undo takes both away; redo brings both back.
    s.history.undo();
    expect(clipOf(s.doc.getState().project, one).align).toBeUndefined();
    expect(s.doc.getState().project.samples[sample.id]).toBeUndefined();
    s.history.redo();
    expect(clipOf(s.doc.getState().project, one).align?.renderedSampleId).toBe(sample.id);
  });

  it('puts the double’s syllables on the lead’s: every onset within 10 ms in the stored render', { timeout: 120_000 }, async () => {
    const { s, leadClip, one, scenario } = await setup();
    stop = startAlignRenderer(s);
    alignClips(s, { clips: [one], guide: leadClip, tightness: 100 });
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId);
    const aligned = await renderOf(s, one);
    const errors = scenario.leadStarts.map((t) => (attackTime(aligned, SR, t, 0.06) - attackTime(scenario.lead, SR, t, 0.06)) * 1000);
    expect(Math.max(...errors.map(Math.abs)), errors.map((e) => e.toFixed(1)).join(' ')).toBeLessThan(10);
    // The recording itself is untouched.
    const own = s.doc.getState().project.channels[clipOf(s.doc.getState().project, one).channelId];
    expect(own?.kind === 'audioClip' && own.sampleId).toBeTruthy();
  });

  it('aligns several clips to one guide in one undo step, each with its own render', { timeout: 120_000 }, async () => {
    const { s, leadClip, one, two } = await setup();
    stop = startAlignRenderer(s);
    const before = s.history.steps().done.length;
    const result = alignClips(s, { clips: [one, two], guide: leadClip });
    expect(result.aligned).toEqual([one, two]);
    expect(s.history.steps().done.length).toBe(before + 1);
    expect(s.history.status().undoLabel).toBe('Align to guide (2 clips)');
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId && !!clipOf(s.doc.getState().project, two).align?.renderedSampleId);
    expect(s.history.steps().done.length).toBe(before + 1);
    s.history.undo();
    expect(clipOf(s.doc.getState().project, one).align).toBeUndefined();
    expect(clipOf(s.doc.getState().project, two).align).toBeUndefined();
  });

  it('renders again when a setting changes and drops the old render’s sample', { timeout: 120_000 }, async () => {
    const { s, leadClip, one } = await setup();
    stop = startAlignRenderer(s);
    alignClips(s, { clips: [one], guide: leadClip, tightness: 100 });
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId);
    const first = clipOf(s.doc.getState().project, one).align!.renderedSampleId!;
    alignClips(s, { clips: [one], guide: leadClip, tightness: 40 });
    // The old render keeps playing until the new one is there.
    expect(clipOf(s.doc.getState().project, one).align?.renderedSampleId).toBe(first);
    await until(() => clipOf(s.doc.getState().project, one).align?.renderedSampleId !== first);
    expect(s.doc.getState().project.samples[first]).toBeUndefined();
    s.history.undo();
    expect(clipOf(s.doc.getState().project, one).align?.tightness).toBe(100);
    expect(clipOf(s.doc.getState().project, one).align?.renderedSampleId).toBe(first);
  });

  it('renders again when the guide moves', { timeout: 120_000 }, async () => {
    const { s, leadClip, one } = await setup();
    stop = startAlignRenderer(s);
    alignClips(s, { clips: [one], guide: leadClip, tightness: 100 });
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId);
    const first = clipOf(s.doc.getState().project, one).align!.renderedSampleId!;
    s.history.transact('Move the lead', (d) => void ((d.playlist.clips[leadClip] as AudioClip).start += 240));
    await until(() => clipOf(s.doc.getState().project, one).align?.renderedSampleId !== first);
    const p = s.doc.getState().project;
    const planned = planAlignment(p, one);
    expect('plan' in planned && planned.plan.signature === clipOf(p, one).align?.renderedFor).toBe(true);
  });

  it('tightens to the grid and removes the alignment (the render goes with it)', { timeout: 120_000 }, async () => {
    const { s, one } = await setup();
    stop = startAlignRenderer(s);
    const result = tightenClips(s, { clips: [one], strength: 100, stepTicks: 240 });
    expect(result.aligned).toEqual([one]);
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId);
    const render = clipOf(s.doc.getState().project, one).align!.renderedSampleId!;
    expect(removeAlignment(s, [one])).toBe(1);
    expect(clipOf(s.doc.getState().project, one).align).toBeUndefined();
    expect(s.doc.getState().project.samples[render]).toBeUndefined();
    expect(removeAlignment(s, [one])).toBe(0);
  });

  it('refuses what cannot be aligned, in words, and sets nothing', () => {
    const t = { toasts: [] as string[] };
    void t;
    return setup().then(({ s, leadClip, one }) => {
      const self = alignClips(s, { clips: [leadClip], guide: leadClip });
      expect(self.aligned).toEqual([]);
      expect(self.skipped[0]?.reason).toMatch(/itself/);
      const none = alignClips(s, { clips: [one], guide: 'nope' as ClipId });
      expect(none.aligned).toEqual([]);
      expect(s.history.steps().done.length).toBe(0); // nothing was recorded
      // A reversed clip is refused by the same check.
      s.history.transact('Reverse', (d) => {
        const clip = d.playlist.clips[one] as AudioClip;
        const channel = d.channels[clip.channelId];
        if (channel?.kind === 'audioClip') channel.reverse = true;
      });
      const reversed = tightenClips(s, { clips: [one] });
      expect(reversed.aligned).toEqual([]);
      expect(reversed.skipped[0]?.reason).toMatch(/own speed/);
    });
  });

  it('A/B is session state: nothing in the document changes, and the engine hears the recording', { timeout: 120_000 }, async () => {
    const { s, leadClip, one } = await setup();
    stop = startAlignRenderer(s);
    alignClips(s, { clips: [one], guide: leadClip, tightness: 100 });
    await until(() => !!clipOf(s.doc.getState().project, one).align?.renderedSampleId);
    const steps = s.history.steps().done.length;
    const project = s.doc.getState().project;
    expect(hearUnaligned(s, one)).toBe(true);
    expect(s.editor.getState().alignOriginal).toEqual([one]);
    expect(s.doc.getState().project).toBe(project);
    expect(s.history.steps().done.length).toBe(steps);
    expect(hearUnaligned(s, one, false)).toBe(false);
    expect(s.editor.getState().alignOriginal).toEqual([]);
  });

  it('keeps the pitch edit’s render tied to the aligned sound it was made from', () => {
    return setup().then(({ s, one }) => {
      const base = s.doc.getState().project;
      const clip = clipOf(base, one);
      expect(pitchRenderSignature(clip)).toBeNull();
      const withEdit = produce(clip, (c) => void (c.pitchEdit = { notes: [{ from: 0.1, to: 0.5, pitch: 60, shift: 50 }] }));
      const plain = pitchRenderSignature(withEdit) as string;
      const aligned = produce(withEdit, (c) => void (c.align = { mode: 'grid', tightness: 70, renderedSampleId: 'smp_a' as never }));
      expect(pitchRenderSignature(aligned)).toBe(`${plain}|aligned:smp_a`);
      // With no alignment render the signature is the edit's own, so earlier projects keep their renders.
      expect(pitchRenderSignature(produce(aligned, (c) => void delete c.align?.renderedSampleId))).toBe(plain);
    });
  });
});
