import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePattern, makePluginInstance } from '../model/defaults';
import type { ClipId, LaneId, NoteId, PatternClip, PatternId, Project } from '../model/types';
import { addChannel } from './channels';
import { addNote } from './notes';
import {
  addClips,
  clonePattern,
  editClips,
  makeClipUnique,
  removeLane,
  removePattern,
  splitClip,
  toggleSoloLane,
} from './playlist';
import { audibleClips, clipAt, mutedLanes, patternTickAt, songLength } from '../query/playlist';

function setup() {
  let p: Project = createEmptyProject();
  const pid = p.patternOrder[0] as PatternId;
  const lanes = p.playlist.laneOrder as LaneId[];
  const ch = makeInstrumentChannel('Kick', makePluginInstance('x', 1, {}));
  const clip = (id: string, start: number, length: number, lane = 0, offset = 0): PatternClip => ({
    kind: 'pattern',
    id: id as ClipId,
    laneId: lanes[lane]!,
    start,
    length,
    patternId: pid,
    offset,
  });
  p = produce(p, (d) => {
    addChannel(d, ch);
    addNote(d, pid, ch.id, { id: 'n1' as NoteId, tick: 0, length: 240, key: 60, velocity: 1 });
    addClips(d, [clip('c1', 0, 3840), clip('c2', 3840 * 2, 3840 * 2, 1)]);
  });
  return { p, pid, lanes, clip };
}

describe('pattern ops', () => {
  it('clones a pattern with fresh note ids right after it', () => {
    const { p, pid } = setup();
    const next = produce(p, (d) => clonePattern(d, pid, 'pat_copy' as PatternId, 'Pattern 2'));
    expect(next.patternOrder).toEqual([pid, 'pat_copy']);
    const a = Object.values(Object.values(next.patterns[pid]!.notes)[0]!);
    const b = Object.values(Object.values(next.patterns['pat_copy' as PatternId]!.notes)[0]!);
    expect(b.map((n) => n.tick)).toEqual(a.map((n) => n.tick));
    expect(b[0]!.id).not.toBe(a[0]!.id);
  });

  it('deleting a pattern removes its clips but keeps the last pattern', () => {
    const { p, pid } = setup();
    expect(produce(p, (d) => removePattern(d, pid))).toBe(p); // only pattern: refused
    const two = produce(p, (d) => {
      const other = makePattern('Pattern 2', '#fff', 'pat_2' as PatternId);
      d.patterns[other.id] = other;
      d.patternOrder.push(other.id);
    });
    const next = produce(two, (d) => removePattern(d, pid));
    expect(Object.keys(next.playlist.clips)).toEqual([]);
    expect(next.patternOrder).toEqual(['pat_2']);
  });
});

describe('clip ops and queries', () => {
  it('computes the song length in whole bars', () => {
    const { p } = setup();
    expect(songLength(p)).toBe(3840 * 4);
    expect(songLength(createEmptyProject())).toBe(0);
  });

  it('splits pattern clips with a continuing offset', () => {
    const { p } = setup();
    const next = produce(p, (d) => splitClip(d, 'c2' as ClipId, 3840 * 3, 0.001, 'c3' as ClipId));
    const left = next.playlist.clips['c2' as ClipId] as PatternClip;
    const right = next.playlist.clips['c3' as ClipId] as PatternClip;
    expect([left.start, left.length, left.offset]).toEqual([7680, 3840, 0]);
    expect([right.start, right.length, right.offset]).toEqual([11520, 3840, 3840]);
  });

  it('clamps edits and ignores unknown lanes', () => {
    const { p } = setup();
    const next = produce(p, (d) =>
      editClips(d, [{ id: 'c1' as ClipId, start: -50, length: 0, laneId: 'nope' as LaneId, offset: -3 }]),
    );
    const c = next.playlist.clips['c1' as ClipId] as PatternClip;
    expect([c.start, c.length, c.offset, c.laneId]).toEqual([0, 1, 0, p.playlist.laneOrder[0]]);
  });

  it('respects lane mute and exclusive solo', () => {
    const { p, lanes } = setup();
    const soloed = produce(p, (d) => toggleSoloLane(d, lanes[1]!));
    expect(mutedLanes(soloed.playlist).has(lanes[0]!)).toBe(true);
    expect(audibleClips(soloed).map((c) => c.id)).toEqual(['c2']);
    const unsolo = produce(soloed, (d) => toggleSoloLane(d, lanes[1]!));
    expect(audibleClips(unsolo)).toHaveLength(2);
  });

  it('maps a song position into the pattern (looping clip content)', () => {
    const { p, pid } = setup();
    expect(patternTickAt(p, 100, pid)).toBe(100);
    expect(patternTickAt(p, 3840 * 3 + 50, pid)).toBe(50); // second loop of the 2-bar clip
    expect(patternTickAt(p, 3840 * 1.5, pid)).toBeNull(); // gap between clips
  });

  it('hit-tests clips per lane', () => {
    const { p, lanes } = setup();
    const sorted = audibleClips(p);
    expect(clipAt(sorted, 100, lanes[0]!)?.id).toBe('c1');
    expect(clipAt(sorted, 100, lanes[1]!)).toBeUndefined();
  });
});

describe('lane and clip menu ops', () => {
  it('deletes a lane with its clips and keeps the last lane', () => {
    const { p, lanes } = setup();
    const q = produce(p, (d) => removeLane(d, lanes[1]!));
    expect(q.playlist.laneOrder).not.toContain(lanes[1]);
    expect(q.playlist.clips['c2' as ClipId]).toBeUndefined();
    expect(q.playlist.clips['c1' as ClipId]).toBeDefined();
    let only = p;
    for (const id of p.playlist.laneOrder) only = produce(only, (d) => removeLane(d, id));
    expect(only.playlist.laneOrder).toHaveLength(1);
  });

  it('makes a clip unique with its own copy of the pattern', () => {
    const { p, pid } = setup();
    const copy = 'pat_copy' as PatternId;
    const q = produce(p, (d) => makeClipUnique(d, 'c2' as ClipId, copy, 'Pattern 1 #2'));
    const c1 = q.playlist.clips['c1' as ClipId] as PatternClip;
    const c2 = q.playlist.clips['c2' as ClipId] as PatternClip;
    expect(c1.patternId).toBe(pid);
    expect(c2.patternId).toBe(copy);
    expect(q.patterns[copy]?.name).toBe('Pattern 1 #2');
    const notes = (id: PatternId) => Object.values(q.patterns[id]!.notes).flatMap((m) => Object.values(m ?? {}));
    expect(notes(copy).map((n) => n.key)).toEqual(notes(pid).map((n) => n.key));
    expect(notes(copy)[0]?.id).not.toBe(notes(pid)[0]?.id);
  });
});
