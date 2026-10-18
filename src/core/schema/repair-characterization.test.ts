/**
 * Characterization of schema migration and repair: the exact output (migrated project, repair messages
 * and the error of a project that cannot be read) for every fixture, one project that uses every
 * optional part, and a few thousand seeded corruptions of those.
 *
 * It exists so the migration and repair code can be reorganised without changing a single byte of what
 * it produces: saved projects depend on it. If a deliberate change to repair behaviour makes it fail,
 * review the snapshot diff and regenerate it with `vitest -u`.
 */
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { seededBytes, setIdSource } from '../model/ids';
import { sha256Hex } from '../io/hash';
import { SchemaError, migrateProject, repairProject } from './migrate';

const FIXTURES = import.meta.glob<unknown>('/test/fixtures/projects/*.json', { eager: true, import: 'default' });

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A current-schema project that carries every optional part repair knows about. */
function richProject(): Json {
  const project = clone(FIXTURES['/test/fixtures/projects/v3-basic.json']) as Json;
  const playlist = project.playlist as Json;
  const lanes = playlist.lanes as Json;
  const clips = playlist.clips as Json;
  const channels = project.channels as Json;
  const patterns = project.patterns as Json;
  const hash = 'ee248313be9a583d2f715d46334ab3c5c6ec529f0552b20199681bcdf3ebffb1';

  (lanes.lane_track00001 as Json).takes = { group: 'rec1', role: 'comp', crossfadeMs: 20 };
  (lanes.lane_track00002 as Json).takes = { group: 'rec1', role: 'take' };
  Object.assign(clips.clip_audclip001 as Json, {
    take: { group: 'rec1', index: 0 },
    pitchEdit: {
      notes: [
        { from: 0, to: 0.5, pitch: 60, shift: 10 },
        { from: 0.6, to: 1, pitch: 62 },
      ],
    },
  });
  const audioChannel = channels.ch_audio00001 as Json;
  audioChannel.filter = {
    preset: 'nightcore',
    from: 0,
    to: 3840,
    originals: [clips.clip_patclip001],
    pieces: ['clip_patclip001'],
    insert: { id: 'ins_synth00001', made: true, name: 'Filter', slots: ['slot_a'] },
    tempo: { bpm: 120 },
  };
  patterns.pat_verse00001 = {
    ...(patterns.pat_verse00001 as Json),
    derived: {
      from: 'pat_intro00001',
      steps: [{ kind: 'thin', from: 0, to: 960, parts: ['a'] }],
      seed: 3,
      hash: 'abc',
    },
  };
  project.dj = {
    songs: [
      {
        sampleId: 'smp_loop000001',
        title: 'Song A',
        bpm: 120,
        camelot: '8A',
        deck: 'A',
        start: 0,
        end: 3840,
        pinned: true,
      },
      { sampleId: 'smp_kick000001', title: 'Song B', bpm: null, camelot: null, deck: 'B', start: 3840, end: 7680 },
    ],
    options: {
      order: 'auto',
      energy: 'party',
      transition: 'smooth',
      mixTempo: 'follow',
      lengthTargetMin: 30,
      keyLock: true,
    },
    tweaks: { smp_kick000001: { bars: 8, recipe: 'echo', riser: true } },
    made: { channels: ['ch_audio00001'], markers: ['mk_intro'] },
  };
  const bands = [-10, -12, -14, -20, -25, -30, -40, -55];
  project.reference = {
    sampleId: 'smp_loop000001',
    title: 'Reference',
    hash,
    durationSec: 200,
    bpm: 124,
    beatsPerBar: 4,
    key: { root: 5, mode: 'minor', camelot: '4A', confidence: 0.8 },
    lufs: -9,
    truePeakDb: -1,
    bands,
    width: 0.4,
    energy: [0.1, 0.4, 0.9, 0.5],
    sections: [
      { kind: 'intro', startSec: 0, endSec: 20, bars: 10, energy: 0.2, bands, width: 0.2 },
      { kind: 'drop', startSec: 20, endSec: 60, bars: 20, energy: 0.9, bands, width: 0.5 },
    ],
    version: 1,
  };
  project.launcher = {
    quantize: 'bar',
    tracks: {
      lt_a: {
        id: 'lt_a',
        name: 'Drums',
        laneId: 'lane_track00001',
        slots: {
          sc_1: {
            content: { kind: 'pattern', patternId: 'pat_intro00001' },
            mode: 'toggle',
            loop: false,
            quantize: 'beat',
          },
          sc_2: {
            content: {
              kind: 'audio',
              channelId: 'ch_audio00001',
              length: 3840,
              offsetSec: 0.5,
              gain: 0.5,
              fadeIn: 0.1,
            },
            follow: { kind: 'next', bars: 4 },
          },
        },
      },
    },
    trackOrder: ['lt_a'],
    scenes: { sc_1: { id: 'sc_1', name: 'Intro' }, sc_2: { id: 'sc_2', name: 'Drop', color: '#fff' } },
    sceneOrder: ['sc_1', 'sc_2'],
  };
  return project;
}

/** Output of the whole load path for one input, as plain text. */
function outcome(input: unknown): string {
  try {
    const { project, migratedFrom } = migrateProject(clone(input));
    const { project: repaired, repairs } = repairProject(project);
    return JSON.stringify({ migratedFrom, repairs, project: repaired });
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return JSON.stringify({ error: error.code, message: error.message, version: error.version });
  }
}

type EditList = readonly { at: number; value: unknown }[];

