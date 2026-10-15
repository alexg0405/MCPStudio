import { describe, expect, it } from 'vitest';
import { automationAt, automationModelOf } from '@core/automation/model';
import { targetKey } from '@core/model/targets';
import { MASTER, type AutomationChannel, type ChannelId, type Clip, type NoteId, type PatternId, type Project } from '@core/model/types';
import { BAR, clipLines, clipsOf, project, stackedSong, type TestServices } from '../../../../test/helpers/focus';
import { applyAnswer } from '../apply';
import { focusFromClips, focusFromMarker, focusFromRange } from '../focus-capture';
import { resolveFocus, type AiFocus } from '../focus';
import type { AiAction } from '../schema';
import type { AppliedBeat } from '../../assistant/apply';

const marker = (s: TestServices, name: string) => Object.values(project(s).playlist.markers).find((m) => m.name === name)!.id;
const section = (s: TestServices, name: string) => focusFromMarker(s, marker(s, name))!;

function ask(s: TestServices, focus: AiFocus, actions: AiAction[], previousBeat: AppliedBeat | null = null) {
  return applyAnswer(s, { message: 'ok', actions }, { previousBeat, focus: resolveFocus(project(s), focus) });
}

const patternByName = (p: Project, name: string) => Object.values(p.patterns).find((x) => x.name === name);
/** Clips lying wholly outside from–to, as comparable lines. */
const outsideLines = (p: Project, from: number, to: number) =>
  clipLines(p, (c: Clip) => c.start + c.length <= from || c.start >= to);
/** Notes of every pattern, by pattern id (ids, keys, ticks, velocities). */
const notesOf = (p: Project, pid: PatternId) => JSON.stringify(p.patterns[pid]?.notes ?? null);

