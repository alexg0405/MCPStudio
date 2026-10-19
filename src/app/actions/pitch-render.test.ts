import { afterEach, describe, expect, it } from 'vitest';
import { sing } from '../../../test/helpers/sung';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import type { AudioClip, ClipId } from '@core/model/types';
import { pitchState } from '../pitch/state';
import { createTestServices } from '../testing';
import { analyzeClip, resetNotes, snapClip } from './pitch';
import { RENDER_DELAY_MS, spliceRendered, startPitchRenderer } from './pitch-render';

const SR = 48000;

async function setup() {
  const x = sing([{ from: 0.1, to: 0.8, midi: 60.3 }], SR, 1);
  const samples = new TestSamples();
  const ref = samples.add([x], SR, 'vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
  s.history.load(project);
  return { s, clipId: clipIds[0] as ClipId };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const renderedSample = (s: Awaited<ReturnType<typeof setup>>['s'], id: ClipId) =>
  (s.doc.getState().project.playlist.clips[id] as AudioClip).pitchEdit?.renderedSampleId;

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  pitchState.setState({ clipId: null, phase: 'none', clip: null, selected: [], rendering: null, message: '' });
});

describe('spliceRendered', () => {
  it('puts the rendered part into a copy of the whole sample and leaves the rest and the original alone', () => {
    const original = [Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5])];
    const full = spliceRendered(original, [Float32Array.from([0.9, 0.8])], 1, 3);
    expect([...full[0]!]).toEqual([...Float32Array.from([0.1, 0.9, 0.8, 0.4, 0.5])]);
    expect([...original[0]!]).toEqual([...Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5])]);
  });

  it('scales the whole spliced stretch down when the rendered part peaks above full scale', () => {
    const original = [Float32Array.from([0.5, 0.5, 0.5, 0.5])];
    const full = spliceRendered(original, [Float32Array.from([2, -4])], 1, 3);
    // Peak 4: the stretch (frames 1 and 2) is divided by it, the frames outside are untouched.
    expect([...full[0]!]).toEqual([0.5, 0.5, -1, 0.5]);
  });
});

describe('the pitch renderer', () => {
  it('reports a failed render in a toast and clears the progress', async () => {
    const { s, clipId } = await setup();
    stop = startPitchRenderer(s);
    const clip = await analyzeClip(s, clipId);
    s.fakeEngine.sampleAudio.delete('vocal');
    snapClip(s, clip, { root: 0, scale: 'major' }, 1);
    await pause(RENDER_DELAY_MS + 150);
    expect(s.session.getState().toasts.map((t) => t.text)).toEqual(['Pitch correction could not be rendered: This clip’s audio could not be read.']);
    expect(pitchState.getState().rendering).toBeNull();
    expect(renderedSample(s, clipId)).toBeUndefined();
  });

  it('renders nothing for an edit that was undone or reset during the pause, or after stopping', async () => {
    const { s, clipId } = await setup();
    stop = startPitchRenderer(s);
    const clip = await analyzeClip(s, clipId);
    snapClip(s, clip, { root: 0, scale: 'major' }, 1);
    s.history.undo();
    snapClip(s, clip, { root: 0, scale: 'major' }, 1);
    resetNotes(s, clip, 'all');
    await pause(RENDER_DELAY_MS + 150);
    expect(renderedSample(s, clipId)).toBeUndefined();
    const stopIt = stop;
    snapClip(s, clip, { root: 0, scale: 'major' }, 1);
    stopIt();
    await pause(RENDER_DELAY_MS + 150);
    expect(renderedSample(s, clipId)).toBeUndefined();
  });
});
