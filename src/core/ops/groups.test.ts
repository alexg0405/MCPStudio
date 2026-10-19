import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject } from '../model/defaults';
import { MAX_INSERT_VOLUME } from '../model/fader';
import { seededBytes, setIdSource } from '../model/ids';
import { targetKey } from '../model/targets';
import { MASTER, type GroupId, type InsertId, type Project } from '../model/types';
import { resolveTarget } from '../automation/targets';
import { effectivelyMutedInserts } from '../query/mixer';
import { groupOfInsert, vcaGainOf } from '../query/mix-groups';
import {
  addVca,
  createGroup,
  dropFromGroups,
  editGroup,
  joinGroup,
  leaveGroup,
  removeGroup,
  removeVca,
  setVcaLevel,
} from './groups';
import { linkedValue, planLinkedEdit, setMutedLinked, toggleSoloLinked } from './linked-edits';
import { removeInsert, setInsertProp, setSoloSafe } from './mixer';
import { setTargetValue } from './targets';

beforeEach(() => setIdSource(seededBytes(11)));

const dbToGain = (db: number) => 10 ** (db / 20);

function setup() {
  const p = createEmptyProject({ now: new Date(0) });
  const [a, b, c, e] = p.mixer.order.slice(1, 5) as [InsertId, InsertId, InsertId, InsertId];
  return { p, a, b, c, e };
}

/** A project where a, b and c are in one group, with volumes 0.5, 1 and 0.25. */
function grouped(mode: 'relative' | 'absolute' = 'relative') {
  const { p, a, b, c, e } = setup();
  let id!: GroupId;
  const q = produce(p, (d) => {
    setInsertProp(d, a, 'volume', 0.5);
    setInsertProp(d, c, 'volume', 0.25);
    setInsertProp(d, a, 'pan', -0.5);
    id = createGroup(d, [a, b, c], { name: 'Drums' })!;
    editGroup(d, id, { mode });
  });
  return { p: q, a, b, c, e, id };
}

describe('groups', () => {
  it('makes a group of tracks (never the master) with every link on and no VCA', () => {
    const { p, a, b } = setup();
    const q = produce(p, (d) => void createGroup(d, [a, MASTER, b, a]));
    const group = q.mixer.groups![0]!;
    expect(group.members).toEqual([a, b]);
    expect(group.name).toBe('Group 1');
    expect(group.links).toEqual({ volume: true, pan: true, mute: true, solo: true });
    expect(group.mode).toBe('relative');
    expect(group.vca).toBeUndefined();
    expect(groupOfInsert(q.mixer, a)).toBe(group);
  });

  it('refuses a group with nobody in it and leaves the project as it was', () => {
    const { p } = setup();
    expect(produce(p, (d) => void createGroup(d, [MASTER]))).toBe(p);
  });

  it('moves a track that is already grouped into the new group, and drops a group that empties', () => {
    const { p, a, b, c } = setup();
    const q = produce(p, (d) => {
      createGroup(d, [a, b]);
      createGroup(d, [a]);
    });
    expect(q.mixer.groups!.map((g) => g.members)).toEqual([[b], [a]]);
    const r = produce(q, (d) => void createGroup(d, [b, c]));
    expect(r.mixer.groups!.map((g) => g.members)).toEqual([[a], [b, c]]);
    const s = produce(r, (d) => void createGroup(d, [a, b, c]));
    expect(s.mixer.groups).toHaveLength(1);
  });

  it('joins, leaves and removes; the groups field goes with the last group', () => {
    const { p, a, b, c } = setup();
    let id!: GroupId;
    const q = produce(p, (d) => {
      id = createGroup(d, [a])!;
      expect(joinGroup(d, id, [b, c, b])).toBe(2);
    });
    expect(q.mixer.groups![0]!.members).toEqual([a, b, c]);
    const r = produce(q, (d) => void leaveGroup(d, b));
    expect(r.mixer.groups![0]!.members).toEqual([a, c]);
    const s = produce(r, (d) => void removeGroup(d, id));
    expect(s.mixer.groups).toBeUndefined();
  });

  it('removes a track from its group when the track is deleted, and the group when it was the last', () => {
    const { p, a, b } = setup();
    const q = produce(p, (d) => void createGroup(d, [a, b]));
    const r = produce(q, (d) => void removeInsert(d, a));
    expect(r.mixer.groups![0]!.members).toEqual([b]);
    const s = produce(r, (d) => void removeInsert(d, b));
    expect(s.mixer.groups).toBeUndefined();
    expect(produce(s, (d) => void dropFromGroups(d, a))).toBe(s);
  });

  it('edits the name, colour, links and mode', () => {
    const { p, a, b } = setup();
    let id!: GroupId;
    const q = produce(p, (d) => {
      id = createGroup(d, [a, b])!;
      editGroup(d, id, { name: '  Bass  ', color: '#112233', mode: 'absolute', links: { pan: false, solo: false } });
    });
    const group = q.mixer.groups![0]!;
    expect(group).toMatchObject({ name: 'Bass', color: '#112233', mode: 'absolute' });
    expect(group.links).toEqual({ volume: true, pan: false, mute: true, solo: false });
  });
});

