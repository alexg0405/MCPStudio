import { afterEach, describe, expect, it } from 'vitest';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import { newId } from '@core/model/ids';
import { songSections } from '@core/query/sections';
import { fakeReference } from '@core/reference/fixtures';
import { flowSong } from '../../../test/helpers/arrange';
import { fakeAnalyzer, setTrackAnalyzer } from '../dj/analyzer';
import { createTestServices } from '../testing';
import { arrangeLikeReference, clearReference, matchTempoAndKey, setReferenceFromSample } from './actions';
import { forgetReferences, setReferenceDecoder } from './analyze';
import { referenceState } from './state';

const BAR = 3840;

afterEach(() => {
  setTrackAnalyzer(null);
  setReferenceDecoder(null);
  forgetReferences();
  referenceState.setState({ working: null, tone: null });
});

async function song() {
  const { s } = await flowSong(140);
  s.history.transact('Set the reference', (d) => void (d.reference = fakeReference() as never));
  return s;
}

describe('the Reference window’s one-click actions', () => {
  it('Match tempo and key: one undo step, says what it did, undo restores the project exactly', async () => {
    const s = await song();
    const before = s.doc.getState().project;
    const done = s.history.steps().done.length;
    const r = matchTempoAndKey(s);
    expect(r.error).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(r.message).toMatch(/^Tempo 140 → 128 BPM\. Key F minor → A minor/);
    expect(s.doc.getState().project.transport).toMatchObject({ bpm: 128, key: { root: 9, scale: 'minor' } });
    expect(s.history.steps().done.length).toBe(done + 1);
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    // Pressing it again after it has matched changes nothing and says so.
    matchTempoAndKey(s);
    const again = matchTempoAndKey(s);
    expect(again.changed).toBe(false);
    expect(again.message).toMatch(/already 128 BPM/);
  });

  it('Arrange like the reference: the reference’s section lengths, song mode, one undo step', async () => {
    const s = await song();
    s.view.getState().setMode('pattern');
    matchTempoAndKey(s);
    const before = s.doc.getState().project;
    const done = s.history.steps().done.length;
    const r = arrangeLikeReference(s);
    expect(r.error).toBeUndefined();
    expect(r.touched).toEqual({ from: 0, to: 96 * BAR });
    expect(s.history.steps().done.length).toBe(done + 1);
    expect(s.view.getState().mode).toBe('song');
    expect(songSections(s.doc.getState().project).map((x) => x.from / BAR + 1)).toEqual([1, 17, 49, 65]);
    expect(r.message).toMatch(/^Sections follow the reference: Intro 16 · Drop 32 · Break 16 · Drop 2 32 \(96 bars\)/);
    const layout = () => songSections(s.doc.getState().project).map((x) => [x.name, x.from, x.to]);
    const once = layout();
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    s.history.redo();
    // Arranging again gives the same sections.
    arrangeLikeReference(s);
    expect(layout()).toEqual(once);
  });

  it('at another tempo the reference’s time becomes the bars that fit', async () => {
    const s = await song();
    // The song stays at 140 BPM: the 32-bar drops (60 s at 128) are 35 bars (rounded to a phrase of 4: 36).
    arrangeLikeReference(s);
    expect(songSections(s.doc.getState().project).map((x) => x.from / BAR + 1)).toEqual([1, 19, 55, 73]);
  });

  it('with no reference it says what to do and changes nothing', () => {
    const s = createTestServices();
    const done = s.history.steps().done.length;
    for (const r of [matchTempoAndKey(s), arrangeLikeReference(s)]) {
      expect(r.error).toBe(true);
      expect(r.changed).toBe(false);
      expect(r.message).toMatch(/Set a reference song first/);
    }
    expect(s.history.steps().done.length).toBe(done);
  });

  it('setting a song measures it and puts it in as one undo step; clearing is one too', async () => {
    const { s } = await flowSong(140);
    const analysis = fakeAnalysis({ bpm: 150, key: { root: 7, mode: 'major' }, bars: 48, hash: 'cd'.repeat(32) });
    const ref = { id: newId.sample(), name: 'Mine', source: { kind: 'embedded' as const, hash: analysis.hash, ext: 'wav' }, durationSec: analysis.durationSec };
    setTrackAnalyzer(fakeAnalyzer(new Map([[analysis.hash, analysis]])));
    const rate = 22050;
    const audio = new Float32Array(Math.round(analysis.durationSec * rate)).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / rate));
    setReferenceDecoder(async () => ({ channels: [audio, audio], sampleRate: rate }));
    const before = s.doc.getState().project;
    const done = s.history.steps().done.length;
    const progress: string[] = [];
    const unsub = referenceState.subscribe((st) => st.working && progress.push(st.working.label));
    const track = await setReferenceFromSample(s, ref, 'Mine – Song');
    unsub();
    expect(progress).toContain('Measuring the tonal balance');
    expect(referenceState.getState().working).toBeNull();
    expect(track?.bpm).toBe(150);
    expect(s.history.steps().done.length).toBe(done + 1);
    expect(s.doc.getState().project.reference?.title).toBe('Mine – Song');
    expect(s.doc.getState().project.samples[ref.id]).toBeDefined();
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    s.history.redo();
    expect(clearReference(s)).toBe(true);
    expect(s.doc.getState().project.reference).toBeUndefined();
    expect(s.doc.getState().project.samples[ref.id]).toBeUndefined();
    expect(clearReference(s)).toBe(false);
    s.history.undo();
    expect(s.doc.getState().project.reference?.title).toBe('Mine – Song');
    expect(s.doc.getState().project.samples[ref.id]).toBeDefined();
  });

  it('a song that can’t be analyzed leaves the project alone and says why', async () => {
    const { s } = await flowSong(140);
    const ref = { id: newId.sample(), name: 'Broken', source: { kind: 'embedded' as const, hash: 'ef'.repeat(32), ext: 'wav' } };
    setTrackAnalyzer(fakeAnalyzer(new Map()));
    const before = s.doc.getState().project;
    const track = await setReferenceFromSample(s, ref, 'Broken');
    expect(track).toBeNull();
    expect(s.doc.getState().project).toBe(before);
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/No analysis for Broken/);
    expect(referenceState.getState().working).toBeNull();
  });
});
