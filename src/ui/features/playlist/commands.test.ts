import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import type { ClipId, LaneId, PatternClip, PatternId } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { addKitAudioClip, kitDuration } from '@app/actions/samples';
import { playlistCommands as pl } from './commands';

function setup() {
  const s = createTestServices();
  const p = s.doc.getState().project;
  const pid = p.patternOrder[0] as PatternId;
  const lanes = p.playlist.laneOrder as LaneId[];
  const clip = (id: string, start: number, lane = 0): PatternClip => ({
    kind: 'pattern',
    id: id as ClipId,
    laneId: lanes[lane]!,
    start,
    length: 3840,
    patternId: pid,
    offset: 0,
  });
  s.history.transact('seed', (d) => addClips(d, [clip('a', 0), clip('b', 3840, 1)]));
  const starts = () =>
    Object.values(s.doc.getState().project.playlist.clips)
      .map((c) => c.start)
      .sort((x, y) => x - y);
  return { s, lanes, starts };
}

describe('playlist commands', () => {
  it('duplicates the selection by whole bars after itself', () => {
    const { s, starts } = setup();
    s.editor.getState().selectClips(['a', 'b'] as ClipId[]);
    pl.duplicate(s);
    expect(starts()).toEqual([0, 3840, 7680, 11520]);
  });

  it('copies and pastes after the selection, deletes and undoes', () => {
    const { s, starts } = setup();
    s.editor.getState().selectClips(['a'] as ClipId[]);
    pl.copy(s);
    pl.paste(s);
    expect(starts()).toEqual([0, 3840, 3840]);
    pl.deleteSelection(s);
    expect(starts()).toEqual([0, 3840]);
    s.history.undo();
    expect(starts()).toHaveLength(3);
  });

  it('dropping a kit sound creates an audio-clip channel and a clip as long as the sample', () => {
    const { s, lanes } = setup();
    addKitAudioClip(s, 'kit/crash', lanes[2]!, 7680);
    const p = s.doc.getState().project;
    const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'audio');
    if (clip?.kind !== 'audio') throw new Error('no audio clip');
    const ch = p.channels[clip.channelId];
    expect(ch?.kind).toBe('audioClip');
    const seconds = kitDuration('kit/crash');
    expect(clip.length).toBe(Math.round((seconds * p.transport.bpm * 960) / 60));
    expect(clip.start).toBe(7680);
  });
});
