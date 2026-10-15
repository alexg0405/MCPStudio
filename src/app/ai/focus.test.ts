import { describe, expect, it } from 'vitest';
import type { ClipId, NoteId } from '@core/model/types';
import { moveMarker, removeMarker } from '@core/ops/markers';
import { removeClips } from '@core/ops/playlist';
import { removeNotes } from '@core/ops/notes';
import { BAR, clipsOf, project, stackedSong } from '../../../test/helpers/focus';
import { focusFromClips, focusFromMarker, focusFromNotes, focusFromPlaylist } from './focus-capture';
import { focusContext, focusLabel, isAiFocus, resolveFocus, type AiFocus } from './focus';

const markerId = (s: ReturnType<typeof stackedSong>['s'], name: string) =>
  Object.values(project(s).playlist.markers).find((m) => m.name === name)!.id;

describe('resolving a focus', () => {
  it('follows a section’s marker, and keeps its bars when the marker is deleted', () => {
    const { s } = stackedSong();
    const verse = markerId(s, 'Verse');
    const f = focusFromMarker(s, verse)!;
    expect(f).toMatchObject({ kind: 'section', markerId: verse, from: 16 * BAR, to: 32 * BAR });
    expect(resolveFocus(project(s), f)).toMatchObject({ label: 'Verse · bars 17–32', short: 'bars 17–32', from: 16 * BAR });
    // Moved: the section now starts at bar 19.
    s.history.transact('move', (d) => moveMarker(d, verse, 18 * BAR));
    const moved = resolveFocus(project(s), f)!;
    expect(moved).toMatchObject({ label: 'Verse · bars 19–32', from: 18 * BAR, to: 32 * BAR });
    expect(moved.focus).toMatchObject({ kind: 'section', from: 18 * BAR });
    // Deleted: the bars it had, as a plain range.
    s.history.transact('delete', (d) => removeMarker(d, verse));
    const gone = resolveFocus(project(s), moved.focus)!;
    expect(gone).toMatchObject({ label: 'bars 19–32', section: null });
    expect(gone.focus.kind).toBe('range');
  });

  it('drops clips that were deleted, and the whole focus when none is left', () => {
    const { s, ids } = stackedSong();
    const drops = clipsOf(project(s), ids.patterns.Drop!).slice(0, 3);
    const f = focusFromClips(s, drops.map((c) => c.id))!;
    expect(focusLabel(project(s), f)).toBe('3 clips · bars 37–42');
    s.history.transact('rm', (d) => removeClips(d, [drops[0]!.id]));
    const r = resolveFocus(project(s), f)!;
    expect(r.label).toBe('2 clips · bars 39–42');
    expect([...r.clips!]).toEqual([drops[1]!.id, drops[2]!.id]);
    s.history.transact('rm', (d) => removeClips(d, [drops[1]!.id]));
    expect(resolveFocus(project(s), f)!.label).toBe('“Drop” clip · bars 41–42');
    s.history.transact('rm', (d) => removeClips(d, [drops[2]!.id]));
    expect(resolveFocus(project(s), f)).toBeNull();
    expect(focusFromClips(s, ['clip_nope' as ClipId])).toBeNull();
  });

  it('belongs to one project', () => {
    const { s } = stackedSong();
    const f = focusFromMarker(s, markerId(s, 'Drop'))!;
    expect(resolveFocus(project(s), { ...f, projectId: 'prj_other' })).toBeNull();
    expect(resolveFocus(project(s), null)).toBeNull();
  });

  it('keeps the notes that still exist', () => {
    const { s, ids } = stackedSong();
    const pid = ids.patterns.Drop!;
    const cid = ids.channels.Pluck!;
    const noteIds = Object.keys(project(s).patterns[pid]!.notes[cid]!).slice(0, 6) as NoteId[];
    const f = focusFromNotes(s, { patternId: pid, channelId: cid, noteIds })!;
    expect(focusLabel(project(s), f)).toBe('6 notes of “Pluck”');
    s.history.transact('rm', (d) => removeNotes(d, pid, cid, noteIds.slice(0, 5)));
    expect(resolveFocus(project(s), f)).toMatchObject({ label: '1 note of “Pluck”', from: 0, to: 2 * BAR });
    s.history.transact('rm', (d) => removeNotes(d, pid, cid, noteIds.slice(5)));
    expect(resolveFocus(project(s), f)).toBeNull();
  });

  it('checks the shape of a stored focus', () => {
    expect(isAiFocus({ kind: 'range', from: 0, to: BAR, projectId: 'p' })).toBe(true);
    expect(isAiFocus({ kind: 'section', markerId: 'mk_a', from: 0, to: BAR, projectId: 'p', copies: { pat_a: 'pat_b' } })).toBe(true);
    expect(isAiFocus({ kind: 'notes', patternId: 'pat', channelId: 'ch', noteIds: ['n_1'], projectId: 'p' })).toBe(true);
    expect(isAiFocus({ kind: 'range', from: BAR, to: 0, projectId: 'p' })).toBe(false);
    expect(isAiFocus({ kind: 'clips', clipIds: [], projectId: 'p' })).toBe(false);
    expect(isAiFocus({ kind: 'section', from: 0, to: BAR, projectId: 'p' })).toBe(false);
    expect(isAiFocus({ kind: 'range', from: 0, to: BAR })).toBe(false);
    expect(isAiFocus('range')).toBe(false);
  });
});

