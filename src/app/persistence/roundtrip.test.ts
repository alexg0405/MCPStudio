import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { fakeAnalysis, type FakeSong } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import { readProjectFile, writeProjectFile } from '@core/io/project-file';
import { createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import type { AudioClipChannel, ClipId, Project, SampleRef } from '@core/model/types';
import { repairProject } from '@core/schema/migrate';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { fakeAnalyzer, setTrackAnalyzer } from '../dj/analyzer';
import { makeMix, type MixSong } from '../dj/mix';
import { createTestServices } from '../testing';
import { TEMPLATES, templateProject } from '../templates';
import { createMemoryBlobStore } from './blob-store';
import { buildProjectFile, openProjectBlob, openProjectFile, writeProjectTo } from './project-io';

/**
 * Save then open must give back the project that was saved (after repair), whichever writer and
 * reader are used: the one-shot zip or the streaming one, the in-memory reader or the File reader.
 */

const VIEW = { mode: 'song', windows: [{ id: 'w1', type: 'playlist', x: 10, y: 20 }], loop: null };

const sameJson = (a: unknown, b: unknown) => JSON.parse(JSON.stringify(a)) as unknown as typeof b;

async function roundTrip(project: Project, view: unknown = VIEW) {
  const expected = repairProject(sameJson(project, project)).project;
  const store = createMemoryBlobStore();
  const results: Record<string, { project: Project; view: unknown; repairs: string[] }> = {};

  const sync = await buildProjectFile(project, view, 'test', { store });
  results.syncOpen = await openProjectFile(sync, { store: createMemoryBlobStore() });

  const chunks: Uint8Array[] = [];
  await writeProjectTo(
    async (b) => {
      chunks.push(b);
    },
    project,
    view,
    'test',
    { store },
  );
  const blob = new Blob(chunks as BlobPart[]);
  results.streamBlob = await openProjectBlob(blob, { store: createMemoryBlobStore() });
  results.streamSync = await openProjectFile(new Uint8Array(await blob.arrayBuffer()), { store: createMemoryBlobStore() });
  results.syncBlob = await openProjectBlob(new Blob([sync as BlobPart]), { store: createMemoryBlobStore() });
  for (const [name, r] of Object.entries(results)) {
    expect(r.project, name).toEqual(expected);
    expect(r.view, name).toEqual(view);
    expect(r.repairs, name).toEqual([]);
  }
  return expected;
}

describe('save then open gives back the project', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('template %s', async (_id, t) => {
    const { project } = templateProject(createTestServices(), t);
    await roundTrip(project);
  });

  it('the stacked song', async () => {
    const project = produce(createEmptyProject(), (d) => {
      buildStackedSong(d as Project);
    });
    await roundTrip(project);
  });

  it('a project with a Sound filter record (tempo, track and pieces)', async () => {
    const s = createTestServices();
    const { project: base } = templateProject(s, TEMPLATES[0]!);
    const clip = Object.values(base.playlist.clips)[0]!;
    const project = produce(base, (d) => {
      const insertId = d.mixer.order[1]!;
      const ch: AudioClipChannel = {
        kind: 'audioClip',
        id: 'ch_filtered' as AudioClipChannel['id'],
        name: 'Nightcore (bar 1)',
        color: '#888888',
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        output: d.mixer.order[0]!,
        sampleId: 'smp_f' as AudioClipChannel['sampleId'],
        filter: {
          preset: 'nightcore',
          from: clip.start,
          to: clip.start + clip.length,
          originals: [{ ...clip }],
          pieces: ['piece1' as ClipId],
          insert: { id: insertId, made: false, name: 'Insert 1', slots: [] },
          tempo: { bpm: 140 },
        },
      };
      d.samples[ch.sampleId] = {
        id: ch.sampleId,
        name: 'f',
        source: { kind: 'embedded', hash: 'a'.repeat(64), ext: 'wav', originalName: 'f.wav' },
        durationSec: 3.5,
        channels: 2,
      };
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
    });
    const expected = await roundTripAllowMissing(project);
    expect((expected.channels['ch_filtered' as never] as AudioClipChannel).filter).toEqual(
      (project.channels['ch_filtered' as never] as AudioClipChannel).filter,
    );
  });

  describe('a DJ mix', () => {
    afterEach(() => setTrackAnalyzer(null));
    it('songs, decks, transitions and tweaks', async () => {
      const specs: (FakeSong & { name: string })[] = [
        { name: 'Alpha', bpm: 124, key: { root: 9, mode: 'minor' }, bars: 96 },
        { name: 'Bravo', bpm: 126, key: { root: 4, mode: 'minor' }, bars: 96, firstDownbeat: 0.37 },
        { name: 'Charlie', bpm: 128, key: { root: 11, mode: 'minor' }, bars: 96 },
        { name: 'Delta', bpm: 122, key: { root: 2, mode: 'major' }, bars: 80 },
      ];
      const byHash = new Map<string, TrackAnalysis>();
      const list: MixSong[] = specs.map((sp) => {
        const hash = [...sp.name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64);
        const analysis = fakeAnalysis({ ...sp, hash });
        byHash.set(hash, analysis);
        const ref: SampleRef = {
          id: newId.sample(),
          name: sp.name,
          source: { kind: 'embedded', hash, ext: 'wav' },
          durationSec: analysis.durationSec,
          channels: 2,
        };
        return { ref, title: sp.name };
      });
      setTrackAnalyzer(fakeAnalyzer(byHash));
      const s = createTestServices();
      await makeMix(s, list, { order: 'keep', energy: 'party', transition: 'auto', mixTempo: 'follow' });
      const project = s.doc.getState().project;
      expect(projectViolations(project)).toEqual([]);
      const expected = await roundTripAllowMissing(project);
      expect(expected.dj).toEqual(project.dj);
    });
  });

  const PROJ = process.env.AG_PROJ;
  it.skipIf(!PROJ || !existsSync(PROJ))("the user's proj2.agproj", async () => {
    const bytes = new Uint8Array(readFileSync(PROJ!));
    const first = readProjectFile(bytes);
    expect(first.repairs).toEqual([]);
    const again = readProjectFile(writeProjectFile({ project: first.project, view: first.view, samples: first.samples, appVersion: 'test' }));
    expect(again.project).toEqual(first.project);
    expect(again.view).toEqual(first.view);
    await roundTrip(first.project, first.view);
  });
});

/** Like roundTrip for projects that reference embedded samples the store doesn't have (reported as silent). */
async function roundTripAllowMissing(project: Project): Promise<Project> {
  const expected = repairProject(sameJson(project, project)).project;
  const store = createMemoryBlobStore();
  const bytes = await buildProjectFile(project, VIEW, 'test', { store });
  const opened = await openProjectFile(bytes, { store: createMemoryBlobStore() });
  expect(opened.project).toEqual(expected);
  expect(opened.view).toEqual(VIEW);
  const chunks: Uint8Array[] = [];
  await writeProjectTo(async (b) => void chunks.push(b), project, VIEW, 'test', { store });
  const viaBlob = await openProjectBlob(new Blob(chunks as BlobPart[]), { store: createMemoryBlobStore() });
  expect(viaBlob.project).toEqual(expected);
  return expected;
}