describe('copy-on-write in a part of the song', () => {
  it('copies a pattern that plays inside and outside: straddlers split, inside re-pointed, outside untouched, one undo', () => {
    const { s, ids } = stackedSong();
    const before = project(s);
    const slam = ids.patterns['ISOxo 808 slam']!;
    // Bars 18–29: the clips at bars 17 and 29 reach over the edges.
    const res = ask(s, focusFromRange(s, 17 * BAR, 29 * BAR)!, [
      { op: 'write_notes', pattern: 'ISOxo 808 slam', channel: 'Snare', notes: [{ step: 8 }, { step: 24 }, { step: 30, vel: 0.6 }] },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual([
      'Made a copy of “ISOxo 808 slam” for bars 18–29, so the rest of the song stays the same',
      'Wrote 3 notes for “Snare” in “ISOxo 808 slam (bars 18–29)”',
    ]);
    const p = project(s);
    const copy = patternByName(p, 'ISOxo 808 slam (bars 18–29)')!.id;
    expect(clipsOf(p, copy).map((c) => [c.start / BAR + 1, c.length / BAR])).toEqual([
      [18, 1],
      [19, 2],
      [21, 2],
      [23, 2],
      [25, 2],
      [27, 2],
      [29, 1],
    ]);
    expect(clipsOf(p, slam).map((c) => [c.start / BAR + 1, c.length / BAR])).toEqual([
      [17, 1],
      [30, 1],
      [31, 2],
    ]);
    // The original's notes and every clip outside bars 18–29 are as they were (the split halves play the same bars).
    expect(notesOf(p, slam)).toBe(notesOf(before, slam));
    expect(outsideLines(p, 16 * BAR, 30 * BAR)).toEqual(outsideLines(before, 16 * BAR, 30 * BAR));
    expect(Object.keys(p.patterns[copy]!.notes[ids.channels.Snare!]!)).toHaveLength(3);
    // The answer carries the copy for follow-ups.
    expect(res.focus).toMatchObject({ kind: 'range', from: 17 * BAR, to: 29 * BAR, copies: { [slam]: copy } });
    // One undo step takes back the split, the copy and the notes.
    s.history.undo();
    expect(project(s)).toEqual(before);
  });

  it('copies once per answer, makes the copy current, and a follow-up edits the copy', () => {
    const { s, ids } = stackedSong();
    const drop = ids.patterns.Drop!;
    const before = project(s);
    s.view.getState().setCurrentPattern(drop);
    const focus = section(s, 'Drop');
    const first = ask(s, focus, [
      { op: 'write_notes', pattern: 'Drop', channel: 'Snare', notes: [{ step: 8 }, { step: 24 }, { step: 28 }, { step: 30 }] },
      { op: 'note_tool', tool: 'agstudio.notes.transpose', pattern: 'current', channel: 'Pluck', params: [{ name: 'semitones', value: 2 }] },
    ]);
    expect(first.warnings).toEqual([]);
    expect(first.changes.filter((x) => x.startsWith('Made a copy'))).toHaveLength(1);
    const p = project(s);
    const copy = patternByName(p, 'Drop (bars 37–52)')!.id;
    expect(Object.keys(p.patterns)).toHaveLength(Object.keys(before.patterns).length + 1);
    expect(s.view.getState().currentPatternId).toBe(copy);
    // The final drop (bars 89–100) plays the original, unchanged.
    expect(notesOf(p, drop)).toBe(notesOf(before, drop));
    expect(clipsOf(p, drop).every((c) => c.start >= 88 * BAR)).toBe(true);
    // The next answer in the same focus names the original: it lands on the part's copy.
    const second = ask(s, first.focus!, [
      { op: 'write_notes', pattern: 'Drop', channel: 'Clap', notes: [{ step: 8 }, { step: 24 }, { step: 31 }] },
    ]);
    expect(second.warnings).toEqual([]);
    expect(second.changes).toEqual(['Wrote 3 notes for “Clap” in “Drop (bars 37–52)”']);
    expect(Object.keys(project(s).patterns)).toHaveLength(Object.keys(before.patterns).length + 1);
    expect(notesOf(project(s), drop)).toBe(notesOf(before, drop));
  });

  it('in a clips focus, copies only for the selected clips', () => {
    const { s, ids } = stackedSong();
    const drop = ids.patterns.Drop!;
    const picked = clipsOf(project(s), drop).slice(6, 8);
    const res = ask(s, focusFromClips(s, picked.map((c) => c.id))!, [
      { op: 'write_notes', pattern: 'Drop', channel: 'Hat', notes: [{ step: 0 }, { step: 2 }, { step: 4 }] },
    ]);
    expect(res.changes[0]).toBe('Made a copy of “Drop” for bars 49–52, so the rest of the song stays the same');
    const p = project(s);
    const copy = patternByName(p, 'Drop (bars 49–52)')!.id;
    expect(clipsOf(p, copy).map((c) => c.id)).toEqual(picked.map((c) => c.id));
    expect(clipsOf(p, drop)).toHaveLength(24);
    expect(res.focus).toMatchObject({ kind: 'clips', clipIds: picked.map((c) => c.id), copies: { [drop]: copy } });
    expect(res.selectClips).toEqual(picked.map((c) => c.id));
    // Other clips in those bars aren't part of it.
    const other = ask(s, res.focus!, [{ op: 'clip', action: 'edit', track: 2, bar: 49, mute: true }]);
    expect(other.warnings).toEqual([
      "clip: the clip on track 2, bars 49–50 isn't one of the selected clips (2 clips · bars 49–52); change those, or clips you add",
    ]);
  });

  it('copies the beat a follow-up rewrites when it also plays outside the part', () => {
    const { s, ids } = stackedSong();
    const drop = ids.patterns.Drop!;
    const before = project(s);
    const previous: AppliedBeat = { patternId: drop, channels: { kick: ids.channels.Kick!, snare: ids.channels.Snare! }, created: [] };
    const res = ask(
      s,
      section(s, 'Drop'),
      [
        {
          op: 'beat',
          title: 'Drop, harder',
          bars: 2,
          tracks: [
            { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 10 }, { step: 16 }, { step: 26 }] },
            { name: 'Snare', sound: 'snare', notes: [{ step: 8 }, { step: 24 }, { step: 30 }, { step: 31 }] },
          ],
        },
      ],
      previous,
    );
    expect(res.warnings).toEqual([]);
    expect(res.beat?.patternId).not.toBe(drop);
    const copy = res.beat!.patternId;
    expect(project(s).patterns[copy]!.name).toBe('Drop, harder');
    expect(clipsOf(project(s), copy)).toHaveLength(8);
    expect(notesOf(project(s), drop)).toBe(notesOf(before, drop));
  });
});

