/** Repair of mixer groups, solo-safe flags and saved mixer snapshots, and migration of projects that have none. */
import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject } from '../../model/defaults';
import { seededBytes, setIdSource } from '../../model/ids';
import { MASTER, type InsertId, type Project } from '../../model/types';
import { addVca, createGroup } from '../../ops/groups';
import { setSoloSafe } from '../../ops/mixer';
import { addSnapshot } from '../../ops/snapshots';
import { captureSnapshot } from '../../snapshots/capture';
import { migrateProject, repairProject } from '../migrate';
import type { JsonObject } from '../json-values';

beforeEach(() => setIdSource(seededBytes(9)));

function project() {
  const empty = createEmptyProject({ now: new Date(0) });
  const [a, b, c] = empty.mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
  const made = produce(empty, (d) => {
    const id = createGroup(d, [a, b], { name: 'Drums' })!;
    addVca(d, id, 0.7);
    setSoloSafe(d, c, true);
  });
  const withSnapshot = produce(made, (d) => void addSnapshot(d, captureSnapshot(made, 'Verse', 5, { routing: true })));
  return { project: withSnapshot, a, b, c };
}

/** The project as JSON, damaged by `damage`, then repaired. */
function repairedAfter(source: Project, damage: (json: JsonObject) => void) {
  const json = JSON.parse(JSON.stringify(source)) as JsonObject;
  damage(json);
  return repairProject(migrateProject(json).project);
}

describe('a healthy project with groups and snapshots', () => {
  it('survives migrate and repair unchanged and silently, and repair is idempotent', () => {
    const { project: p } = project();
    const { project: migrated } = migrateProject(JSON.parse(JSON.stringify(p)));
    const { project: repaired, repairs } = repairProject(migrated);
    expect(repairs).toEqual([]);
    expect(repaired).toEqual(p);
    expect(repairProject(repaired).repairs).toEqual([]);
  });

  it('a project saved before groups and snapshots existed has neither field', () => {
    const { project: repaired, repairs } = repairProject(migrateProject(createEmptyProject({ now: new Date(0) })).project);
    expect(repairs).toEqual([]);
    expect('groups' in repaired.mixer).toBe(false);
    expect('mixSnapshots' in repaired).toBe(false);
  });
});

describe('repairing groups', () => {
  it('drops members that are gone, the master and repeats, and an emptied group', () => {
    const { project: p, a, b, c } = project();
    const { project: fixed, repairs } = repairedAfter(p, (json) => {
      const mixer = json.mixer as JsonObject;
      mixer.groups = [
        { ...(mixer.groups as JsonObject[])[0], members: [a, 'ins_gone', MASTER, a] },
        { id: 'grp_other', name: 'Other', color: '#fff', members: [a, b], links: {}, mode: 'relative' },
        { id: 'grp_empty', name: 'Empty', color: '#fff', members: ['ins_gone'], links: {}, mode: 'relative' },
      ];
    });
    expect(fixed.mixer.groups!.map((g) => g.members)).toEqual([[a], [b]]);
    expect(fixed.mixer.groups![1]!.links).toEqual({ volume: true, pan: true, mute: true, solo: true });
    expect(repairs.join(' ')).toContain('Removed 1 mixer group');
    expect(c).toBeTruthy();
  });

  it('puts damaged settings back to defaults and clamps the VCA', () => {
    const { project: p } = project();
    const { project: fixed } = repairedAfter(p, (json) => {
      const group = (json.mixer as JsonObject).groups as JsonObject[];
      Object.assign(group[0]!, { name: '', color: 4, mode: 'sideways', vca: 99, links: { volume: 'yes', pan: false } });
    });
    const group = fixed.mixer.groups![0]!;
    expect(group.name).toBe('Group 1');
    expect(typeof group.color).toBe('string');
    expect(group.mode).toBe('relative');
    expect(group.vca).toBe(4);
    expect(group.links).toEqual({ volume: true, pan: false, mute: true, solo: true });
  });

  it('forgets groups that are not a list, and gives a duplicate id a new one', () => {
    const { project: p, a, b } = project();
    const notAList = repairedAfter(p, (json) => {
      (json.mixer as JsonObject).groups = 'nope';
    });
    expect(notAList.project.mixer.groups).toBeUndefined();
    const { project: fixed } = repairedAfter(p, (json) => {
      const id = ((json.mixer as JsonObject).groups as JsonObject[])[0]!.id;
      (json.mixer as JsonObject).groups = [
        { id, name: 'A', color: '#fff', members: [a], links: {}, mode: 'relative' },
        { id, name: 'B', color: '#fff', members: [b], links: {}, mode: 'relative' },
      ];
    });
    const ids = fixed.mixer.groups!.map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps a boolean solo-safe flag and drops a damaged one', () => {
    const { project: p, c } = project();
    expect(repairProject(migrateProject(JSON.parse(JSON.stringify(p))).project).project.mixer.inserts[c]!.soloSafe).toBe(true);
    const { project: fixed } = repairedAfter(p, (json) => {
      const inserts = (json.mixer as JsonObject).inserts as JsonObject;
      (inserts[c] as JsonObject).soloSafe = 'yes';
    });
    expect(fixed.mixer.inserts[c]!.soloSafe).toBeUndefined();
  });
});

