import { afterEach, describe, expect, it } from 'vitest';
import { automationModelOf, automationAt } from '@core/automation/model';
import { resolveTarget } from '@core/automation/targets';
import { tempoMapOf } from '@core/automation/tempo';
import { fakeAnalysis, type FakeSong } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import { stretchScale, playbackMode } from '@core/audio/playback';
import { newId } from '@core/model/ids';
import { targetKey } from '@core/model/targets';
import type { AudioClip, Project, SampleRef } from '@core/model/types';
import { repairProject } from '@core/schema/migrate';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { specsResolver } from '../arrange/env';
import { createTestServices } from '../testing';
import { fakeAnalyzer, setTrackAnalyzer } from './analyzer';
import { DECK_NAMES, djLines, makeMix, tweakTransition, type MixSong } from './mix';

const BAR = 3840;

function songs(specs: (FakeSong & { name: string })[]) {
  const byHash = new Map<string, TrackAnalysis>();
  const list: MixSong[] = specs.map((sp) => {
    const hash = [...sp.name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64);
    const analysis = fakeAnalysis({ ...sp, hash });
    byHash.set(hash, analysis);
    const ref: SampleRef = { id: newId.sample(), name: sp.name, source: { kind: 'embedded', hash, ext: 'wav' }, durationSec: analysis.durationSec, channels: 2 };
    return { ref, title: sp.name };
  });
  const analyzer = fakeAnalyzer(byHash);
  setTrackAnalyzer(analyzer);
  return { list, analyzer };
}

const THREE: (FakeSong & { name: string })[] = [
  { name: 'Alpha', bpm: 124, key: { root: 9, mode: 'minor' }, bars: 96 },
  { name: 'Bravo', bpm: 126, key: { root: 4, mode: 'minor' }, bars: 96, firstDownbeat: 0.37 },
  { name: 'Charlie', bpm: 128, key: { root: 11, mode: 'minor' }, bars: 96 },
];
const KEEP = { order: 'keep', energy: 'party', transition: 'auto', mixTempo: 'follow' } as const;

const laneName = (p: Project, c: { laneId: string }) => p.playlist.lanes[c.laneId as never]?.name;

afterEach(() => setTrackAnalyzer(null));

