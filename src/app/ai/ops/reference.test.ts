import { afterEach, describe, expect, it } from 'vitest';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import { newId } from '@core/model/ids';
import type { ReferenceTrack } from '@core/model/types';
import { songSections } from '@core/query/sections';
import { DROP_SONG, fakeReference } from '@core/reference/fixtures';
import { fakeAnalyzer, setTrackAnalyzer } from '../../dj/analyzer';
import { library, type LibrarySong } from '../../dj/library';
import { rememberReference, forgetReferences, setReferenceDecoder } from '../../reference/analyze';
import { matchReferenceStep, setReferenceStep } from '../../reference/step';
import { referenceState } from '../../reference/state';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { projectContext } from '../context';
import { STUDIO_PROMPT } from '../prompt';
import { readTools, runReadTool } from '../read';
import type { AiAction } from '../schema';
import { flowSong } from '../../../../test/helpers/arrange';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const project = (s: S) => s.doc.getState().project;
const BAR = 3840;

const hex = (name: string) => [...name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64);
const stepCtx = (s: S, entry: number | null = null) => ({ s, entry, signal: new AbortController().signal, progress: () => {}, whenQuiet: async () => {} });

/** A library song whose analysis a fake analyzer knows. */
function librarySong(label: string, analysis: TrackAnalysis): LibrarySong {
  const key = analysis.hash;
  return {
    key,
    ref: { id: newId.sample(), name: label, source: { kind: 'embedded', hash: key, ext: 'mp3' }, durationSec: analysis.durationSec },
    title: label,
    label,
    fileName: `${label}.mp3`,
    addedAt: 0,
  };
}

afterEach(() => {
  setTrackAnalyzer(null);
  setReferenceDecoder(null);
  forgetReferences();
  library.setState({ songs: [], selected: [] });
  referenceState.setState({ working: null, tone: null });
});

describe('match_reference', () => {
  async function songWithReference(ref: ReferenceTrack = fakeReference()) {
    const { s } = await flowSong(140);
    s.history.transact('Set the reference', (d) => {
      d.reference = ref as never;
    });
    return s;
  }

  it('matches tempo, key, arrangement, loudness and tone in one undo step; undo restores the project exactly', async () => {
    const s = await songWithReference();
    const before = project(s);
    const done = s.history.steps().done.length;
    const res = run(s, [{ op: 'match_reference' }]);
    expect(res.warnings).toEqual([]);
    const p = project(s);
    expect(s.history.steps().done.length).toBe(done + 1);
    expect(p.transport.bpm).toBe(128);
    expect(p.transport.key).toEqual({ root: 9, scale: 'minor' });
    // The reference’s sections: 16, 32, 16 and 32 bars.
    // The reference’s sections: markers at bars 1, 17, 49 and 65 (16, 32, 16 and 32 bars; the last one's stop effects ring a little past bar 96).
    const sections = songSections(p);
    expect(sections.map((x) => x.from / BAR + 1)).toEqual([1, 17, 49, 65]);
    expect(sections.slice(0, 3).map((x) => (x.to - x.from) / BAR)).toEqual([16, 32, 16]);
    expect(Math.round(sections[3]!.to / BAR)).toBeGreaterThanOrEqual(96);
    expect(songSections(p).map((x) => x.name)).toEqual(['Intro', 'Drop', 'Break', 'Drop 2']);
    // The loudness and tone follow after the edit, in the same undo step.
    expect(res.after).toEqual(
      expect.arrayContaining([{ kind: 'mode', mode: 'song' }, expect.objectContaining({ kind: 'level_mix', targetLufs: -8 }), { kind: 'reference_tone' }]),
    );
    expect(res.changes.join('\n')).toMatch(/Tempo 140 → 128 BPM/);
    expect(res.changes.join('\n')).toMatch(/Key F minor → A minor: \d+ pitched notes moved up 4 semitones, drums unchanged/);
    expect(res.changes.join('\n')).toMatch(/Sections follow the reference: Intro 16 · Drop 32 · Break 16 · Drop 2 32 \(96 bars\)/);
    s.history.undo();
    expect(project(s)).toEqual(before);
    s.history.redo();
    expect(project(s)).toEqual(p);
  });

  it('matches only what is named', async () => {
    const s = await songWithReference();
    const before = project(s);
    const res = run(s, [{ op: 'match_reference', tempo: true }]);
    const p = project(s);
    expect(p.transport.bpm).toBe(128);
    expect(p.transport.key).toEqual(before.transport.key);
    expect(p.playlist).toBe(before.playlist);
    expect(res.after.some((a) => a.kind === 'level_mix' || a.kind === 'reference_tone')).toBe(false);
    const loud = run(s, [{ op: 'match_reference', loudness: true }]);
    expect(loud.after).toEqual([expect.objectContaining({ kind: 'level_mix', targetLufs: -8 })]);
    expect(loud.edited).toBe(false);
  });

  it('the arrangement is played by the musician’s own patterns and nothing else is added from the reference', async () => {
    const s = await songWithReference();
    const before = project(s);
    run(s, [{ op: 'match_reference', arrangement: true }]);
    const p = project(s);
    const mine = new Set(Object.values(before.patterns).map((x) => x.name));
    // Every pattern that plays is one of the song’s (or a variation of one: named after it).
    for (const c of Object.values(p.playlist.clips)) {
      if (c.kind !== 'pattern') continue;
      const name = p.patterns[c.patternId]!.name;
      expect([...mine].some((m) => name.startsWith(m)), name).toBe(true);
    }
    // The reference's own bands, energies and file never enter the patterns or channels.
    expect(JSON.stringify([p.patterns, p.channels])).not.toContain(before.reference!.hash);
  });

  it('keeps the key when it already matches and says so', async () => {
    const s = await songWithReference(fakeReference({ key: { root: 5, mode: 'minor' } }));
    const res = run(s, [{ op: 'match_reference', key: true }]);
    expect(res.edited).toBe(false);
    expect(res.changes.join()).toMatch(/Already in the key of the reference \(F minor\)/);
  });

  it('warns about what the reference lacks: no steady tempo, no key', async () => {
    const s = await songWithReference(fakeReference({ bpm: null, key: null }));
    const res = run(s, [{ op: 'match_reference', tempo: true, key: true }]);
    expect(res.warnings.join('\n')).toMatch(/no steady beat/);
    expect(res.warnings.join('\n')).toMatch(/no clear key/);
    expect(res.edited).toBe(false);
  });

  it('needs patterns to arrange', async () => {
    const s = createTestServices();
    s.history.transact('ref', (d) => void (d.reference = fakeReference() as never));
    const res = run(s, [{ op: 'match_reference', arrangement: true }]);
    expect(res.warnings.join()).toMatch(/make a beat first/);
  });

  it('without a reference it says how to set one', () => {
    const s = createTestServices();
    const res = run(s, [{ op: 'match_reference' }]);
    expect(res.warnings[0]).toMatch(/^match reference: there is no reference song yet: set_reference first/);
    expect(res.edited).toBe(false);
  });
});

