import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject } from '../model/defaults';
import type { ClipId, LaneId, PatternId, Project } from '../model/types';
import { addClips } from '../ops/playlist';
import { ceilToBars, ticksPerBar } from '../time/ppq';
import { songLength } from './playlist';

const BAR = 3840;

/** A project with one pattern clip ending at `end` ticks (the song's length is that end rounded up to bars). */
function withClipEnding(end: number): Project {
  const base = createEmptyProject();
  const lane = base.playlist.laneOrder[0] as LaneId;
  const pid = base.patternOrder[0] as PatternId;
  return produce(base, (d) => {
    addClips(d, [
      { kind: 'pattern', id: `clip-${end}` as ClipId, laneId: lane, start: 0, length: end, patternId: pid, offset: 0 },
    ]);
  });
}

describe('songLength', () => {
  it('is the end of the last clip, rounded up to whole bars, and 0 with no clips', () => {
    const p = withClipEnding(BAR + 100);
    expect(songLength(p)).toBe(2 * BAR);
    expect(songLength(createEmptyProject())).toBe(0);
  });

  it('answers the same again from its memo, and follows a change to the clips', () => {
    const p = withClipEnding(BAR + 100);
    expect(songLength(p)).toBe(songLength(p));
    const longer = produce(p, (d) => {
      addClips(d, [
        {
          kind: 'pattern',
          id: 'later' as ClipId,
          laneId: p.playlist.laneOrder[0] as LaneId,
          start: 4 * BAR,
          length: BAR,
          patternId: p.patternOrder[0] as PatternId,
          offset: 0,
        },
      ]);
    });
    expect(songLength(longer)).toBe(5 * BAR);
    expect(songLength(p)).toBe(2 * BAR);
  });

  it('follows a change to the time signature', () => {
    const p = withClipEnding(BAR + 100);
    const threeFour = produce(p, (d) => {
      d.transport.timeSig = { num: 3, den: 4 };
    });
    expect(songLength(threeFour)).toBe(ceilToBars(BAR + 100, { num: 3, den: 4 }));
    expect(songLength(threeFour)).not.toBe(songLength(p));
    expect(ticksPerBar({ num: 3, den: 4 })).toBeLessThan(BAR);
  });
});