describe('making a DJ mix', () => {
  it('writes the mix as one undo step: decks, songs alternating on Deck A/B, markers, song mode', async () => {
    const s = createTestServices();
    const { list } = songs(THREE);
    const before = s.history.steps().done.length;
    const res = await makeMix(s, list, KEEP);
    expect(s.history.steps().done.length).toBe(before + 1);
    const p = s.doc.getState().project;
    expect(projectViolations(p)).toEqual([]);
    expect(p.dj!.songs.map((x) => x.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(p.dj!.songs.map((x) => x.deck)).toEqual(['A', 'B', 'A']);
    // Every song's clips are on its deck's track and its channel plays through that deck.
    const insertName = (id: string) => p.mixer.inserts[id as never]?.name;
    for (const song of p.dj!.songs) {
      const ch = Object.values(p.channels).find((c) => c.kind === 'audioClip' && c.sampleId === song.sampleId)!;
      expect(ch.kind === 'audioClip' && ch.stretch).toBe('stretch');
      expect(insertName((ch as { output: string }).output)).toBe(DECK_NAMES[song.deck]);
      const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.channelId === ch.id);
      expect(clips.length).toBeGreaterThan(0);
      for (const c of clips) expect(laneName(p, c)).toBe(DECK_NAMES[song.deck]);
    }
    // Deck tracks: EQ Pro and Filter, an echo send at zero; the master ends in a Limiter.
    for (const deck of ['Deck A', 'Deck B']) {
      const ins = Object.values(p.mixer.inserts).find((x) => x.name === deck)!;
      expect(ins.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.eq-pro', 'agstudio.filter']);
      expect(ins.fx[0]!.plugin.params).toMatchObject({ b1On: true, b1Freq: 20, b8On: true, b8Freq: 20000 });
      const echo = Object.values(p.mixer.inserts).find((x) => x.name === 'Echo')!;
      expect(ins.routes.find((r) => r.to === echo.id)!.level).toBe(0);
    }
    expect(p.mixer.inserts['master' as never]!.fx.at(-1)!.plugin.pluginId).toBe('agstudio.limiter');
    expect(Object.values(p.playlist.markers).map((m) => m.name).sort()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(s.view.getState().mode).toBe('song');
    expect(res.plan.transitions).toHaveLength(2);
    // Undo removes all of it.
    s.history.undo();
    expect(s.doc.getState().project.dj).toBeUndefined();
    expect(Object.values(s.doc.getState().project.playlist.clips)).toHaveLength(0);
  });

  it('plays each song at its own tempo with ramps in the transitions, unstretched where it plays alone', async () => {
    const s = createTestServices();
    const { list } = songs(THREE);
    const { plan } = await makeMix(s, list, KEEP);
    const p = s.doc.getState().project;
    const map = tempoMapOf(p, 'song');
    for (const t of plan.tempo) expect(map.bpmAt(t.tick)).toBeCloseTo(t.bpm, 3);
    const t1 = plan.transitions[0]!;
    expect(map.bpmAt(t1.start - BAR)).toBe(124);
    expect(map.bpmAt(t1.start + t1.length)).toBe(126);
    // Each clip plays at one tempo; the solo ones need no stretched copy.
    for (const c of Object.values(p.playlist.clips)) {
      if (c.kind !== 'audio') continue;
      const ch = p.channels[c.channelId];
      if (ch?.kind !== 'audioClip' || ch.stretch !== 'stretch') continue;
      expect(map.nextChange(c.start)).toBeGreaterThanOrEqual(c.start + c.length);
    }
    const alpha = Object.values(p.channels).find((c) => c.name === 'Alpha')!;
    const first = Object.values(p.playlist.clips).find((c) => c.kind === 'audio' && c.channelId === alpha.id && c.start === 0) as AudioClip;
    expect(stretchScale(playbackMode(alpha as never), map, first.start)).toBe(1);
  });

  it('ends every curve where its control sits', async () => {
    const s = createTestServices();
    const { list } = songs(THREE);
    await makeMix(s, list, KEEP);
    const p = s.doc.getState().project;
    const model = automationModelOf(p);
    let curves = 0;
    for (const ch of Object.values(p.channels)) {
      if (ch.kind !== 'automation' || !ch.target || ch.target.kind === 'tempo') continue;
      curves++;
      const res = resolveTarget(p, ch.target, specsResolver(s))!;
      expect(ch.points.at(-1)!.value).toBeCloseTo(res.toNormalized(res.base), 9);
      const span = model.targets.get(targetKey(ch.target))!;
      const end = Math.max(...span.spans.map((x) => x.end));
      expect(automationAt(span, end + BAR)!.value).toBeCloseTo(res.toNormalized(res.base), 9);
    }
    expect(curves).toBeGreaterThan(4);
    // Curves for one deck never overlap on a track.
    const clips = Object.values(p.playlist.clips).filter((c) => c.kind === 'automation');
    for (const a of clips)
      for (const b of clips) if (a !== b && a.laneId === b.laneId) expect(a.start >= b.start + b.length || b.start >= a.start + a.length).toBe(true);
  });

  it('replaces its own previous mix when made again', async () => {
    const s = createTestServices();
    const { list } = songs(THREE);
    await makeMix(s, list, KEEP);
    const count = (p: Project) => ({ ch: p.channelOrder.length, clips: Object.keys(p.playlist.clips).length, markers: Object.keys(p.playlist.markers).length, inserts: p.mixer.order.length, samples: Object.keys(p.samples).length });
    const first = count(s.doc.getState().project);
    await makeMix(s, list, KEEP);
    expect(count(s.doc.getState().project)).toEqual(first);
    await makeMix(s, list.slice(0, 2), KEEP);
    const p = s.doc.getState().project;
    expect(p.dj!.songs).toHaveLength(2);
    expect(Object.keys(p.playlist.markers)).toHaveLength(2);
    expect(projectViolations(p)).toEqual([]);
  });

  it('changes one transition and keeps the others', async () => {
    const s = createTestServices();
    const { list, analyzer } = songs(THREE);
    const { plan } = await makeMix(s, list, KEEP);
    const calls = analyzer.calls;
    const p0 = s.doc.getState().project;
    const charlie = p0.dj!.songs[2]!.sampleId;
    const res = tweakTransition(s, charlie, { bars: 32, recipe: 'filter' });
    expect(analyzer.calls).toBe(calls);
    expect(res.plan.transitions[1]).toMatchObject({ bars: 32, recipe: 'filter' });
    expect(res.plan.transitions[0]).toEqual(plan.transitions[0]);
    const p = s.doc.getState().project;
    expect(p.dj!.tweaks[charlie]).toEqual({ bars: 32, recipe: 'filter' });
    expect(p.dj!.options.order).toBe('keep');
    expect(djLines(p).join('\n')).toMatch(/3\. “Charlie”: 128 BPM, key 10A, Deck A, from bar \d+ \(transition in: 32 bars, filter\)/);
    s.history.undo();
    expect(s.doc.getState().project.dj!.tweaks).toEqual({});
  });

  it('survives repair and drops songs whose samples are gone', async () => {
    const s = createTestServices();
    const { list } = songs(THREE);
    await makeMix(s, list, KEEP);
    const p = s.doc.getState().project;
    expect(repairProject(p).repairs).toEqual([]);
    expect(repairProject(p)).toEqual({ project: p, repairs: [] });
    const broken = JSON.parse(JSON.stringify(p)) as Project;
    delete broken.samples[broken.dj!.songs[1]!.sampleId];
    const fixed = repairProject(broken).project;
    expect(fixed.dj!.songs.map((x) => x.title)).toEqual(['Alpha', 'Charlie']);
  });
});