/** A corrupted copy of `base`: each edit replaces or deletes one value somewhere in the document. */
function corrupted(base: Json, edits: EditList): Json {
  const paths: (string | number)[][] = [];
  const walk = (value: unknown, path: (string | number)[]) => {
    paths.push(path);
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value))
        walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
    }
  };
  walk(base, []);
  const copy = clone(base);
  for (const { at, value } of edits) {
    const path = paths[at % paths.length]!;
    if (path.length === 0) continue;
    let node: unknown = copy;
    for (const key of path.slice(0, -1)) node = (node as Record<string | number, unknown> | undefined)?.[key];
    if (typeof node !== 'object' || node === null) continue;
    const key = path[path.length - 1]!;
    // An earlier edit may have turned an object into an array: an array's own `length` is not editable.
    if (Array.isArray(node) && typeof key === 'string') continue;
    if (value === undefined) delete (node as Record<string | number, unknown>)[key];
    else Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

const editArbitrary = fc.array(fc.record({ at: fc.nat(), value: fc.oneof(fc.jsonValue(), fc.constant(undefined)) }), {
  minLength: 1,
  maxLength: 10,
});
const CORRUPTIONS_PER_BASE = 700;

beforeEach(() => {
  setIdSource(seededBytes(7));
});

describe('migration and repair output', () => {
  it('stays identical for the fixtures and the rich project', async () => {
    const lines: string[] = [];
    for (const name of Object.keys(FIXTURES).sort()) lines.push(`${name}\n${outcome(FIXTURES[name])}`);
    lines.push(`rich project\n${outcome(richProject())}`);
    await expect(lines.join('\n\n') + '\n').toMatchFileSnapshot('./__snapshots__/repair-fixtures.txt');
  });

  it('stays identical for hand-made damage that random edits rarely produce', async () => {
    const lane = (p: Json) => ((p.playlist as Json).lanes as Json).lane_track00001 as Json & { takes: Json };
    const reference = (p: Json) => p.reference as Json & { sections: Json[] };
    const launcherTrack = (p: Json) =>
      ((p.launcher as Json).tracks as Record<string, Json & { slots: Record<string, Json> }>).lt_a!;
    const damages: [string, (project: Json) => void][] = [
      ['crossfade is text', (p) => (lane(p).takes.crossfadeMs = 'x')],
      ['crossfade too long', (p) => (lane(p).takes.crossfadeMs = 9000)],
      ['reference energy too long', (p) => (reference(p).energy = Array.from({ length: 1500 }, (_, i) => (i % 7) / 5))],
      [
        'reference sections too many',
        (p) => {
          const ref = reference(p);
          ref.sections = Array.from({ length: 250 }, (_, i) => ({ ...ref.sections[0], startSec: i, endSec: i + 1 }));
        },
      ],
      ['reference section without bars', (p) => void Reflect.deleteProperty(reference(p).sections[1]!, 'bars')],
      [
        'launcher too many tracks',
        (p) => {
          const launcher = p.launcher as Json & { tracks: Json; trackOrder: string[] };
          for (let i = 0; i < 40; i++) {
            launcher.tracks[`lt_${i}`] = { id: `lt_${i}`, name: `T${i}`, slots: {} };
            launcher.trackOrder.push(`lt_${i}`);
          }
        },
      ],
      [
        'launcher slot damaged',
        (p) => {
          const slots = launcherTrack(p).slots;
          slots.sc_1 = { content: { kind: 'pattern', patternId: 'gone' } };
          slots.sc_9 = { content: { kind: 'pattern', patternId: 'pat_intro00001' } };
          (slots.sc_2 as Json & { follow: Json }).follow.bars = 99;
        },
      ],
      [
        'dj songs damaged',
        (p) => {
          const dj = p.dj as Json & { songs: Json[]; options: Json };
          dj.songs[0]!.deck = 'C';
          dj.songs[1]!.bpm = 'fast';
          dj.options.mixTempo = 400;
          dj.options.energy = 'wild';
        },
      ],
      [
        'derived loop',
        (p) => {
          const patterns = p.patterns as Record<string, Json & { derived?: Json }>;
          patterns.pat_intro00001!.derived = { ...patterns.pat_verse00001!.derived, from: 'pat_verse00001' };
        },
      ],
      ['take group without a comp', (p) => void Reflect.deleteProperty(lane(p), 'takes')],
    ];
    const lines: string[] = [];
    for (const [name, damage] of damages) {
      const project = richProject();
      damage(project);
      lines.push(`${name}\n${outcome(project)}`);
    }
    await expect(lines.join('\n\n') + '\n').toMatchFileSnapshot('./__snapshots__/repair-hand-made.txt');
  });

  it('stays identical for seeded corruptions (one hash per case)', async () => {
    const bases: [string, Json][] = [
      ['rich', richProject()],
      ...Object.keys(FIXTURES)
        .sort()
        .map((name): [string, Json] => [name.replace('/test/fixtures/projects/', ''), FIXTURES[name] as Json]),
    ];
    const lines: string[] = [];
    for (const [baseName, base] of bases) {
      const cases = fc.sample(editArbitrary, { numRuns: CORRUPTIONS_PER_BASE, seed: 20261018 });
      for (const [index, edits] of cases.entries()) {
        setIdSource(seededBytes(7));
        const digest = await sha256Hex(new TextEncoder().encode(outcome(corrupted(base, edits))));
        lines.push(`${baseName} #${index} ${digest.slice(0, 16)}`);
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/repair-corruptions.txt');
  });
});
