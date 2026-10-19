import { describe, expect, it } from 'vitest';
import { MASTER, type InsertId } from '@core/model/types';
import { setInsertProp } from '@core/ops/mixer';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';
import { STUDIO_PROMPT } from '../prompt';

type Services = ReturnType<typeof createTestServices>;
const run = (s: Services, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

function setup() {
  const s = createTestServices();
  const [a, b, c] = s.doc.getState().project.mixer.order.slice(1, 4) as [InsertId, InsertId, InsertId];
  s.history.transact('names', (d) => {
    setInsertProp(d, a, 'name', 'Kick');
    setInsertProp(d, b, 'name', 'Snare');
    setInsertProp(d, c, 'name', 'Reverb');
  });
  return { s, a, b, c };
}
const mixer = (s: Services) => s.doc.getState().project.mixer;
const snapshots = (s: Services) => s.doc.getState().project.mixSnapshots ?? [];

describe('mixer_snapshot', () => {
  it('saves, recalls (one undo step), diffs, updates, renames and deletes by name', () => {
    const { s, a } = setup();
    const saved = run(s, [{ op: 'mixer_snapshot', action: 'save', name: 'Verse' }]);
    expect(saved.changes).toEqual(['Saved the mixer as snapshot “Verse”']);
    expect(snapshots(s)).toHaveLength(1);

    run(s, [{ op: 'edit_insert', insert: 'Kick', volume_db: -6 }]);
    const diff = run(s, [{ op: 'mixer_snapshot', action: 'diff', snapshot: 'verse' }]);
    expect(diff.edited).toBe(false);
    expect(diff.changes[0]).toBe('Recalling “Verse” would change (1): Kick: fader -6.0 dB → 0.0 dB');

    const steps = s.history.steps().done.length;
    const recalled = run(s, [{ op: 'mixer_snapshot', action: 'recall', snapshot: 'Verse' }]);
    expect(recalled.changes).toEqual(['Recalled snapshot “Verse”']);
    expect(mixer(s).inserts[a]!.volume).toBe(1);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    s.history.undo();
    expect(mixer(s).inserts[a]!.volume).toBeCloseTo(0.5012, 3);

    run(s, [{ op: 'mixer_snapshot', action: 'update', snapshot: 'Verse' }]);
    expect(snapshots(s)[0]!.inserts[a]!.volume).toBeCloseTo(0.5012, 3);
    run(s, [{ op: 'mixer_snapshot', action: 'rename', snapshot: 'Verse', name: 'Chorus' }]);
    expect(snapshots(s)[0]!.name).toBe('Chorus');
    run(s, [{ op: 'mixer_snapshot', action: 'delete', snapshot: snapshots(s)[0]!.id }]);
    expect(snapshots(s)).toHaveLength(0);
  });

  it('saves and recalls in one answer, and keeps routing only when asked', () => {
    const { s, a, b } = setup();
    const res = run(s, [
      { op: 'mixer_snapshot', action: 'save', name: 'Routed', routing: true },
      { op: 'route', from: 'Kick', to: 'Snare', level_db: -3 },
      { op: 'mixer_snapshot', action: 'recall', snapshot: 'Routed' },
    ]);
    expect(res.warnings).toEqual([]);
    expect(snapshots(s)[0]!.routing).toBeDefined();
    expect(mixer(s).inserts[a]!.routes.some((route) => route.to === b)).toBe(false);
  });

  it('compare sets A and B for the A/B switch and plays one', () => {
    const { s, a } = setup();
    run(s, [{ op: 'mixer_snapshot', action: 'save', name: 'Quiet' }]);
    run(s, [{ op: 'edit_insert', insert: 'Kick', volume_db: -12 }, { op: 'mixer_snapshot', action: 'save', name: 'Quieter' }]);
    const res = run(s, [{ op: 'mixer_snapshot', action: 'compare', snapshot: 'Quiet', other: 'Quieter', show: 'b' }]);
    expect(res.changes[0]).toMatch(/^A\/B compare: A is “Quiet”, B is “Quieter”; playing B/);
    const compare = s.session.getState().snapshotCompare;
    expect(compare.side).toBe('b');
    expect(snapshots(s).find((x) => x.id === compare.a)!.name).toBe('Quiet');
    expect(mixer(s).inserts[a]!.volume).toBeCloseTo(0.2512, 3);
    expect(res.ui?.join(' ')).toMatch(/A\/B compare is set/);
  });

  it('says what is wrong instead of failing silently', () => {
    const { s } = setup();
    expect(run(s, [{ op: 'mixer_snapshot', action: 'recall', snapshot: 'nothing' }]).warnings[0]).toMatch(/there is no mixer snapshot "nothing"/);
    expect(run(s, [{ op: 'mixer_snapshot', action: 'explode' }]).warnings[0]).toMatch(/must be one of/);
    expect(run(s, [{ op: 'mixer_snapshot', action: 'compare', snapshot: 'x' }]).warnings).toHaveLength(1);
  });
});

describe('mixer_group', () => {
  it('creates a group with a VCA, sets the VCA in dB, edits and removes it', () => {
    const { s, a, b, c } = setup();
    const made = run(s, [{ op: 'mixer_group', action: 'create', ref: '@drums', name: 'Drums', tracks: ['Kick', 'Snare'], vca_db: -3 }]);
    expect(made.warnings).toEqual([]);
    expect(made.changes[0]).toBe('Made the group “Drums” of 2 tracks with a VCA at -3 dB');
    const group = mixer(s).groups![0]!;
    expect(group.members).toEqual([a, b]);
    expect(group.vca).toBeCloseTo(0.7079, 3);
    expect(mixer(s).inserts[a]!.volume).toBe(1);

    run(s, [{ op: 'mixer_group', action: 'vca_level', group: 'Drums', vca_db: -12 }]);
    expect(mixer(s).groups![0]!.vca).toBeCloseTo(0.2512, 3);
    run(s, [{ op: 'mixer_group', action: 'edit', group: 'drums', name: 'Kit', mode: 'absolute', linked: { pan: false }, add_tracks: ['Reverb'], color: '#336699' }]);
    expect(mixer(s).groups![0]).toMatchObject({ name: 'Kit', mode: 'absolute', color: '#336699', members: [a, b, c] });
    expect(mixer(s).groups![0]!.links).toEqual({ volume: true, pan: false, mute: true, solo: true });
    run(s, [{ op: 'mixer_group', action: 'edit', group: 'Kit', vca: false, remove_tracks: ['Reverb'] }]);
    expect(mixer(s).groups![0]!.vca).toBeUndefined();
    expect(mixer(s).groups![0]!.members).toEqual([a, b]);
    run(s, [{ op: 'mixer_group', action: 'remove', group: 'Kit' }]);
    expect(mixer(s).groups).toBeUndefined();
  });

  it('a group made in an answer is one undo step, and its VCA can be automated by name', () => {
    const { s } = setup();
    const steps = s.history.steps().done.length;
    const res = run(s, [
      { op: 'mixer_group', action: 'create', ref: '@drums', tracks: ['Kick', 'Snare'], vca: true },
      { op: 'automate', target: { kind: 'vca', group: '@drums' }, from_bar: 1, bars: 2, points: [{ bar: 0, value: 0 }, { bar: 2, value: -12 }] },
    ]);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    expect(res.warnings).toEqual([]);
    s.history.undo();
    expect(mixer(s).groups).toBeUndefined();
  });

  it('refuses the master and unknown groups with a reason', () => {
    const { s } = setup();
    expect(run(s, [{ op: 'mixer_group', action: 'create', tracks: ['master'] }]).warnings[0]).toMatch(/no group was made/);
    expect(run(s, [{ op: 'mixer_group', action: 'remove', group: 'Nope' }]).warnings[0]).toMatch(/there is no mixer group "Nope"/);
    expect(run(s, [{ op: 'mixer_group', action: 'create', tracks: [] }]).warnings[0]).toMatch(/needs mixer tracks/);
  });

  it('edit_insert marks a track solo-safe', () => {
    const { s, c } = setup();
    run(s, [{ op: 'edit_insert', insert: 'Reverb', solo_safe: true }]);
    expect(mixer(s).inserts[c]!.soloSafe).toBe(true);
    run(s, [{ op: 'edit_insert', insert: 'Reverb', solo_safe: false }]);
    expect(mixer(s).inserts[c]!.soloSafe).toBeUndefined();
  });
});

describe('the read tools and the prompt', () => {
  it('get_mix_snapshots and get_mix_groups list what exists, and get_mixer names the group', () => {
    const { s } = setup();
    expect(runReadTool(s, 'get_mix_snapshots')).toMatchObject({ snapshots: [], note: expect.stringContaining('No snapshots') });
    expect(runReadTool(s, 'get_mix_groups')).toMatchObject({ groups: [] });
    run(s, [
      { op: 'mixer_group', action: 'create', name: 'Drums', tracks: ['Kick', 'Snare'], vca_db: -6 },
      { op: 'mixer_snapshot', action: 'save', name: 'Verse' },
      { op: 'edit_insert', insert: 'Kick', volume_db: -9, solo_safe: true },
    ]);
    const groups = runReadTool(s, 'get_mix_groups') as { groups: { name: string; vca_db: number; tracks: { name: string }[] }[]; solo_safe: unknown[] };
    expect(groups.groups[0]).toMatchObject({ name: 'Drums', vca_db: -6, mode: 'relative' });
    expect(groups.groups[0]!.tracks.map((t) => t.name)).toEqual(['Kick', 'Snare']);
    expect(groups.solo_safe).toHaveLength(1);
    const list = runReadTool(s, 'get_mix_snapshots', { snapshot: 'Verse', diff: true }) as { snapshots: { name: string; differences: string[] }[] };
    expect(list.snapshots[0]!.name).toBe('Verse');
    expect(list.snapshots[0]!.differences).toEqual(['Kick: fader -9.0 dB → 0.0 dB']);
    const mixerRead = runReadTool(s, 'get_mixer', { insert: 'Kick' }) as { inserts: { group: string; solo_safe: boolean }[] };
    expect(mixerRead.inserts[0]).toMatchObject({ group: 'Drums', solo_safe: true });
    expect(runReadTool(s, 'get_mix_snapshots', { snapshot: 'zzz' })).toMatchObject({ error: expect.any(String) });
  });

  it('the Studio prompt teaches both actions', () => {
    expect(STUDIO_PROMPT).toContain('mixer_snapshot');
    expect(STUDIO_PROMPT).toContain('mixer_group');
    expect(MASTER).toBe('master');
  });
});