describe('linked faders and pans', () => {
  it('relative: the others keep their ratio (the same distance in dB)', () => {
    const { p, a, b, c } = grouped();
    const q = produce(p, (d) => planLinkedEdit(p, b, 'volume')(d, 0.5));
    expect(q.mixer.inserts[b]!.volume).toBe(0.5);
    expect(q.mixer.inserts[a]!.volume).toBeCloseTo(0.25, 12);
    expect(q.mixer.inserts[c]!.volume).toBeCloseTo(0.125, 12);
  });

  it('absolute: every member takes the moved value', () => {
    const { p, a, b, c } = grouped('absolute');
    const q = produce(p, (d) => planLinkedEdit(p, a, 'volume')(d, 0.7));
    for (const id of [a, b, c]) expect(q.mixer.inserts[id]!.volume).toBe(0.7);
  });

  it('relative pan keeps the offsets and stops at the edge without losing them on the way back', () => {
    const { p, a, b } = grouped();
    const plan = planLinkedEdit(p, b, 'pan');
    const right = produce(p, (d) => plan(d, 0.8));
    expect(right.mixer.inserts[a]!.pan).toBeCloseTo(0.3, 12);
    const far = produce(p, (d) => plan(d, 1));
    expect(far.mixer.inserts[a]!.pan).toBeCloseTo(0.5, 12);
    const back = produce(far, (d) => plan(d, 0.4));
    expect(back.mixer.inserts[a]!.pan).toBeCloseTo(-0.1, 12);
  });

  it('a drag is computed from where it started: the same value gives the same result, and dragging back restores everyone', () => {
    const { p, a, b, c } = grouped();
    const plan = planLinkedEdit(p, b, 'volume');
    let doc = p;
    for (const v of [1.8, 0.2, 1.9, 1]) doc = produce(doc, (d) => plan(d, v));
    for (const id of [a, b, c]) expect(doc.mixer.inserts[id]!.volume).toBeCloseTo(p.mixer.inserts[id]!.volume, 12);
  });

  it('clamps a mate at the top of the fader', () => {
    const { p, b, a } = grouped();
    const q = produce(p, (d) => planLinkedEdit(p, b, 'volume')(d, MAX_INSERT_VOLUME));
    expect(q.mixer.inserts[a]!.volume).toBeLessThanOrEqual(MAX_INSERT_VOLUME);
  });

  it('a mate that starts at silence has no ratio and stays', () => {
    expect(linkedValue('relative', 'volume', 0, 0.5, 0.8)).toBe(0.5);
    expect(linkedValue('relative', 'volume', 0.5, 0.5, 0)).toBe(0);
  });

  it('moves only one track when the track has no group or the group does not link the control', () => {
    const { p, a, b, e } = grouped();
    const single = produce(p, (d) => planLinkedEdit(p, e, 'volume')(d, 0.3));
    expect(single.mixer.inserts[e]!.volume).toBe(0.3);
    expect(single.mixer.inserts[a]!.volume).toBe(0.5);
    const id = p.mixer.groups![0]!.id;
    const unlinked = produce(p, (d) => editGroup(d, id, { links: { volume: false } }));
    const moved = produce(unlinked, (d) => planLinkedEdit(unlinked, b, 'volume')(d, 0.3));
    expect(moved.mixer.inserts[a]!.volume).toBe(0.5);
  });

  it('mute and solo go to the whole group', () => {
    const { p, a, b, c, e } = grouped();
    const muted = produce(p, (d) => setMutedLinked(d, a, true));
    expect([a, b, c].every((id) => muted.mixer.inserts[id]!.muted)).toBe(true);
    expect(muted.mixer.inserts[e]!.muted).toBe(false);
    const soloed = produce(p, (d) => toggleSoloLinked(d, b));
    expect([a, b, c].map((id) => soloed.mixer.inserts[id]!.solo)).toEqual([true, true, true]);
    expect(effectivelyMutedInserts(soloed.mixer.inserts).has(e)).toBe(true);
    const cleared = produce(soloed, (d) => toggleSoloLinked(d, c));
    expect(Object.values(cleared.mixer.inserts).some((insert) => insert.solo)).toBe(false);
  });

  it('solo of a track outside any group acts like the single-track solo', () => {
    const { p, e, a } = grouped();
    const q = produce(p, (d) => toggleSoloLinked(d, e));
    expect(q.mixer.inserts[e]!.solo).toBe(true);
    expect(q.mixer.inserts[a]!.solo).toBe(false);
  });
});

