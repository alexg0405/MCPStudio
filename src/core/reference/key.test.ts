import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { notesHash } from '../arrange/notes';
import type { NoteId } from '../model/types';
import { channelRoles } from '../arrange/roles';
import { keyMove, modeOfScale, projectKey, transposeSong } from './key';
import { HINT, kitProject, notes, trapGroove } from '../../../test/helpers/arrange';

const song = () =>
  kitProject((k) => ({
    Groove: { notes: { ...trapGroove(k), [k.lead]: notes([[0, 65], [4, 68], [8, 72], [12, 68], [16, 65], [20, 63], [24, 60], [28, 61]]) } },
  }));

describe('keys', () => {
  it('reads the scale as major or minor', () => {
    expect(['minor', 'dorian', 'phrygian', 'harmonic-minor'].map(modeOfScale)).toEqual(['minor', 'minor', 'minor', 'minor']);
    expect(['major', 'lydian', 'mixolydian'].map(modeOfScale)).toEqual(['major', 'major', 'major']);
  });

  it('takes the shortest way to the reference’s key', () => {
    expect(keyMove({ root: 5, mode: 'minor' }, { root: 9, mode: 'minor' })).toMatchObject({ semitones: 4, relative: false, to: { root: 9, mode: 'minor' } });
    expect(keyMove({ root: 9, mode: 'minor' }, { root: 5, mode: 'minor' }).semitones).toBe(-4);
    expect(keyMove({ root: 0, mode: 'minor' }, { root: 6, mode: 'minor' }).semitones).toBe(6 - 12);
    expect(keyMove({ root: 3, mode: 'major' }, { root: 3, mode: 'major' }).semitones).toBe(0);
  });

  it('goes to the relative key when one is major and the other minor (the notes are the same)', () => {
    // C major and an A minor reference: nothing moves.
    expect(keyMove({ root: 0, mode: 'major' }, { root: 9, mode: 'minor' })).toEqual({ semitones: 0, to: { root: 0, mode: 'major' }, relative: true });
    // F minor and a C major reference (its relative minor is A): up 4.
    expect(keyMove({ root: 5, mode: 'minor' }, { root: 0, mode: 'major' })).toMatchObject({ semitones: 4, to: { root: 9, mode: 'minor' }, relative: true });
  });

  it('knows the song’s key from the setting, else from its notes', () => {
    const { project } = song();
    const roles = channelRoles(project, HINT);
    expect(projectKey(project, roles)).toEqual({ root: 5, mode: 'minor', from: 'setting' });
    const noKey = produce(project, (d) => void delete d.transport.key);
    const found = projectKey(noKey, roles);
    expect(found?.from).toBe('notes');
    // F minor and its relative, A♭ major, share their notes: either is a right answer.
    expect([found?.root + (found?.mode ?? '')]).toContain(found?.mode === 'minor' ? '5minor' : '8major');
  });

  it('says nothing about a song with almost no notes', () => {
    const { project } = kitProject(() => ({}));
    expect(projectKey(produce(project, (d) => void delete d.transport.key), channelRoles(project, HINT))).toBeNull();
  });

  it('moves the pitched notes and leaves the drums alone', () => {
    const { project, kit } = song();
    const roles = channelRoles(project, HINT);
    const before = Object.values(project.patterns)[0]!;
    const moved = { n: 0 };
    const next = produce(project, (d) => {
      moved.n = transposeSong(d, roles, 4);
    });
    const after = Object.values(next.patterns)[0]!;
    const keys = (p: typeof before, ch: string) => Object.values(p.notes[ch as never] ?? {}).map((n) => n.key).sort((a, b) => a - b);
    expect(keys(after, kit.lead)).toEqual(keys(before, kit.lead).map((k) => k + 4));
    expect(keys(after, kit.s808)).toEqual(keys(before, kit.s808).map((k) => k + 4));
    expect(keys(after, kit.pad)).toEqual(keys(before, kit.pad).map((k) => k + 4));
    expect(keys(after, kit.kick)).toEqual(keys(before, kit.kick));
    expect(keys(after, kit.hat)).toEqual(keys(before, kit.hat));
    expect(moved.n).toBeGreaterThan(8);
    // Moving back is the same project.
    const back = produce(next, (d) => void transposeSong(d, roles, -4));
    expect(back.patterns).toEqual(project.patterns);
  });

  it('keeps notes inside 0–127 and an unedited variant unmodified', () => {
    const { project, kit, patterns } = song();
    const roles = channelRoles(project, HINT);
    const src = project.patterns[patterns.Groove!]!;
    const withVariant = produce(project, (d) => {
      const first = Object.keys(src.notes[kit.lead]!)[0] as NoteId;
      d.patterns[patterns.Groove!]!.notes[kit.lead]![first]!.key = 126;
      const v = JSON.parse(JSON.stringify(d.patterns[patterns.Groove!])) as typeof src;
      v.id = 'pat_variant' as never;
      v.derived = { from: patterns.Groove!, steps: [], seed: 1, hash: notesHash(v.notes) };
      d.patterns[v.id] = v;
      d.patternOrder.push(v.id);
    });
    const next = produce(withVariant, (d) => void transposeSong(d, roles, 5));
    for (const p of Object.values(next.patterns)) for (const byCh of Object.values(p.notes)) for (const n of Object.values(byCh)) expect(n.key).toBeLessThanOrEqual(127);
    const v = next.patterns['pat_variant' as never]!;
    expect(v.derived!.hash).toBe(notesHash(v.notes));
  });
});