describe('set_reference', () => {
  it('sets a library song whose measurements are known, as one undo step that undo takes back completely', async () => {
    const { s } = await flowSong(140);
    const analysis = fakeAnalysis({ bpm: 128, key: { root: 9, mode: 'minor' }, bars: 96, hash: hex('known') });
    const song = librarySong('Nova – Known', analysis);
    library.setState({ songs: [song] });
    rememberReference({ ...fakeReference({ hash: song.key }), title: '' });
    const before = project(s);
    const done = s.history.steps().done.length;
    const res = run(s, [{ op: 'set_reference', song: 'known' }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]).toMatch(/^Reference set: “Nova – Known” \(128 BPM, key A minor \(8A\)/);
    expect(s.history.steps().done.length).toBe(done + 1);
    const p = project(s);
    expect(p.reference?.title).toBe('Nova – Known');
    expect(p.reference?.sampleId && p.samples[p.reference.sampleId]?.source).toMatchObject({ kind: 'embedded', hash: song.key });
    // The file is a sample of the project, but nothing plays it.
    expect(Object.values(p.channels).some((c) => c.kind === 'audioClip' && c.sampleId === p.reference?.sampleId)).toBe(false);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });

  it('replacing the reference drops the old file from the project when nothing else uses it; clear does the same', async () => {
    const { s } = await flowSong(140);
    const a = librarySong('A', fakeAnalysis({ bpm: 128, bars: 24, hash: hex('aaa') }));
    const b = librarySong('B', fakeAnalysis({ bpm: 120, bars: 24, hash: hex('bbb') }));
    library.setState({ songs: [a, b] });
    rememberReference(fakeReference({ hash: a.key }));
    rememberReference(fakeReference({ hash: b.key, bpm: 120 }));
    const base = Object.keys(project(s).samples).length;
    run(s, [{ op: 'set_reference', song: 'A' }]);
    expect(Object.keys(project(s).samples).length).toBe(base + 1);
    run(s, [{ op: 'set_reference', song: 'B' }]);
    expect(Object.keys(project(s).samples).length).toBe(base + 1);
    expect(project(s).reference?.bpm).toBe(120);
    const cleared = run(s, [{ op: 'set_reference', clear: true }]);
    expect(cleared.changes).toEqual(['Cleared the reference']);
    expect(project(s).reference).toBeUndefined();
    expect(Object.keys(project(s).samples).length).toBe(base);
  });

  it('analyzes a new song after the answer, in the answer’s undo step, and match_reference waits for it', async () => {
    const { s } = await flowSong(140);
    const analysis = fakeAnalysis({ bpm: 160, key: { root: 2, mode: 'minor' }, bars: 48, hash: hex('fresh'), lufs: -9.4 });
    const song = librarySong('Fresh', analysis);
    library.setState({ songs: [song] });
    const analyzer = fakeAnalyzer(new Map([[song.key, analysis]]));
    setTrackAnalyzer(analyzer);
    // A short synthetic song stands in for the decoded file.
    const rate = 22050;
    const audio = new Float32Array(Math.round(analysis.durationSec * rate)).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 110 * i) / rate));
    setReferenceDecoder(async () => ({ channels: [audio], sampleRate: rate }));
    const before = project(s);
    const done = s.history.steps().done.length;
    const res = run(s, [{ op: 'set_reference', song: 'Fresh' }, { op: 'match_reference', tempo: true, key: true, arrangement: true }]);
    expect(res.warnings).toEqual([]);
    expect(project(s).reference).toBeUndefined();
    expect(res.after.map((a) => a.kind)).toEqual(['set_reference', 'match_reference']);
    // The answer's own edit comes first (the AI changed the title), then the after steps fold into its undo step.
    const answer = run(s, [{ op: 'song', title: 'Like Fresh' }]);
    expect(answer.edited).toBe(true);
    const entry = s.history.status().cursor;
    const set = await setReferenceStep(res.after[0]!, stepCtx(s, entry));
    expect(set?.message).toBe('Reference set: “Fresh”.');
    expect(analyzer.calls).toBe(1);
    const p1 = project(s);
    expect(p1.reference?.bpm).toBe(160);
    expect(p1.reference?.sections.map((x) => x.kind)).toEqual(['intro', 'body', 'outro']);
    expect(p1.reference?.bands).toHaveLength(8);
    expect(p1.reference?.sections[0]?.bands).toHaveLength(8);
    const match = await matchReferenceStep(res.after[1]!, stepCtx(s, entry));
    expect((match?.changes ?? []).join('\n')).toMatch(/Tempo 140 → 160 BPM/);
    const p = project(s);
    expect(p.transport.bpm).toBe(160);
    expect(p.transport.key).toEqual({ root: 2, scale: 'minor' });
    expect(songSections(p).length).toBeGreaterThanOrEqual(3);
    // set_reference, the match and the answer's own edit are one undo step.
    expect(s.history.steps().done.length).toBe(done + 1);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });

  it('says where to find the song, and what is wrong with a name', async () => {
    const s = createTestServices();
    expect(run(s, [{ op: 'set_reference' }]).warnings[0]).toMatch(/say where the reference comes from/);
    expect(run(s, [{ op: 'set_reference', song: 'Nothing' }]).warnings[0]).toMatch(/there is no song "Nothing" in the music library/);
    expect(run(s, [{ op: 'set_reference', sample: 'Nothing' }]).warnings[0]).toMatch(/no song file called "Nothing"/);
  });

  it('a file the musician gives is asked for with one click (the file chooser)', () => {
    const s = createTestServices();
    const res = run(s, [{ op: 'set_reference', choose_file: true }]);
    expect(res.after).toEqual([{ kind: 'command', id: 'reference.chooseFile', gesture: true }]);
  });
});

