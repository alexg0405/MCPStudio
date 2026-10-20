import { pitchRenderSignature } from '@core/audio/align/edit';
import { afterEach, describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { sing } from '../../../test/helpers/sung';
import { cleanupSignature, isRenderCurrent } from '@core/audio/cleanup-edit';
import { renderCleanup } from '@core/audio/cleanup/render';
import { pinkNoise, rms, syntheticPhrase, toDb } from '@core/audio/cleanup/test-signals';
import { clipSampleId, clipSourceSampleId } from '@core/audio/playback';
import { collectHashes } from '@core/gc/refs';
import { decodeFlac } from '@core/io/flac-decoder';
import { heardProject } from '@core/query/hear';
import type { AudioClip, ClipId, Project, SampleRef } from '@core/model/types';
import { defaultSampleStore } from '../persistence/blob-store';
import { cleanupState } from '../cleanup/state';
import { pitchState } from '../pitch/state';
import { createTestServices } from '../testing';
import {
  changeCleanup,
  cleanupOf,
  cleanupProblem,
  clearClipCleanup,
  hearUncleaned,
  learnNoiseAutomatically,
  learnNoiseFrom,
  toggleBreath,
} from './cleanup';
import { CLEANUP_RENDER_DELAY_MS, renderCleanupNow, startCleanupRenderer } from './cleanup-render';
import { analyzeClip, editFor, commitEdit, startPitchRenderer } from './pitch';

const SR = 48000;

async function setup(opts: { sung?: boolean } = {}) {
  const phrase = syntheticPhrase({ seconds: 10, noiseDb: -48, seed: 5 });
  const notes = [{ from: 0.9, to: 1.6, midi: 60.3 }, { from: 2, to: 2.7, midi: 64.4 }];
  // The sung line with room noise under it (the noise is made once, not per sample).
  const room = opts.sung ? pinkNoise(SR * 4, -46, 2) : null;
  const x = room ? Float32Array.from(sing(notes, SR, 4), (v, i) => v + (room[i] as number)) : phrase.mix;
  const samples = new TestSamples();
  const ref = samples.add([x], SR, 'vocal');
  const { project, clipIds, channelId } = audioClipProject(ref, [{ start: 0, length: 3840 * 4 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
  s.history.load(project);
  return { s, clipId: clipIds[0] as ClipId, channelId, x, phrase };
}

const clipOf = (p: Project, id: ClipId) => p.playlist.clips[id] as AudioClip;
async function until(fn: () => boolean, ms = 30000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Lets the fake engine "decode" a rendered sample from the sample store, as the real engine does. */
async function teachEngine(s: Awaited<ReturnType<typeof setup>>['s'], ref: SampleRef): Promise<Float32Array[]> {
  if (ref.source.kind !== 'embedded') throw new Error('not stored');
  const blob = await defaultSampleStore().getBlob(ref.source.hash, ref.source.ext);
  const decoded = decodeFlac(blob!.bytes);
  const channels = decoded.channels.map((c) => Float32Array.from(c, (v) => v / 2 ** 23));
  s.fakeEngine.sampleAudio.set(ref.name, { sampleRate: decoded.sampleRate, channels, duration: channels[0]!.length / decoded.sampleRate });
  return channels;
}

let stop: (() => void) | null = null;
let stopPitch: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stopPitch?.();
  stop = stopPitch = null;
  cleanupState.setState({ clipId: null, rendering: null, problems: {}, clicks: {}, hearingRemoved: false });
  pitchState.setState({ clipId: null, phase: 'none', clip: null, selected: [], rendering: null, message: '' });
});

describe('cleanup actions', () => {
  it('a change is one undo step, a slider drag merges, and undo takes it away', async () => {
    const { s, clipId } = await setup();
    const n0 = s.history.steps().done.length;
    changeCleanup(s, clipId, { noiseDb: 12 });
    expect(s.history.steps().done.length).toBe(n0 + 1);
    for (const db of [14, 16, 18]) changeCleanup(s, clipId, { noiseDb: db }, 'Noise reduction', 'noise');
    expect(s.history.steps().done.length).toBe(n0 + 2);
    expect(cleanupOf(s.doc.getState().project, clipId)?.noise?.amountDb).toBe(18);
    s.history.undo();
    expect(cleanupOf(s.doc.getState().project, clipId)?.noise?.amountDb).toBe(12);
    s.history.undo();
    expect(cleanupOf(s.doc.getState().project, clipId)).toBeNull();
  });

  it('switching every section off removes the cleanup; clearing it works only when there is one', async () => {
    const { s, clipId } = await setup();
    expect(clearClipCleanup(s, clipId)).toBe(false);
    changeCleanup(s, clipId, { noiseDb: 12, clicks: true });
    changeCleanup(s, clipId, { noiseDb: 0, clicks: false });
    expect(cleanupOf(s.doc.getState().project, clipId)).toBeNull();
    changeCleanup(s, clipId, { breathsDb: 10 });
    expect(clearClipCleanup(s, clipId)).toBe(true);
    expect(cleanupOf(s.doc.getState().project, clipId)).toBeNull();
  });

  it('chooses the stretch the noise is learned from, and goes back to finding it', async () => {
    const { s, clipId } = await setup();
    expect(learnNoiseFrom(s, clipId, 0.2, 0.25)).toMatch(/at least 0.1 seconds/);
    expect(cleanupOf(s.doc.getState().project, clipId)).toBeNull();
    expect(learnNoiseFrom(s, clipId, 0.1, 0.7)).toBeNull();
    expect(cleanupOf(s.doc.getState().project, clipId)?.noise).toEqual({ amountDb: 12, sensitivity: 0.5, from: 0.1, to: 0.7 });
    expect(learnNoiseAutomatically(s, clipId)).toBe(true);
    expect(cleanupOf(s.doc.getState().project, clipId)?.noise).toEqual({ amountDb: 12, sensitivity: 0.5 });
  });

  it('says why a clip cannot be cleaned up', async () => {
    const { s, clipId } = await setup();
    expect(cleanupProblem(s.doc.getState().project, clipId)).toBeNull();
    expect(cleanupProblem(s.doc.getState().project, 'nope' as ClipId)).toBe('That is not an audio clip.');
  });

  it('the before/after switch is session state: nothing in the document changes, the engine hears the recording', async () => {
    const { s, clipId } = await setup();
    changeCleanup(s, clipId, { noiseDb: 12 });
    const before = s.doc.getState().project;
    const steps = s.history.steps().done.length;
    expect(hearUncleaned(s, clipId)).toBe(true);
    expect(s.editor.getState().cleanupOriginal).toEqual([clipId]);
    expect(s.doc.getState().project).toBe(before);
    expect(s.history.steps().done.length).toBe(steps);
    expect(hearUncleaned(s, clipId)).toBe(false);
    expect(s.editor.getState().cleanupOriginal).toEqual([]);
  });
});

describe('the cleanup renderer', () => {
  it('renders after the change into the same undo step, writes what it found, keeps the recording and the stored hash', async () => {
    const { s, clipId, x, channelId } = await setup();
    stop = startCleanupRenderer(s);
    const steps0 = s.history.steps().done.length;
    changeCleanup(s, clipId, { noiseDb: 12, breathsDb: 12, clicks: true });
    expect(s.history.steps().done.length).toBe(steps0 + 1);
    const clean = () => clipOf(s.doc.getState().project, clipId).cleanup;
    expect(clean()?.renderedSampleId).toBeUndefined();
    await until(() => !!clean()?.renderedSampleId);
    const settings = clean()!;
    // The findings are in the settings, and the render is current for them.
    expect(settings.noise?.from).toBeDefined();
    expect(settings.breaths?.spans?.length).toBeGreaterThanOrEqual(2);
    expect(isRenderCurrent(settings)).toBe(true);
    expect(settings.renderedFor).toBe(cleanupSignature(settings));
    // One undo step for the change and its render.
    expect(s.history.steps().done.length).toBe(steps0 + 1);
    // The sample is a new one on the same timeline; the recording is untouched and still the channel's.
    const p = s.doc.getState().project;
    const sample = p.samples[settings.renderedSampleId!]!;
    expect(sample.source.kind).toBe('embedded');
    expect(sample.durationSec).toBeCloseTo(x.length / SR, 6);
    const channel = p.channels[channelId]!;
    expect(channel.kind === 'audioClip' && clipSampleId(channel, clipOf(p, clipId))).toBe(sample.id);
    expect(channel.kind === 'audioClip' && p.samples[channel.sampleId]?.name).toBe('vocal');
    // Stored audio is kept while a stored value names its hash.
    const hash = sample.source.kind === 'embedded' ? sample.source.hash : '';
    expect(collectHashes(p).has(hash)).toBe(true);
    expect(s.history.referencedHashes().has(hash)).toBe(true);
    // The sound is cleaned: the room noise at the start is well down.
    const out = await teachEngine(s, sample);
    const quiet: [number, number] = [Math.round(0.1 * SR), Math.round(0.7 * SR)];
    expect(toDb(rms(x, ...quiet) / rms(out[0]!, ...quiet))).toBeGreaterThan(9);
    expect(cleanupState.getState().rendering).toBeNull();
  });

  it('a second change replaces the render (the old sample goes); undo brings back the earlier edit with its render; two renders of the same settings are bit-identical', async () => {
    const { s, clipId } = await setup();
    stop = startCleanupRenderer(s);
    changeCleanup(s, clipId, { noiseDb: 12 });
    const clean = () => clipOf(s.doc.getState().project, clipId).cleanup;
    await until(() => !!clean()?.renderedSampleId && isRenderCurrent(clean()!));
    const first = clean()!.renderedSampleId!;
    const hash = (id: string) => {
      const ref = s.doc.getState().project.samples[id as never]!;
      return ref.source.kind === 'embedded' ? ref.source.hash : '';
    };
    const firstHash = hash(first);
    changeCleanup(s, clipId, { noiseDb: 20 });
    await until(() => clean()?.renderedSampleId !== undefined && clean()?.renderedSampleId !== first);
    expect(s.doc.getState().project.samples[first]).toBeUndefined();
    // Undo: back to 12 dB with its render, and no render of its own starts.
    s.history.undo();
    expect(clean()?.noise?.amountDb).toBe(12);
    expect(clean()?.renderedSampleId).toBe(first);
    expect(s.doc.getState().project.samples[first]).toBeDefined();
    await new Promise((r) => setTimeout(r, CLEANUP_RENDER_DELAY_MS + 250));
    expect(clean()?.renderedSampleId).toBe(first);
    // Rendering the same settings again gives the same bytes (same hash in the store).
    renderCleanupNow(clipId);
    await until(() => clean()?.renderedSampleId !== first);
    expect(hash(clean()!.renderedSampleId!)).toBe(firstHash);
  });

  it('turning everything off puts the recording back and removes the render from the project', async () => {
    const { s, clipId } = await setup();
    stop = startCleanupRenderer(s);
    changeCleanup(s, clipId, { noiseDb: 12 });
    const clean = () => clipOf(s.doc.getState().project, clipId).cleanup;
    await until(() => !!clean()?.renderedSampleId);
    const id = clean()!.renderedSampleId!;
    changeCleanup(s, clipId, { noiseDb: 0 });
    expect(clean()).toBeUndefined();
    expect(s.doc.getState().project.samples[id]).toBeUndefined();
  });

  it('a breath marker switched off is kept, and the render is made again without lowering it', async () => {
    const { s, clipId } = await setup();
    stop = startCleanupRenderer(s);
    changeCleanup(s, clipId, { breathsDb: 20 });
    const clean = () => clipOf(s.doc.getState().project, clipId).cleanup;
    await until(() => !!clean()?.renderedSampleId && isRenderCurrent(clean()!));
    const first = clean()!.renderedSampleId!;
    expect(toggleBreath(s, clipId, 0)).toBe(true);
    expect(clean()?.breaths?.spans?.[0]?.off).toBe(true);
    expect(isRenderCurrent(clean()!)).toBe(false);
    await until(() => clean()?.renderedSampleId !== first && isRenderCurrent(clean()!));
    expect(toggleBreath(s, clipId, 99)).toBe(false);
  });

  it('reports a failed render in a toast and clears the progress', async () => {
    const { s, clipId } = await setup();
    stop = startCleanupRenderer(s);
    s.fakeEngine.sampleAudio.delete('vocal');
    changeCleanup(s, clipId, { noiseDb: 12 });
    await new Promise((r) => setTimeout(r, CLEANUP_RENDER_DELAY_MS + 250));
    expect(s.session.getState().toasts.map((t) => t.text)).toEqual(['The vocal cleanup could not be rendered: This clip’s audio could not be read.']);
    expect(cleanupState.getState().rendering).toBeNull();
    expect(clipOf(s.doc.getState().project, clipId).cleanup?.renderedSampleId).toBeUndefined();
  });

  it('says in the window state when there was no quiet stretch to learn the noise from, and still finishes', async () => {
    const { s, clipId } = await setup();
    s.fakeEngine.sampleAudio.set('vocal', { sampleRate: SR, channels: [new Float32Array(SR * 3)], duration: 3 });
    stop = startCleanupRenderer(s);
    changeCleanup(s, clipId, { noiseDb: 12 });
    const clean = () => clipOf(s.doc.getState().project, clipId).cleanup;
    await until(() => !!clean()?.renderedSampleId);
    expect(cleanupState.getState().problems[clipId]).toMatch(/quiet stretch/);
    expect(isRenderCurrent(clean()!)).toBe(true);
  });

  it('renders nothing for a change that was undone during the pause, or after stopping', async () => {
    const { s, clipId } = await setup();
    stop = startCleanupRenderer(s);
    changeCleanup(s, clipId, { noiseDb: 12 });
    s.history.undo();
    await new Promise((r) => setTimeout(r, CLEANUP_RENDER_DELAY_MS + 250));
    expect(cleanupOf(s.doc.getState().project, clipId)).toBeNull();
    const stopIt = stop;
    changeCleanup(s, clipId, { noiseDb: 12 });
    stopIt();
    await new Promise((r) => setTimeout(r, CLEANUP_RENDER_DELAY_MS + 250));
    expect(clipOf(s.doc.getState().project, clipId).cleanup?.renderedSampleId).toBeUndefined();
  });

  it('the before/after switch plays the recording while the cleanup is on, and the cleaned sound again after', async () => {
    const { s, clipId, channelId } = await setup();
    stop = startCleanupRenderer(s);
    changeCleanup(s, clipId, { noiseDb: 12 });
    await until(() => !!clipOf(s.doc.getState().project, clipId).cleanup?.renderedSampleId);
    const p = s.doc.getState().project;
    const channel = p.channels[channelId]!;
    const sampleOf = (project: Project) => channel.kind === 'audioClip' && clipSampleId(channel, clipOf(project, clipId));
    expect(sampleOf(heardProject(p, { audition: null, original: [], uncleaned: [] }))).toBe(clipOf(p, clipId).cleanup!.renderedSampleId);
    expect(sampleOf(heardProject(p, { audition: null, original: [], uncleaned: [clipId] }))).toBe(channel.kind === 'audioClip' && channel.sampleId);
  });
});

describe('cleanup before pitch correction', () => {
  it('the pitch correction is rendered from the cleaned sound, and again when the cleanup changes', async () => {
    const { s, clipId, channelId } = await setup({ sung: true });
    stop = startCleanupRenderer(s);
    stopPitch = startPitchRenderer(s);
    const clip = await analyzeClip(s, clipId);
    commitEdit(s, clipId, { notes: editFor(s.doc.getState().project, clip).notes.map((n) => ({ ...n, shift: -40 })) }, 'Pitch');
    const pitch = () => clipOf(s.doc.getState().project, clipId).pitchEdit;
    const clean = () => clipOf(s.doc.getState().project, clipId).cleanup;
    // The pitch render starts from the recording while there is no cleanup.
    await until(() => !!pitch()?.renderedSampleId);
    const plain = pitch()!.renderedSampleId!;
    // The fake engine has no decoder for the stored render: it is given the same cleaned sound under the render's name.
    const cleanedSound = renderCleanup({ channels: [s.fakeEngine.sampleAudio.get('vocal')!.channels[0]!], sampleRate: SR, settings: { noise: { amountDb: 12, sensitivity: 0.5 } } });
    s.fakeEngine.sampleAudio.set('vocal (cleaned up)', { sampleRate: SR, channels: cleanedSound.channels, duration: cleanedSound.channels[0]!.length / SR });
    changeCleanup(s, clipId, { noiseDb: 12 });
    await until(() => !!clean()?.renderedSampleId && isRenderCurrent(clean()!));
    const cleaned = clean()!.renderedSampleId!;
    // The cleanup render made the pitch render out of date; it is made again from the cleaned sound.
    // Its signature now names the cleaned sound it was made from (`pitchRenderSignature`), so it is current again.
    const current = () => {
      const p = s.doc.getState().project;
      const channel = p.channels[channelId];
      return channel?.kind === 'audioClip' ? pitchRenderSignature(channel, clipOf(p, clipId)) : null;
    };
    await until(() => pitch()?.renderedSampleId !== undefined && pitch()?.renderedSampleId !== plain && pitch()?.renderedFor === current());
    const p = s.doc.getState().project;
    const channel = p.channels[channelId]!;
    expect(channel.kind === 'audioClip' && clipSourceSampleId(channel, clipOf(p, clipId), 'pitch')).toBe(cleaned);
    expect(channel.kind === 'audioClip' && clipSampleId(channel, clipOf(p, clipId))).toBe(pitch()!.renderedSampleId);
    // The pitched render is cleaner than the pitched recording was: compare the room noise at the start.
    const pitchedClean = await teachEngine(s, p.samples[pitch()!.renderedSampleId!]!);
    const quiet: [number, number] = [Math.round(0.1 * SR), Math.round(0.7 * SR)];
    const noisy = s.fakeEngine.sampleAudio.get('vocal')!.channels[0]!;
    expect(toDb(rms(noisy, ...quiet) / rms(pitchedClean[0]!, ...quiet))).toBeGreaterThan(8);
  });
});