describe('what may change in a part', () => {
  it('refuses a pattern that plays only outside the part, and deleting one that plays outside', () => {
    const { s } = stackedSong();
    const verse = section(s, 'Verse');
    const res = ask(s, verse, [
      { op: 'write_notes', pattern: 'Drop', channel: 'Snare', notes: [{ step: 0 }] },
      { op: 'remove_pattern', pattern: 'Perc layer' },
      { op: 'remove_pattern', pattern: 'ISOxo 808 slam' },
    ]);
    expect(res.warnings).toEqual([
      "write notes: “Drop” doesn't play in Verse · bars 17–32 (it plays at bars 37–52, bars 89–100); add a pattern for the part, or make one of the part's clips unique (clip make_unique) and edit that",
      'remove pattern: “Perc layer” also plays outside Verse · bars 17–32 (at bars 37–52, bars 69–84, bars 89–100), so it stays; clear its clips in the part instead (clear_playlist)',
    ]);
    // A pattern that plays only in the part is the part's own.
    expect(res.changes).toEqual(['Deleted pattern “ISOxo 808 slam”']);
  });

  it('keeps playlist edits within the part, a bar either side for transitions', () => {
    const { s } = stackedSong();
    const res = ask(s, section(s, 'Verse'), [
      { op: 'place_pattern', pattern: 'Build', bar: 9 },
      { op: 'place_pattern', pattern: 'Riser', bar: 32, track: 12 },
      { op: 'place_pattern', pattern: 'Impact', bar: 33, track: 12 },
      { op: 'clip', action: 'edit', track: 1, bar: 37, mute: true },
      { op: 'clip', action: 'edit', track: 6, bar: 17, mute: true },
      { op: 'automate', target: { kind: 'track_volume', insert: 'master' }, from_bar: 40, bars: 4, points: [{ bar: 0, value: 0 }, { bar: 4, value: -6 }] },
    ]);
    expect(res.warnings).toEqual([
      "place pattern: bars 9–10 reach outside the part you're working on (Verse · bars 17–32); only bars 17–32 can change, or bars 16–33 for a transition",
      "place pattern: bars 33–34 reach outside the part you're working on (Verse · bars 17–32); only bars 17–32 can change, or bars 16–33 for a transition",
      'clip: the clip on track 1, bars 37–38 reaches outside the part (Verse · bars 17–32), so it stays as it is',
      "automate: bars 40–43 reach outside the part you're working on (Verse · bars 17–32); only bars 17–32 can change, or bars 16–33 for a transition",
    ]);
    expect(res.changes).toEqual(['Placed “Riser” on track 12 at bar 32', '“Impact” (track 6, bar 17): muted']);
  });

  it('clears the part by default, cutting clips at its edges', () => {
    const { s } = stackedSong();
    const before = project(s);
    const res = ask(s, focusFromRange(s, 17 * BAR, 29 * BAR)!, [{ op: 'clear_playlist', track: 1, trim: false }]);
    expect(res.changes).toEqual(['Removed 7 playlist clips (2 cut at the edges)']);
    const p = project(s);
    const track1 = Object.values(p.playlist.clips).filter((c) => c.laneId === p.playlist.laneOrder[0]);
    expect(track1.some((c) => c.start < 29 * BAR && c.start + c.length > 17 * BAR)).toBe(false);
    expect(outsideLines(p, 16 * BAR, 30 * BAR)).toEqual(outsideLines(before, 16 * BAR, 30 * BAR));
    // In a clips focus, only the selected clips go.
    const { s: t, ids } = stackedSong();
    const two = clipsOf(project(t), ids.patterns.Drop!).slice(0, 2);
    const cleared = ask(t, focusFromClips(t, two.map((c) => c.id))!, [{ op: 'clear_playlist' }]);
    expect(cleared.changes).toEqual(['Removed 2 playlist clips']);
    expect(two.every((c) => !project(t).playlist.clips[c.id])).toBe(true);
    expect(Object.keys(project(t).playlist.clips)).toHaveLength(Object.keys(before.playlist.clips).length - 2);
  });

  it('ends automation where the control sat before, unless another clip of it plays on', () => {
    const { s } = stackedSong();
    const master = { kind: 'insert', insertId: MASTER, param: 'volume' } as const;
    // Fading out the Breather must not leave the final drop silent.
    const fade = ask(s, section(s, 'Breather'), [
      { op: 'automate', target: { kind: 'track_volume', insert: 'master' }, points: [{ bar: 0, value: 0 }, { bar: 4, value: -40 }] },
    ]);
    expect(fade.warnings).toEqual([]);
    expect(fade.changes).toEqual([
      '“Volume · Master” goes back to 0.0 dB at bar 89 (where it was before), so the rest of the song stays the same',
      'Automation “Volume · Master”, bars 85–89: 0.0 dB → -40.0 dB',
    ]);
    const p = project(s);
    const ta = automationModelOf(p).targets.get(targetKey(master))!;
    expect(automationAt(ta, 88 * BAR)!.value).toBeCloseTo(automationAt(ta, 84 * BAR)!.value, 5);
    expect(automationAt(ta, 88 * BAR - 1)!.value).toBeLessThan(0.2);
    // The pad's cutoff already holds its last sweep value at bar 91: the new curve returns there.
    const { s: t, ids: tids } = stackedSong();
    const pad = targetKey({ kind: 'plugin', owner: { kind: 'channel', channelId: tids.channels['Dark Pad']! }, paramId: 'cutoff' });
    const before = automationAt(automationModelOf(project(t)).targets.get(pad)!, 90 * BAR)!.value;
    const hold = ask(t, section(t, 'Final Drop'), [
      {
        op: 'automate',
        target: { kind: 'plugin', channel: 'Dark Pad', param: 'cutoff' },
        from_bar: 89,
        bars: 2,
        points: [{ bar: 0, value: 300 }, { bar: 2, value: 600 }],
      },
    ]);
    expect(hold.changes[0]).toMatch(/^“Cutoff · Dark Pad” goes back to .+ at bar 91 \(where it was before\)/);
    expect(automationAt(automationModelOf(project(t)).targets.get(pad)!, 90 * BAR)!.value).toBeCloseTo(before, 5);
    // The downlifter's pitch clip plays on past bar 85: no return is added.
    const { s: u } = stackedSong();
    const on = ask(u, section(u, 'Breather'), [
      { op: 'automate', target: { kind: 'channel_pitch', channel: 'Downlifter' }, from_bar: 85, bars: 1, points: [{ bar: 0, value: 0 }, { bar: 1, value: -300 }] },
    ]);
    expect(on.changes).toHaveLength(1);
    const made = Object.values(project(u).channels).filter((c) => c.kind === 'automation').at(-1) as AutomationChannel;
    expect(made.points).toHaveLength(2);
  });

  it('with selected notes, changes only those and refuses the step tools and the playlist', () => {
    const { s, ids } = stackedSong();
    const drop = ids.patterns.Drop!;
    const pluck = ids.channels.Pluck!;
    const before = project(s);
    const sorted = Object.values(before.patterns[drop]!.notes[pluck]!).sort((a, b) => a.tick - b.tick);
    const picked = sorted.slice(0, 3).map((n) => n.id);
    const focus: AiFocus = { kind: 'notes', patternId: drop, channelId: pluck, noteIds: picked, projectId: before.projectId };
    const res = ask(s, focus, [
      { op: 'write_notes', pattern: 'Drop', channel: 'Pluck', notes: [{ step: 0, key: 72, vel: 0.9 }, { step: 2, key: 75 }] },
      { op: 'note_tool', tool: 'agstudio.notes.transpose', pattern: 'Drop', channel: 'Pluck', params: [{ name: 'semitones', value: 12 }] },
      { op: 'steps', pattern: 'Drop', channel: 'Pluck', action: 'fill', every: 4 },
      { op: 'clear_notes', pattern: 'Drop' },
      { op: 'write_notes', pattern: 'Break', channel: 'Pluck', notes: [{ step: 0, key: 60 }] },
      { op: 'place_pattern', pattern: 'Drop', bar: 113 },
    ]);
    expect(res.warnings).toEqual([
      'steps: steps would change the whole pattern; the request is about 3 notes of “Pluck” in “Drop” (write_notes with replace or note_tool change just them)',
      'clear notes: clear notes would change the whole pattern; the request is about 3 notes of “Pluck” in “Drop” (write_notes with replace or note_tool change just them)',
      'write notes: the request is about 3 notes of “Pluck” in “Drop”; “Break” stays as it is (add a pattern for new material)',
      'place pattern: the request is about 3 notes of “Pluck” in “Drop”: the playlist stays as it is (ask about bars, clips or a section to change the arrangement)',
    ]);
    const now = project(s).patterns[drop]!;
    const notes = Object.values(now.notes[pluck]!).sort((a, b) => a.tick - b.tick);
    // The 8 notes that weren't selected are exactly as they were; the 2 new ones went up an octave.
    for (const n of sorted.slice(3)) expect(now.notes[pluck]![n.id]).toEqual(n);
    const fresh = notes.filter((n) => !sorted.some((o) => o.id === n.id));
    expect(fresh.map((n) => [n.tick / 240, n.key])).toEqual([
      [0, 84],
      [2, 87],
    ]);
    for (const cid of Object.keys(now.notes) as ChannelId[])
      if (cid !== pluck) expect(now.notes[cid]).toEqual(before.patterns[drop]!.notes[cid]);
    expect(Object.keys(project(s).playlist.clips)).toHaveLength(Object.keys(before.playlist.clips).length);
    // The focus follows the notes written.
    expect(res.focus?.kind).toBe('notes');
    const kept = res.focus?.kind === 'notes' ? [...res.focus.noteIds].sort() : [];
    expect(kept).toEqual(fresh.map((n) => n.id as NoteId).sort());
  });
});