describe('capturing a focus from the playlist', () => {
  it('takes the selected clips, else the loop region (a section when it matches one)', () => {
    const { s, ids } = stackedSong();
    expect(focusFromPlaylist(s)).toBeNull();
    s.view.getState().setLoop({ start: 16 * BAR, end: 32 * BAR });
    expect(focusFromPlaylist(s)).toMatchObject({ kind: 'section', markerId: markerId(s, 'Verse') });
    s.view.getState().setLoop({ start: 8 * BAR, end: 12 * BAR });
    expect(focusFromPlaylist(s)).toMatchObject({ kind: 'range', from: 8 * BAR, to: 12 * BAR });
    const tom = clipsOf(project(s), ids.patterns['Tom fill']!)[0]!;
    s.editor.getState().selectClips([tom.id]);
    expect(focusFromPlaylist(s)).toEqual({ kind: 'clips', clipIds: [tom.id], projectId: project(s).projectId });
  });

  it('takes the piano roll’s selected notes, or all of the channel’s notes', () => {
    const { s, ids } = stackedSong();
    const pid = ids.patterns.Build!;
    s.view.getState().setCurrentPattern(pid);
    s.session.getState().selectChannel(ids.channels.Snare!);
    const all = focusFromNotes(s)!;
    expect(all.kind === 'notes' && all.noteIds).toHaveLength(18);
    const two = Object.keys(project(s).patterns[pid]!.notes[ids.channels.Snare!]!).slice(0, 2) as NoteId[];
    s.editor.getState().selectNotes(two);
    expect(focusFromNotes(s)).toMatchObject({ kind: 'notes', patternId: pid, noteIds: two });
    s.session.getState().selectChannel(ids.channels.Choir!);
    expect(focusFromNotes(s)).toBeNull();
  });
});

describe('the <focus> block', () => {
  it('shows a section in its song: neighbours, clips around it, notes, uses elsewhere, activity, automation', () => {
    const { s } = stackedSong();
    const r = resolveFocus(project(s), focusFromMarker(s, markerId(s, 'Verse')))!;
    const text = focusContext(project(s), r);
    expect(text).toContain('Working on: Verse · bars 17–32');
    expect(text).toContain('the section “Verse”');
    expect(text).toContain('Around it: before it “Pre-verse” bars 9–16; after it “Build” bars 33–36.');
    expect(text).toContain('a transition may start in bar 16 or end in bar 33');
    // Clips per track, the 2 bars either side marked.
    expect(text).toMatch(/- Track 1: before: “Break” ×4 bars 9–16 \| in the part: “ISOxo 808 slam” ×8 bars 17–32 \| after: “Build” ×2 bars 33–36/);
    expect(text).toMatch(/- Track 5: before: “Riser” bars 15–16/);
    expect(text).toMatch(/- Track 9: before: “Tom fill” bar 16 \| in the part: “Tom fill” bar 32 clip_/);
    // Each pattern with its notes, and whether it also plays elsewhere.
    expect(text).toMatch(/- “ISOxo 808 slam” pat_\S+, 2 bars: plays only in this part/);
    expect(text).toMatch(/- “Perc layer” pat_\S+, 2 bars: also plays at bars 37–52, bars 69–84, bars 89–100/);
    expect(text).toMatch(/- “Tom fill” pat_\S+, 1 bar: also plays at bar 16, bar 48, bar 64, bar 80, bar 96/);
    expect(text).toContain('  Snare: 8@1 24@1');
    // Bars 13–36, those outside marked.
    expect(text).toMatch(/- bar 13 \(before\): \d+ notes: /);
    expect(text).toMatch(/- bar 17: \d+ notes: .*Perc \d+/);
    expect(text).toMatch(/- bar 36 \(after\): /);
    expect(text).not.toMatch(/- bar 12\b/);
    expect(text).not.toMatch(/- bar 37\b/);
    // Automation clips over it.
    expect(text).toMatch(/- “Pitch · Riser” \(automation ch_\S+\) on track 3, bars 15–16: \S+ ct → \S+ ct/);
  });

  it('shows selected notes apart from the channel’s other notes', () => {
    const { s, ids } = stackedSong();
    const pid = ids.patterns.Drop!;
    const cid = ids.channels['808']!;
    const notes = Object.values(project(s).patterns[pid]!.notes[cid]!).sort((a, b) => a.tick - b.tick);
    const f: AiFocus = { kind: 'notes', patternId: pid, channelId: cid, noteIds: [notes[0]!.id, notes[1]!.id], projectId: project(s).projectId };
    const text = focusContext(project(s), resolveFocus(project(s), f)!);
    expect(text).toContain('Working on: 2 notes of “808”');
    expect(text).toContain('Selected notes (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8): 0:F1/10@1 10:F1/4.5@.95');
    expect(text).toMatch(/The other notes of “808” in this pattern: 14:C2\/2@\.9 16:F1\/6@1/);
    expect(text).toContain('“Drop” plays at bars 37–52, bars 89–100 in the song');
    expect(text).toMatch(/Other channels in “Drop”: Kick \(7\), Clap \(2\)/);
  });

  it('describes a selection of clips', () => {
    const { s, ids } = stackedSong();
    const drops = clipsOf(project(s), ids.patterns.Drop!).slice(6, 8);
    const r = resolveFocus(project(s), focusFromClips(s, drops.map((c) => c.id)))!;
    const text = focusContext(project(s), r);
    expect(text).toContain('Working on: 2 clips · bars 49–52');
    expect(text).toContain('The musician is asking about 2 selected clips (bars 49–52)');
    expect(text).toContain(`- “Drop” on track 1, bars 49–50 ${drops[0]!.id}`);
    // The other Drop clips (bars 37–48 and the final drop) are uses elsewhere.
    expect(text).toMatch(/- “Drop” pat_\S+, 2 bars: also plays at bars 37–48, bars 89–100/);
    expect(resolveFocus(project(s), { ...r.focus, projectId: 'x' } as AiFocus)).toBeNull();
  });
});
