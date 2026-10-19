/**
 * Characterization of the arrangement queries: the song check, the clip runs, pattern spans, stacked copies and
 * per-bar activity of a messy song (stacked layers, long repeats, unnamed tracks, duplicate automation), before
 * and after tidying it, whole and in windows. It exists so the queries can be reorganised without changing a result.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildStackedSong } from '../fixtures/stacked-song';
import { sha256Hex } from '../io/hash';
import { createEmptyProject } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { tidySong } from '../ops/tidy';
import { barActivity } from './activity';
import { laneRuns, patternSpans, songCheck, stackedCopies } from './arrangement';

const BAR = 3840;

beforeEach(() => setIdSource(seededBytes(11)));

async function fingerprint(value: unknown): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
  return hash.slice(0, 12);
}

describe('arrangement query characterization', () => {
  it('reads a messy song and its tidied version the same way', async () => {
    const messy = produce(createEmptyProject({ now: new Date(0) }), (d) => void buildStackedSong(d));
    const tidy = produce(messy, (d) => void tidySong(d));
    const lines: string[] = [];
    for (const [label, p] of [
      ['messy', messy],
      ['tidy', tidy],
    ] as const) {
      lines.push(`${label} songCheck: ${JSON.stringify(songCheck(p))}`);
      const copies = stackedCopies(p);
      lines.push(`${label} stackedCopies: ${copies.length} ${await fingerprint(copies)}`);
      const among = new Set(copies.slice(0, 3).map((c) => c.clipId));
      lines.push(`${label} stackedCopies among: ${JSON.stringify(stackedCopies(p, among))}`);
      const spans = [...patternSpans(p)];
      lines.push(`${label} patternSpans: ${spans.length} ${await fingerprint(spans)}`);
      for (const cuts of [[], [37 * BAR, 69 * BAR]]) {
        const runs = p.playlist.laneOrder.flatMap((lane) => laneRuns(p, lane, cuts));
        lines.push(`${label} laneRuns cuts ${cuts.length}: ${runs.length} ${await fingerprint(runs)}`);
      }
      for (const [from, to] of [
        [0, 113 * BAR],
        [36 * BAR, 54 * BAR],
        [100 * BAR, 130 * BAR],
        [5 * BAR + 100, 6 * BAR - 100],
        [0, 1],
      ] as const) {
        const activity = barActivity(p, from, to);
        lines.push(
          `${label} barActivity ${from}-${to}: ${activity.length} bars, ${activity.reduce((n, b) => n + b.total, 0)} notes ${await fingerprint(activity)}`,
        );
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/arrangement-queries.txt');
  });
});