describe('“add a fill at the end of the Verse” on the stacked song', () => {
  it('leaves everything outside bars 17–32 as it was', () => {
    const { s, ids } = stackedSong();
    const before = project(s);
    const res = ask(s, section(s, 'Verse'), [
      { op: 'clip', action: 'make_unique', track: 1, bar: 31, ref: '@fill', name: 'Verse fill' },
      {
        op: 'write_notes',
        pattern: '@fill',
        channel: 'Snare',
        notes: [{ step: 8, vel: 1 }, ...[24, 26, 28, 29, 30, 30.5, 31, 31.5].map((step, i) => ({ step, vel: 0.55 + i * 0.05 }))],
      },
      { op: 'write_notes', pattern: 'Perc layer', channel: 'Perc', notes: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30].map((step) => ({ step, key: 39, vel: 0.5 })) },
      { op: 'place_pattern', pattern: 'Riser', bar: 32, track: 12 },
      {
        op: 'automate',
        target: { kind: 'plugin', channel: 'Dark Pad', param: 'cutoff' },
        from_bar: 31,
        bars: 2,
        points: [{ bar: 0, value: 400 }, { bar: 2, value: 8000 }],
      },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual([
      '“ISOxo 808 slam” (track 1, bar 31) now plays its own copy, “Verse fill”',
      'Wrote 9 notes for “Snare” in “Verse fill”',
      'Made a copy of “Perc layer” for bars 17–32, so the rest of the song stays the same',
      'Wrote 11 notes for “Perc” in “Perc layer (bars 17–32)”',
      'Placed “Riser” on track 12 at bar 32',
      expect.stringMatching(/^Automation “Cutoff · Dark Pad”, bars 31–33: /),
    ]);
    const p = project(s);
    // Every clip outside the Verse plays what it played, and every pattern heard there is unchanged.
    expect(outsideLines(p, 16 * BAR, 32 * BAR)).toEqual(outsideLines(before, 16 * BAR, 32 * BAR));
    for (const c of Object.values(before.playlist.clips))
      if (c.kind === 'pattern' && (c.start + c.length <= 16 * BAR || c.start >= 32 * BAR))
        expect(notesOf(p, c.patternId)).toBe(notesOf(before, c.patternId));
    // The new clips sit in the Verse or the bar after it (the riser into the build).
    const added = Object.values(p.playlist.clips).filter((c) => !before.playlist.clips[c.id]);
    expect(added.every((c) => c.start >= 15 * BAR && c.start + c.length <= 33 * BAR)).toBe(true);
    expect(added).toHaveLength(2);
    // The Verse's Perc clips play the copy; the drop's still play the original.
    expect(clipsOf(p, ids.patterns['Perc layer']!).every((c) => c.start >= 36 * BAR)).toBe(true);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });
});
