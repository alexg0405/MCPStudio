/**
 * Characterization of the stacked-song fixture: a fingerprint of every part of the project it builds (mixer,
 * channels, samples, patterns and their notes, lanes, clips, markers) with seeded ids, so even the order in which it
 * makes things is pinned. Many tests lean on this song; it must come out the same.
 *
 * If a deliberate change makes it fail, review the cause and regenerate the snapshot with `vitest -u`.
 */
import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import { createEmptyProject } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { buildStackedSong } from './stacked-song';

beforeEach(() => setIdSource(seededBytes(5)));

async function fingerprint(value: unknown): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
  return hash.slice(0, 12);
}

describe('stacked song characterization', () => {
  it('builds the same song', async () => {
    let built!: ReturnType<typeof buildStackedSong>;
    const project = produce(createEmptyProject({ now: new Date(0) }), (d) => {
      built = buildStackedSong(d);
    });
    const lines = [
      `transport ${JSON.stringify(project.transport)}`,
      `mixer ${project.mixer.order.length} inserts ${await fingerprint(project.mixer)}`,
      `channels ${project.channelOrder.length} ${await fingerprint([project.channelOrder, project.channels])}`,
      `samples ${Object.keys(project.samples).length} ${await fingerprint(project.samples)}`,
      `patterns ${project.patternOrder.length} ${await fingerprint([project.patternOrder, project.patterns])}`,
      `lanes ${project.playlist.laneOrder.length} ${await fingerprint([project.playlist.laneOrder, project.playlist.lanes])}`,
      `clips ${Object.keys(project.playlist.clips).length} ${await fingerprint(project.playlist.clips)}`,
      `markers ${Object.keys(project.playlist.markers).length} ${await fingerprint(project.playlist.markers)}`,
      `returned ${await fingerprint(built)}`,
      `channel names ${project.channelOrder.map((id) => project.channels[id]!.name).join(' | ')}`,
      `pattern names ${project.patternOrder.map((id) => project.patterns[id]!.name).join(' | ')}`,
    ];
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/stacked-song.txt');
  });
});