describe('VCA', () => {
  function withVca(gain = 1) {
    const g = grouped();
    const id = g.id;
    const p = produce(g.p, (d) => addVca(d, id, gain));
    return { ...g, p };
  }

  it('adds, sets (in dB terms), clamps and removes a VCA without touching the faders', () => {
    const { p, a, b, id } = withVca();
    expect(p.mixer.groups![0]!.vca).toBe(1);
    const q = produce(p, (d) => setVcaLevel(d, id, dbToGain(-6)));
    expect(vcaGainOf(q.mixer, a)).toBeCloseTo(0.501, 3);
    expect(q.mixer.inserts[a]!.volume).toBe(p.mixer.inserts[a]!.volume);
    expect(q.mixer.inserts[b]!.volume).toBe(p.mixer.inserts[b]!.volume);
    const loud = produce(q, (d) => setVcaLevel(d, id, 99));
    expect(loud.mixer.groups![0]!.vca).toBe(MAX_INSERT_VOLUME);
    const gone = produce(loud, (d) => removeVca(d, id));
    expect(vcaGainOf(gone.mixer, a)).toBe(1);
  });

  it('scales a member by the dB the VCA says: 0 dB changes nothing, -6.02 dB halves', () => {
    const { p, a, id } = withVca();
    const half = produce(p, (d) => setVcaLevel(d, id, dbToGain(-6.0206)));
    expect(vcaGainOf(half.mixer, a) * half.mixer.inserts[a]!.volume).toBeCloseTo(0.25, 4);
    expect(vcaGainOf(p.mixer, MASTER)).toBe(1);
  });

  it('is an automation target with the fader taper, and a controller link can set it', () => {
    const { p, id } = withVca(dbToGain(-3));
    const resolved = resolveTarget(p, { kind: 'vca', groupId: id }, () => undefined)!;
    expect(resolved.key).toBe(`vca:${id}`);
    expect(resolved.base).toBeCloseTo(dbToGain(-3), 12);
    expect(resolved.fromNormalized(resolved.toNormalized(0.7))).toBeCloseTo(0.7, 6);
    const set = produce(p, (d) => setTargetValue(d, { kind: 'vca', groupId: id }, 0.4));
    expect(set.mixer.groups![0]!.vca).toBe(0.4);
    expect(targetKey({ kind: 'vca', groupId: id })).toBe(`vca:${id}`);
  });

  it('has no automation target when the group has no VCA', () => {
    const { p, id } = grouped();
    expect(resolveTarget(p, { kind: 'vca', groupId: id }, () => undefined)).toBeNull();
  });
});

describe('solo-safe', () => {
  it('keeps a solo-safe return playing, and what it routes to, when another track is soloed', () => {
    const { p, a, b, c } = setup();
    const q = produce(p, (d) => {
      setSoloSafe(d, b, true);
      d.mixer.inserts[b]!.routes = [{ to: c, level: 1, pre: false }];
      d.mixer.inserts[a]!.solo = true;
    });
    const muted = effectivelyMutedInserts(q.mixer.inserts);
    expect(muted.has(b)).toBe(false);
    expect(muted.has(c)).toBe(false);
    const without = produce(q, (d) => setSoloSafe(d, b, false));
    expect(without.mixer.inserts[b]!.soloSafe).toBeUndefined();
    expect(effectivelyMutedInserts(without.mixer.inserts).has(b)).toBe(true);
  });

  it('does not bring back the sources of a solo-safe track', () => {
    const { p, a, b, e } = setup();
    const q = produce(p, (d) => {
      setSoloSafe(d, b, true);
      d.mixer.inserts[e]!.routes = [{ to: b, level: 1, pre: false }];
      d.mixer.inserts[a]!.solo = true;
    });
    const muted = effectivelyMutedInserts(q.mixer.inserts);
    expect(muted.has(e)).toBe(true);
    expect(muted.has(b)).toBe(false);
  });

  it('a plain mute still wins', () => {
    const { p, a, b } = setup();
    const q = produce(p, (d) => {
      setSoloSafe(d, b, true);
      setInsertProp(d, b, 'muted', true);
      d.mixer.inserts[a]!.solo = true;
    });
    expect(effectivelyMutedInserts(q.mixer.inserts).has(b)).toBe(true);
  });
});

describe('project without groups', () => {
  it('has no groups field before and after a group comes and goes', () => {
    const { p, a } = setup();
    const q = produce(p, (d) => {
      const id = createGroup(d, [a])!;
      removeGroup(d, id);
    });
    expect('groups' in q.mixer).toBe(false);
    expect(q).toEqual(p as Project);
  });
});
