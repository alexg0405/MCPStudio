import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import {
  MASTER,
  SCHEMA_VERSION,
  type ChannelId,
  type InsertId,
  type MarkerId,
  type PatternId,
  type Project,
} from '../model/types';
import { MIGRATIONS, SchemaError, migrateProject, repairProject, type Migration } from './migrate';

/** Every saved-project fixture; each schema bump adds one (files named *broken* need repairs). */
const FIXTURES = import.meta.glob<unknown>('/test/fixtures/projects/*.json', { eager: true, import: 'default' });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fixture = (name: string) => clone(FIXTURES[`/test/fixtures/projects/${name}.json`]) as Project;

function repairOf(p: Project) {
  return repairProject(migrateProject(clone(p)).project);
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

beforeEach(() => {
  setIdSource(seededBytes(7));
});

describe('fixture corpus', () => {
  const names = Object.keys(FIXTURES);

  it('has a fixture for the current schema version', () => {
    const versions = Object.values(FIXTURES).map((f) => (f as { schemaVersion: number }).schemaVersion);
    expect(versions).toContain(SCHEMA_VERSION);
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it.each(names)('%s migrates and repairs to a consistent project', (name) => {
    const input = clone(FIXTURES[name]);
    const { project, migratedFrom } = migrateProject(input, MIGRATIONS);
    expect(migratedFrom).toBe((FIXTURES[name] as { schemaVersion: number }).schemaVersion);
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    const { project: repaired, repairs } = repairProject(project);
    expect(projectViolations(repaired)).toEqual([]);
    expect(repairProject(repaired).repairs).toEqual([]); // idempotent
    if (name.includes('broken')) expect(repairs.length).toBeGreaterThan(0);
    else {
      expect(repairs).toEqual([]);
      expect(repaired).toEqual(project);
    }
  });
});

describe('migrateProject', () => {
  it('returns current-schema data untouched without running migrations', () => {
    const json = fixture('v3-basic');
    const spy = vi.fn<Migration>((p) => p);
    const result = migrateProject(json, [spy, spy, spy, spy]);
    expect(result.project).toBe(json);
    expect(result.migratedFrom).toBe(3);
    expect(spy).not.toHaveBeenCalled();
  });

  it('upgrades v2: no markers yet; audio clips keep playing as before', () => {
    const v2 = fixture('v2-basic');
    const { project } = migrateProject(v2);
    expect(project.schemaVersion).toBe(3);
    expect(project.playlist.markers).toEqual({});
    expect(project.playlist.clips).toEqual(v2.playlist.clips);
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('unlinks frozen audio from a channel that is gone (M15 optional field)', () => {
    const p = fixture('v3-basic');
    const ch = Object.values(p.channels).find((c) => c.kind === 'audioClip');
    if (ch?.kind !== 'audioClip') throw new Error('fixture has no audio clip channel');
    expect(ch.frozenFrom).toBe('ch_synth00001');
    expect(repairProject(p).repairs).toEqual([]);
    for (const bad of ['ch_missing', 42, ch.id, 'ch_auto0000001']) {
      const q = fixture('v3-basic');
      const c = q.channels[ch.id] as unknown as Record<string, unknown>;
      c.frozenFrom = bad;
      const { project, repairs } = repairProject(q);
      expect(project.channels[ch.id]).not.toHaveProperty('frozenFrom');
      expect(repairs.join(' ')).toMatch(/frozen channel/);
    }
  });

  it('repairs v3 audio edits and markers', () => {
    const p = fixture('v3-basic');
    const audio = Object.values(p.playlist.clips).find((c) => c.kind === 'audio');
    if (audio?.kind === 'audio') Object.assign(audio, { gain: 9, fadeIn: -1 });
    const ch = Object.values(p.channels).find((c) => c.kind === 'audioClip');
    if (ch?.kind === 'audioClip') Object.assign(ch, { stretch: 'warp', pitch: 9000 });
    Object.assign(p.playlist.markers, { mk_bad: { id: 'mk_bad', tick: -5, name: 42 }, junk: 'x' });
    const { project, repairs } = repairProject(p);
    const fixedClip = Object.values(project.playlist.clips).find((c) => c.kind === 'audio');
    expect(fixedClip).toMatchObject({ gain: 4, fadeIn: 0 });
    const fixedCh = Object.values(project.channels).find((c) => c.kind === 'audioClip');
    expect(fixedCh).toMatchObject({ pitch: 2400 });
    expect(fixedCh && 'stretch' in fixedCh ? fixedCh.stretch : undefined).toBeUndefined();
    expect(project.playlist.markers['mk_bad' as MarkerId]).toEqual({ id: 'mk_bad', tick: 0, name: 'Marker' });
    expect(Object.keys(project.playlist.markers)).not.toContain('junk');
    expect(repairs.length).toBeGreaterThan(0);
  });

  it('upgrades v1: every insert routes to the master, no sidechains, no controller links', () => {
    const { project } = migrateProject(fixture('v1-basic'));
    expect(project.schemaVersion).toBe(3);
    expect(project.mixer.inserts[MASTER]!.routes).toEqual([]);
    for (const id of project.mixer.order.slice(1))
      expect(project.mixer.inserts[id]!.routes).toEqual([{ to: MASTER, level: 1, pre: false }]);
    for (const ins of Object.values(project.mixer.inserts))
      for (const slot of ins.fx) expect(slot.sidechain).toBeNull();
    expect(project.controllers).toEqual({});
  });

  it('runs an injected v0 → v1 migration on a copy, then the real ones', () => {
    const v1 = fixture('v1-basic');
    // A hypothetical v0 that called the project id `id`, kept the title at the top level and had `tempo`.
    const { projectId, meta, transport, ...rest } = v1;
    const v0 = { ...rest, schemaVersion: 0, id: projectId, title: meta.title, tempo: transport.bpm };
    const snapshot = clone(v0);
    const m0: Migration = (p) => {
      const { id, title, tempo, ...others } = p;
      return {
        ...others,
        projectId: id,
        meta: { title, createdAt: '2026-01-01T00:00:00.000Z', appVersion: '0.1.0', author: 'AGstudio tests' },
        transport: { bpm: tempo, timeSig: { num: 4, den: 4 }, swing: 0.2 },
      };
    };
    const { project, migratedFrom } = migrateProject(v0, [m0, ...MIGRATIONS.slice(1)]);
    expect(migratedFrom).toBe(0);
    expect(project.schemaVersion).toBe(SCHEMA_VERSION); // set by the runner after each step
    expect(project).toEqual(migrateProject(v1).project);
    expect(v0).toEqual(snapshot); // input not mutated
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('lets migrations mutate their argument', () => {
    const v1 = fixture('v1-basic');
    const v0 = { ...clone(v1), schemaVersion: 0, transport: { tempo: 99 } };
    const m0: Migration = (p) => {
      const t = p.transport as { tempo?: number; bpm?: number; timeSig?: unknown; swing?: number };
      t.bpm = t.tempo;
      delete t.tempo;
      t.timeSig = { num: 3, den: 4 };
      t.swing = 0;
      return p;
    };
    const { project } = migrateProject(v0, [m0, ...MIGRATIONS.slice(1)]);
    expect(project.transport).toEqual({ bpm: 99, timeSig: { num: 3, den: 4 }, swing: 0 });
    expect(v0.transport).toEqual({ tempo: 99 });
  });

  it('rejects data from a newer version', () => {
    const json = { ...fixture('v1-basic'), schemaVersion: SCHEMA_VERSION + 1 };
    const err = catchError(() => migrateProject(json));
    expect(err).toBeInstanceOf(SchemaError);
    expect(err).toMatchObject({ code: 'too-new', version: SCHEMA_VERSION + 1 });
  });

  it('rejects old versions without a migration path', () => {
    const json = { ...fixture('v1-basic'), schemaVersion: 0 };
    expect(catchError(() => migrateProject(json))).toMatchObject({ code: 'too-old', version: 0 });
    expect(catchError(() => migrateProject(json, []))).toMatchObject({ code: 'too-old' });
  });

  it('reports failing or broken migrations as invalid', () => {
    const json = { ...fixture('v1-basic'), schemaVersion: 0 };
    const boom = new Error('boom');
    const thrown = catchError(() =>
      migrateProject(json, [
        () => {
          throw boom;
        },
      ]),
    );
    expect(thrown).toMatchObject({ code: 'invalid' });
    expect((thrown as Error).cause).toBe(boom);
    expect(catchError(() => migrateProject(json, [() => null as never]))).toMatchObject({ code: 'invalid' });
    expect(catchError(() => migrateProject(json, [() => ({}), ...MIGRATIONS.slice(1)]))).toMatchObject({
      code: 'invalid',
    });
  });

  it('validates the structure', () => {
    for (const bad of [
      null,
      42,
      'project',
      [],
      {},
      { schemaVersion: '1' },
      { schemaVersion: 1.5 },
      { schemaVersion: -1 },
    ]) {
      expect(catchError(() => migrateProject(bad))).toMatchObject({ code: 'invalid' });
    }
    const missing = (mutate: (p: Record<string, unknown>) => void) => {
      const p = fixture('v1-basic') as unknown as Record<string, unknown>;
      mutate(p);
      return catchError(() => migrateProject(p));
    };
    expect(missing((p) => delete p.channels)).toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('channels'),
    });
    expect(missing((p) => (p.channelOrder = {}))).toMatchObject({ code: 'invalid' });
    expect(missing((p) => ((p.mixer as Record<string, unknown>).inserts = []))).toMatchObject({
      message: expect.stringContaining('mixer.inserts'),
    });
    expect(missing((p) => ((p.playlist as Record<string, unknown>).laneOrder = null))).toMatchObject({
      code: 'invalid',
    });
    expect(missing((p) => (p.samples = 'none'))).toMatchObject({ code: 'invalid' });
  });
});

describe('repairProject', () => {
  const builtinSample = (id: string) =>
    ({ id, name: id, source: { kind: 'builtin', generator: 'kit/kick', version: 1 } }) as Project['samples'][never];
  const audioChannel = (id: string, sampleId: string) =>
    ({
      kind: 'audioClip',
      id,
      name: id,
      color: '#fff',
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      output: MASTER,
      sampleId,
    }) as Project['channels'][ChannelId];
  const base = () => {
    const p = createEmptyProject({ now: new Date(0) });
    const ch = makeInstrumentChannel('Kick', makePluginInstance('agstudio.sampler', 1, { gain: 0 }));
    p.channels[ch.id] = ch;
    p.channelOrder.push(ch.id);
    return {
      p,
      ch: ch.id,
      pat: p.patternOrder[0] as PatternId,
      lane: p.playlist.laneOrder[0]!,
      ins: p.mixer.order[1]!,
    };
  };

  it('leaves a valid project alone and never mutates its input', () => {
    const { p } = base();
    const frozen = deepFreeze(clone(p));
    const { project, repairs } = repairProject(frozen);
    expect(repairs).toEqual([]);
    expect(project).toEqual(p);
    expect(project).not.toBe(frozen);
  });

  it('restores the Master track and puts it first', () => {
    const { p } = base();
    delete p.mixer.inserts[MASTER];
    p.mixer.order = p.mixer.order.filter((id) => id !== MASTER);
    const r1 = repairProject(p);
    expect(r1.project.mixer.order[0]).toBe(MASTER);
    expect(r1.project.mixer.inserts[MASTER]).toMatchObject({ id: MASTER, name: 'Master', volume: 1, fx: [] });
    expect(r1.repairs).toEqual(['Added the missing Master mixer track.']);

    const { p: q, ins: qIns } = base();
    q.mixer.order = [qIns, MASTER, ...q.mixer.order.filter((id) => id !== MASTER && id !== qIns)];
    const r2 = repairProject(q);
    expect(r2.project.mixer.order.slice(0, 2)).toEqual([MASTER, qIns]);
    expect(r2.repairs).toEqual(['Moved the Master track to the first mixer slot.']);
  });

  it('fixes order arrays: unknown ids, duplicates and forgotten records', () => {
    const { p, ch, pat, lane } = base();
    const lanes = p.playlist.laneOrder;
    p.channelOrder = ['ch_nothing000' as ChannelId, ch, ch];
    p.patternOrder = [];
    p.playlist.laneOrder = [lanes[1]!, lanes[1]!, 'lane_nope00000' as typeof lane, ...lanes.slice(2)];
    const { project, repairs } = repairProject(p);
    expect(project.channelOrder).toEqual([ch]);
    expect(project.patternOrder).toEqual([pat]);
    expect(project.playlist.laneOrder).toEqual([...lanes.slice(1), lane]);
    expect(repairs).toEqual([
      'Removed 1 unknown entry from the channel list.',
      'Removed 1 duplicate entry from the channel list.',
      'Added 1 pattern missing from the pattern list.',
      'Removed 1 unknown entry from the playlist track list.',
      'Removed 1 duplicate entry from the playlist track list.',
      'Added 1 playlist track missing from the playlist track list.',
    ]);
  });

  it('drops clips whose pattern, channel or lane is missing', () => {
    const { p, ch, pat, lane } = base();
    const audio = audioChannel('ch_audio00001', 'smp_x');
    p.samples['smp_x' as never] = builtinSample('smp_x');
    p.channels[audio.id] = audio;
    p.channelOrder.push(audio.id);
    const clip = (id: string, extra: object) => ({ id, laneId: lane, start: 0, length: 3840, ...extra });
    p.playlist.clips = {
      ok: clip('ok', { kind: 'pattern', patternId: pat, offset: 0 }),
      okAudio: clip('okAudio', { kind: 'audio', channelId: audio.id, offsetSec: 0 }),
      noPattern: clip('noPattern', { kind: 'pattern', patternId: 'pat_gone', offset: 0 }),
      noLane: clip('noLane', { kind: 'pattern', patternId: pat, offset: 0, laneId: 'lane_gone' }),
      noChannel: clip('noChannel', { kind: 'audio', channelId: 'ch_gone', offsetSec: 0 }),
      wrongKind: clip('wrongKind', { kind: 'audio', channelId: ch, offsetSec: 0 }),
    } as unknown as Project['playlist']['clips'];
    const { project, repairs } = repairProject(p);
    expect(Object.keys(project.playlist.clips)).toEqual(['ok', 'okAudio']);
    expect(repairs).toEqual(['Removed 4 playlist clips whose pattern, channel or track no longer exists.']);
  });

  it('routes channels with a missing insert to the master', () => {
    const { p, ch, ins } = base();
    p.channels[ch] = { ...p.channels[ch]!, output: 'ins_gone' as InsertId } as Project['channels'][ChannelId];
    const other = makeInstrumentChannel('Snare', makePluginInstance('x', 1, {}), { output: ins });
    p.channels[other.id] = other;
    p.channelOrder.push(other.id);
    const { project, repairs } = repairProject(p);
    expect(project.channels[ch]).toMatchObject({ output: MASTER });
    expect(project.channels[other.id]).toMatchObject({ output: ins });
    expect(repairs).toEqual(['Routed channel "Kick" to the Master track because its mixer track no longer exists.']);
  });

  it('drops note maps of deleted channels and clamps notes', () => {
    const { p, ch, pat } = base();
    const note = (id: string, extra: object) => ({ id, tick: 0, length: 240, key: 60, velocity: 0.5, ...extra });
    p.patterns[pat]!.notes = {
      [ch]: {
        a: note('a', { velocity: 2 }),
        b: note('b', { velocity: -1, tick: -5, length: 0.2, key: 300 }),
        c: note('c', {}),
      },
      ch_gone: { d: note('d', {}) },
    } as unknown as Project['patterns'][PatternId]['notes'];
    const { project, repairs } = repairProject(p);
    const notes = project.patterns[pat]!.notes;
    expect(Object.keys(notes)).toEqual([ch]);
    expect(notes[ch]).toEqual({
      a: note('a', { velocity: 1 }),
      b: note('b', { velocity: 0, tick: 0, length: 1, key: 127 }),
      c: note('c', {}),
    });
    expect(repairs).toEqual([
      'Clamped 2 note velocities into 0–1.',
      'Fixed 1 note with an invalid position, length or key.',
      'Removed notes for 1 channel that no longer exist.',
    ]);
  });

  it('clamps tempo, volumes and pans', () => {
    const { p, ch, ins } = base();
    p.transport.bpm = 5;
    Object.assign(p.channels[ch]!, { volume: 2, pan: -4 });
    Object.assign(p.mixer.inserts[ins]!, { volume: -0.5, pan: 1.5 });
    const { project, repairs } = repairProject(p);
    expect(project.transport.bpm).toBe(10);
    expect(project.channels[ch]).toMatchObject({ volume: 1.25, pan: -1 });
    expect(project.mixer.inserts[ins]).toMatchObject({ volume: 0, pan: 1 });
    expect(repairs).toEqual([
      'The tempo (5 BPM) was out of range and was set to 10 BPM.',
      'Clamped 1 volume or pan setting into range.',
      'Clamped 1 volume or pan setting into range.',
    ]);

    const q = base().p;
    (q.transport as { bpm: unknown }).bpm = null;
    expect(repairProject(q).project.transport.bpm).toBe(130);
    q.transport.bpm = 1000;
    expect(repairProject(q).project.transport.bpm).toBe(522);
  });

  it('creates a pattern when the project has none', () => {
    const { p, pat } = base();
    delete p.patterns[pat];
    p.patternOrder = [];
    const { project, repairs } = repairProject(p);
    expect(project.patternOrder).toHaveLength(1);
    const created = project.patterns[project.patternOrder[0]!]!;
    expect(created).toMatchObject({ name: 'Pattern 1', stepCount: 16, notes: {} });
    expect(created.id).toMatch(/^pat_/);
    expect(repairs).toEqual(['Added an empty pattern because the project had none.']);
  });

  it('removes damaged records and fixes mismatched ids', () => {
    const { p, ch } = base();
    const channels = p.channels as Record<string, unknown>;
    channels.ch_broken0001 = 'not a channel';
    channels.ch_alien00001 = { kind: 'spaceship', id: 'ch_alien00001' };
    channels.ch_noplugin01 = { ...p.channels[ch], id: 'ch_noplugin01', plugin: null };
    p.channels[ch] = { ...p.channels[ch]!, id: 'ch_other' as ChannelId };
    p.channelOrder.push('ch_broken0001' as ChannelId, 'ch_alien00001' as ChannelId);
    const { project, repairs } = repairProject(p);
    expect(Object.keys(project.channels)).toEqual([ch]);
    expect(project.channels[ch]!.id).toBe(ch);
    expect(project.channelOrder).toEqual([ch]);
    expect(repairs).toEqual([
      'Fixed 1 channel stored under the wrong id.',
      'Removed 1 damaged channel.',
      'Removed 1 channel of an unknown type.',
      'Removed 1 channel whose instrument data was missing.',
    ]);
  });

  it('removes audio clip channels whose sample entry is missing, with their clips', () => {
    const { p, lane } = base();
    p.samples['smp_ok' as never] = builtinSample('smp_ok');
    p.channels['ch_ok' as ChannelId] = audioChannel('ch_ok', 'smp_ok');
    p.channels['ch_lost' as ChannelId] = audioChannel('ch_lost', 'smp_lost');
    p.channelOrder.push('ch_ok' as ChannelId, 'ch_lost' as ChannelId);
    const clip = (id: string, channelId: string) => ({
      kind: 'audio',
      id,
      laneId: lane,
      start: 0,
      length: 960,
      channelId,
      offsetSec: 0,
    });
    p.playlist.clips = { a: clip('a', 'ch_ok'), b: clip('b', 'ch_lost') } as unknown as Project['playlist']['clips'];
    const { project, repairs } = repairProject(p);
    expect(Object.keys(project.channels)).not.toContain('ch_lost');
    expect(project.channelOrder).not.toContain('ch_lost');
    expect(Object.keys(project.playlist.clips)).toEqual(['a']);
    expect(repairs).toEqual([
      'Removed 1 audio clip channel whose sample entry is missing.',
      'Removed 1 playlist clip whose pattern, channel or track no longer exists.',
    ]);
    expect(projectViolations(project)).toEqual([]);
  });

  it('removes plugin sample slots that point at missing samples', () => {
    const { p, ch } = base();
    const channel = p.channels[ch];
    if (channel?.kind !== 'instrument') throw new Error('expected an instrument');
    channel.plugin.samples = { main: 'smp_gone' as never };
    const { project, repairs } = repairProject(p);
    expect(project.channels[ch]).toMatchObject({ plugin: { samples: {} } });
    expect(repairs).toEqual(['Removed 1 reference to missing samples.']);
  });

  it('repairs the broken fixture as documented', () => {
    const { project: p, repairs } = repairOf(fixture('v1-broken'));
    expect(p.transport.bpm).toBe(522);
    expect(p.mixer.order).toEqual(['master', 'ins_drums00001', 'ins_synth00001']);
    expect(p.mixer.inserts['ins_drums00001' as InsertId]).toMatchObject({ volume: 4, pan: -1 });
    expect(p.channelOrder).toEqual(['ch_kick000001', 'ch_synth00001', 'ch_audio00001']);
    expect(p.channels['ch_kick000001' as ChannelId]).toMatchObject({
      volume: 1.25,
      pan: 1,
      plugin: { samples: { main: 'smp_kick000001' } },
    });
    expect(p.channels['ch_synth00001' as ChannelId]).toMatchObject({ output: MASTER });
    expect(p.channels['ch_audio00001' as ChannelId]).toMatchObject({ volume: 0 });
    expect(p.patternOrder).toEqual(['pat_intro00001', 'pat_verse00001']);
    const kickNotes = p.patterns['pat_intro00001' as PatternId]!.notes;
    expect(Object.keys(kickNotes)).toEqual(['ch_kick000001']);
    expect(Object.values(kickNotes['ch_kick000001' as ChannelId]!).map((n) => [n.tick, n.length, n.velocity])).toEqual([
      [0, 240, 1],
      [0, 1, 0.5],
      [960, 240, 0],
    ]);
    expect(Object.keys(p.playlist.clips)).toEqual(['clip_good00001']);
    expect(p.playlist.laneOrder).toEqual(['lane_track00001', 'lane_track00002']);
    expect(repairs).toEqual([
      'The tempo (900 BPM) was out of range and was set to 522 BPM.',
      'Removed 1 unknown entry from the mixer track list.',
      'Removed 1 duplicate entry from the mixer track list.',
      'Added 1 mixer track missing from the mixer track list.',
      'Moved the Master track to the first mixer slot.',
      'Clamped 1 volume or pan setting into range.',
      'Removed 1 reference to missing samples.',
      'Clamped 2 volume or pan settings into range.',
      'Routed channel "Lead" to the Master track because its mixer track no longer exists.',
      'Removed 1 unknown entry from the channel list.',
      'Removed 1 duplicate entry from the channel list.',
      'Added 2 channels missing from the channel list.',
      'Clamped 2 note velocities into 0–1.',
      'Fixed 1 note with an invalid position, length or key.',
      'Removed notes for 1 channel that no longer exist.',
      'Removed 1 unknown entry from the pattern list.',
      'Added 1 pattern missing from the pattern list.',
      'Removed 1 duplicate entry from the playlist track list.',
      'Removed 3 playlist clips whose pattern, channel or track no longer exists.',
    ]);
  });

  it('never throws on corrupted projects, and its output is consistent and stable', () => {
    const valid = fixture('v1-basic');
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, path: (string | number)[]) => {
      paths.push(path);
      if (typeof v === 'object' && v !== null)
        for (const [k, c] of Object.entries(v)) walk(c, [...path, Array.isArray(v) ? Number(k) : k]);
    };
    walk(valid, []);
    const edit = fc.record({ at: fc.nat(), value: fc.oneof(fc.jsonValue(), fc.constant(undefined)) });
    let repaired = 0;
    fc.assert(
      fc.property(fc.array(edit, { minLength: 1, maxLength: 8 }), (edits) => {
        const p = clone(valid) as unknown as Record<string, unknown>;
        for (const { at, value } of edits) {
          const path = paths[at % paths.length]!;
          if (path.length === 0) continue;
          let node: unknown = p;
          for (const k of path.slice(0, -1)) node = (node as Record<string | number, unknown> | undefined)?.[k];
          if (typeof node !== 'object' || node === null) continue;
          const key = path[path.length - 1]!;
          if (value === undefined) delete (node as Record<string | number, unknown>)[key];
          else Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true });
        }
        let migrated: Project;
        try {
          migrated = migrateProject(p).project;
        } catch (e) {
          expect(e).toBeInstanceOf(SchemaError);
          return;
        }
        const { project, repairs } = repairProject(migrated);
        expect(projectViolations(project)).toEqual([]);
        expect(repairProject(project).repairs).toEqual([]);
        if (repairs.length > 0) repaired++;
      }),
      { numRuns: 400, seed: 20261012 },
    );
    // Most corruptions get past structural validation and exercise repair.
    expect(repaired).toBeGreaterThan(200);
  });
});

describe('repairProject: routing, links and automation (schema v2)', () => {
  const base = () => {
    const p = createEmptyProject({ now: new Date(0) });
    const [a, b, c] = p.mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
    return { p, a, b, c };
  };

  it('keeps one route per existing target and none from the master', () => {
    const { p, a, b } = base();
    p.mixer.inserts[a]!.routes = [
      { to: MASTER, level: 1, pre: false },
      { to: b, level: 9, pre: 'yes' as never },
      { to: b, level: 0.5, pre: false },
      { to: a, level: 1, pre: false },
      { to: 'ins_gone' as InsertId, level: 1, pre: false },
    ];
    p.mixer.inserts[MASTER]!.routes = [{ to: a, level: 1, pre: false }];
    (p.mixer.inserts[b] as { routes: unknown }).routes = 'nowhere';
    const { project, repairs } = repairProject(p);
    expect(project.mixer.inserts[a]!.routes).toEqual([
      { to: MASTER, level: 1, pre: false },
      { to: b, level: 4, pre: false },
    ]);
    expect(project.mixer.inserts[MASTER]!.routes).toEqual([]);
    expect(project.mixer.inserts[b]!.routes).toEqual([{ to: MASTER, level: 1, pre: false }]);
    expect(repairs).toEqual([
      'Removed 4 mixer routes to missing or repeated mixer tracks.',
      'Fixed 1 mixer route with invalid settings.',
      'Reset the routing of 1 mixer track to the Master track.',
    ]);
    expect(projectViolations(project)).toEqual([]);
  });

  it('breaks routing loops, routes before sidechains', () => {
    const { p, a, b, c } = base();
    p.mixer.inserts[a]!.routes.push({ to: b, level: 1, pre: false });
    p.mixer.inserts[b]!.routes.push({ to: c, level: 1, pre: false });
    p.mixer.inserts[c]!.routes.push({ to: a, level: 1, pre: false }); // a → b → c → a
    const slot = {
      id: 'fx_comp' as never,
      plugin: makePluginInstance('agstudio.compressor', 1, {}),
      enabled: true,
      mix: 1,
    };
    p.mixer.inserts[a]!.fx = [{ ...slot, sidechain: c }]; // c → a closes a → b → c
    p.mixer.inserts[b]!.fx = [{ ...slot, id: 'fx_ok' as never, sidechain: a }]; // a → b already exists: fine
    const { project, repairs } = repairProject(p);
    expect(project.mixer.inserts[c]!.routes.map((r) => r.to)).toEqual([MASTER]);
    expect(project.mixer.inserts[a]!.fx[0]!.sidechain).toBeNull();
    expect(project.mixer.inserts[b]!.fx[0]!.sidechain).toBe(a);
    expect(repairs).toEqual([
      'Removed 1 mixer route that would loop back.',
      'Cleared 1 sidechain input that would loop back.',
    ]);
    expect(projectViolations(project)).toEqual([]);
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('clears sidechains from missing tracks or the slot’s own track', () => {
    const { p, a } = base();
    const slot = {
      id: 'fx_comp' as never,
      plugin: makePluginInstance('agstudio.compressor', 1, {}),
      enabled: true,
      mix: 1,
    };
    p.mixer.inserts[a]!.fx = [
      { ...slot, sidechain: a },
      { ...slot, id: 'fx_b' as never, sidechain: 'ins_gone' as InsertId },
    ];
    delete (p.mixer.inserts[a]!.fx[1] as { sidechain?: unknown }).sidechain;
    const { project, repairs } = repairProject(p);
    expect(project.mixer.inserts[a]!.fx.map((s) => s.sidechain)).toEqual([null, null]);
    expect(repairs).toEqual(['Cleared 2 invalid sidechain inputs.']);
  });

  it('validates controller links, the song key and automation channels', () => {
    const { p } = base();
    const target = { kind: 'tempo' } as const;
    p.controllers = {
      ['lnk_ok' as never]: { id: 'lnk_ok' as never, cc: 74, channel: null, target, min: -1, max: 2 },
      ['lnk_bad' as never]: { id: 'lnk_bad' as never, cc: 300, channel: null, target, min: 0, max: 1 },
      ['lnk_tgt' as never]: {
        id: 'lnk_tgt' as never,
        cc: 1,
        channel: 3,
        target: { kind: 'nope' } as never,
        min: 0,
        max: 1,
      },
    };
    p.transport.key = { root: 14, scale: 'minor' };
    const auto = {
      kind: 'automation',
      id: 'ch_auto' as ChannelId,
      name: 'Auto',
      color: '#fff',
      muted: false,
      solo: false,
      target: { kind: 'insert', insertId: 'ins_x', param: 'gain' },
      points: [
        { tick: 960, value: 2, shape: 'zigzag' },
        { tick: 0, value: 0.5, tension: 3 },
      ],
      range: { min: 5, max: 900 },
    };
    const tempo = { ...auto, id: 'ch_tempo' as ChannelId, target, points: [], range: { min: 5, max: 900 } };
    p.channels[auto.id] = auto as never;
    p.channels[tempo.id] = tempo as never;
    p.channelOrder.push(auto.id, tempo.id);
    const { project, repairs } = repairProject(p);
    expect(Object.keys(project.controllers)).toEqual(['lnk_ok']);
    expect(project.controllers['lnk_ok' as never]).toMatchObject({ min: 0, max: 1 });
    expect(project.transport.key).toBeUndefined();
    expect(project.channels[auto.id]).toMatchObject({
      target: null,
      points: [
        { tick: 0, value: 0.5, tension: 1 },
        { tick: 960, value: 1 },
      ],
    });
    expect(project.channels[tempo.id]).toMatchObject({ range: { min: 10, max: 522 } });
    expect(repairs).toEqual([
      'The song key was invalid and was cleared.',
      'Fixed 2 channels with invalid settings.',
      'Fixed 1 controller link with an invalid range.',
      'Removed 2 controller links with invalid settings.',
    ]);
    expect(projectViolations(project)).toEqual([]);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an error');
}