describe('repairing snapshots', () => {
  it('clamps values, drops unreadable parts and keeps the rest', () => {
    const { project: p, a } = project();
    const { project: fixed } = repairedAfter(p, (json) => {
      const snapshot = (json.mixSnapshots as JsonObject[])[0]!;
      const track = (snapshot.inserts as JsonObject)[a] as JsonObject;
      Object.assign(track, { volume: 99, pan: 'left', muted: 1, sends: { [MASTER]: -4, junk: 'x' } });
      snapshot.name = '';
      snapshot.vca = { grp_x: 99, bad: 'x' };
      snapshot.routing = 'not routing';
    });
    const snapshot = fixed.mixSnapshots![0]!;
    expect(snapshot.name).toBe('Snapshot');
    expect(snapshot.inserts[a]).toMatchObject({ volume: 4, pan: 0, muted: false, sends: { [MASTER]: 0 } });
    expect(snapshot.vca).toEqual({ grp_x: 4 });
    expect(snapshot.routing).toBeUndefined();
  });

  it('drops a snapshot whose tracks cannot be read, gives repeated ids new ones, and removes the field when none is left', () => {
    const { project: p } = project();
    const { project: fixed, repairs } = repairedAfter(p, (json) => {
      const good = (json.mixSnapshots as JsonObject[])[0]!;
      json.mixSnapshots = [good, { ...good }, { id: 'x', name: 'Broken', savedAt: 1, inserts: 7 }, 'junk'];
    });
    expect(fixed.mixSnapshots).toHaveLength(2);
    expect(new Set(fixed.mixSnapshots!.map((s) => s.id)).size).toBe(2);
    expect(repairs.join(' ')).toContain('Removed 2 mixer snapshots');
    for (const damaged of [[], 'junk']) {
      const emptied = repairedAfter(p, (json) => {
        json.mixSnapshots = damaged;
      });
      expect(emptied.project.mixSnapshots).toBeUndefined();
    }
  });

  it('drops a damaged effect slot and a damaged parameter value, not the snapshot', () => {
    const { project: p, a } = project();
    const withEffect = produce(p, (d) => {
      d.mixSnapshots![0]!.inserts[a]!.fx = {
        fx_1: { plugin: 'p', enabled: true, mix: 1, params: { gain: 2, bad: { nested: 1 } } },
        fx_2: { enabled: true, mix: 1, params: {} },
      } as never;
    });
    const { project: fixed } = repairProject(migrateProject(JSON.parse(JSON.stringify(withEffect))).project);
    const fx = fixed.mixSnapshots![0]!.inserts[a]!.fx;
    expect(Object.keys(fx)).toEqual(['fx_1']);
    expect(fx['fx_1' as never]!.params).toEqual({ gain: 2 });
  });
});
