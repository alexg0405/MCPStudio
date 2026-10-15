/**
 * Studio's mix analysis through the real pipeline: offline renders of the mix and of every
 * mixer track, measured (loudness, peaks, tone, width) and turned into findings.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { analyzeMix, formatMixReport } from '@app/analysis/mix';
import { createServices, type Services } from '@app/services';
import { MASTER, type ClipId, type LaneId, type Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { kitProject, withInsert } from '../helpers/fixtures';

const BAR = 3840;

/** Kick on Insert 1, hats on Insert 2 (hot), the snare straight to the master; two bars on the playlist. */
function song(): Project {
  const kit = kitProject(
    [
      { generator: 'kit/kick', steps: [0, 8] },
      { generator: 'kit/snare', steps: [4, 12] },
      { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
    ],
    120,
  );
  const [kick, , hat] = kit.channels;
  let p = withInsert(kit.project, [kick!], { index: 1 }).project;
  p = withInsert(p, [hat!], { index: 2 }).project;
  return produce(p, (d) => {
    const [, , ins2] = d.mixer.order;
    d.mixer.inserts[ins2!]!.volume = 3; // ~+9.5 dB: too hot
    addClips(d, [
      {
        kind: 'pattern',
        id: 'c1' as ClipId,
        laneId: d.playlist.laneOrder[0] as LaneId,
        start: 0,
        length: 2 * BAR,
        patternId: kit.patternId,
        offset: 0,
      },
    ]);
  });
}

describe('mix analysis', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('measures the mix and each mixer track, and says what to fix', async () => {
    const s = createServices({ project: song() });
    services.push(s);
    s.view.getState().setMode('song');
    const progress: string[] = [];
    const report = await analyzeMix(s, { onProgress: (_f, label) => progress.push(label) });
    expect(report.what).toBe('4 s: bars 1–2 of the song');
    expect(report.master.silent).toBe(false);
    expect(Number.isFinite(report.master.lufs)).toBe(true);
    expect(report.master.truePeakDb).not.toBeNull();
    // One report per mixer track that plays: the snare on the master, the kick, the hats.
    expect(report.tracks.map((t) => t.channels.join()).sort()).toEqual(['kit/hat-closed', 'kit/kick', 'kit/snare']);
    const kick = report.tracks.find((t) => t.channels.includes('kit/kick'))!;
    const hat = report.tracks.find((t) => t.channels.includes('kit/hat-closed'))!;
    // The kick lives low, the hats high.
    expect(kick.m.bands[0]! + kick.m.bands[1]!).toBeGreaterThan(50);
    expect(hat.m.bands[4]! + hat.m.bands[5]!).toBeGreaterThan(50);
    expect(progress).toContain('The mix');
    const text = formatMixReport(report);
    expect(text).toContain('Master (what you hear, after its effects):');
    expect(text.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThanOrEqual(3);
    // The project didn't change, and the master track is untouched.
    expect(s.doc.getState().project.mixer.inserts[MASTER]!.fx).toEqual([]);
  });

  it('listens to the current pattern on a loop in pattern mode', async () => {
    const s = createServices({ project: song() });
    services.push(s);
    s.view.getState().setMode('pattern');
    const report = await analyzeMix(s, { maxSeconds: 10 });
    expect(report.what).toMatch(/^\d+ s: the pattern “.+” on a loop$/);
    expect(report.seconds).toBeGreaterThanOrEqual(8);
    expect(report.master.silent).toBe(false);
  });
});