describe('what Studio reads', () => {
  it('lists the reference in its context and in get_reference, with only measurements', async () => {
    const { s } = await flowSong(140);
    expect(projectContext(s)).not.toContain('<reference>');
    expect(runReadTool(s, 'get_reference')).toMatchObject({ reference: null });
    s.history.transact('ref', (d) => void (d.reference = fakeReference({ title: 'Nova – Known' }) as never));
    const ctx = projectContext(s);
    expect(ctx).toMatch(/<reference> “Nova – Known”: 128 BPM, key A minor \(8A\), −8\.0 LUFS/);
    expect(ctx).toMatch(/Sections \(bars of its own tempo, energy 0–1\): Intro 16 \(0\.3\) · Drop 32 \(1\) · Break 16 \(0\.35\) · Drop 32 \(1\)/);
    expect(ctx).toMatch(/Your song: 140 BPM, key F minor, tempo \+12 BPM from the reference; sections Intro 4 · Verse 8/);
    const r = runReadTool(s, 'get_reference') as { reference: { tempo_bpm: number; sections: unknown[] }; differences: { tempo_bpm: number }; arrangement_at_your_tempo: { name: string; bars: number }[]; tone_check: { note: string } };
    expect(r.reference.tempo_bpm).toBe(128);
    expect(r.reference.sections).toHaveLength(4);
    expect(r.differences.tempo_bpm).toBe(12);
    // At the song’s own tempo (140) the same time is more bars.
    expect(r.arrangement_at_your_tempo.map((x) => x.bars)).toEqual([18, 36, 18, 36]);
    expect(r.tone_check.note).toMatch(/not measured yet/);
    expect(readTools.map((t) => t.name)).toContain('get_reference');
    // No audio, notes or chords of the reference anywhere in what Studio reads.
    expect(JSON.stringify(r)).not.toMatch(/notes|chord|waveform|samples/i);
  });

  it('the prompt teaches “make it sound like my reference” and never to copy it', () => {
    expect(STUDIO_PROMPT).toMatch(/"Make it sound like my reference", "match my reference", "like that song": match_reference with nothing named/);
    expect(STUDIO_PROMPT).toMatch(/Never copy the reference: no melodies, chords, drum patterns, samples or lyrics from it/);
  });
});

describe('the reference song in a project', () => {
  it('is only numbers (a sample ref aside)', () => {
    const json = JSON.stringify(fakeReference());
    expect(json).not.toMatch(/Float32Array|base64|data:audio/);
    expect(DROP_SONG.length).toBe(4);
  });
});
