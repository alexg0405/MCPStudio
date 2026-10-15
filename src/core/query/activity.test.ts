import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { buildStackedSong } from '../fixtures/stacked-song';
import { createEmptyProject, makeInstrumentChannel, makePattern, makePluginInstance } from '../model/defaults';
import type { ChannelId, ClipId, NoteId, PatternId, Project } from '../model/types';
import { barActivity } from './activity';

const BAR = 3840;
const STEP = 240;

/** One 1-bar pattern with a kick on every beat and a hat on every 8th, and a lead channel. */
function song(): { p: Project; kick: ChannelId; hat: ChannelId; pid: PatternId } {
  let kick = '' as ChannelId;
  let hat = '' as ChannelId;
  let pid = '' as PatternId;
  const p = produce(createEmptyProject(), (d) => {
    for (const name of ['Kick', 'Hat']) {
      const ch = makeInstrumentChannel(name, makePluginInstance('agstudio.sampler', 1, {}));
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
      if (name === 'Kick') kick = ch.id;
      else hat = ch.id;
    }
    const pat = makePattern('Beat', '#888888');
    pat.length = BAR;
    const note = (i: number, step: number) => ({ id: `n_${i}` as NoteId, tick: step * STEP, length: STEP, key: 60, velocity: 0.8 });
    pat.notes[kick] = Object.fromEntries([0, 4, 8, 12].map((s, i) => [`n_${i}`, note(i, s)])) as never;
    pat.notes[hat] = Object.fromEntries([0, 2, 4, 6, 8, 10, 12, 14].map((s, i) => [`n_h${i}`, { ...note(i, s), id: `n_h${i}` }])) as never;
    d.patterns[pat.id] = pat;
    d.patternOrder.push(pat.id);
    pid = pat.id;
    const lane = d.playlist.laneOrder[0]!;
    // Two bars of the beat from bar 2, then half a bar starting in the middle of the pattern.
    d.playlist.clips['clip_a' as ClipId] = { kind: 'pattern', id: 'clip_a' as ClipId, laneId: lane, start: BAR, length: 2 * BAR, patternId: pat.id, offset: 0 };
    d.playlist.clips['clip_b' as ClipId] = {
      kind: 'pattern',
      id: 'clip_b' as ClipId,
      laneId: lane,
      start: 3 * BAR,
      length: BAR / 2,
      patternId: pat.id,
      offset: BAR / 2,
    };
  });
  return { p, kick, hat, pid };
}

describe('bar activity', () => {
  it('counts the notes that start in each bar, looping pattern clips from their offset', () => {
    const { p, kick, hat } = song();
    const bars = barActivity(p, 0, 4 * BAR);
    expect(bars.map((b) => [b.bar, b.total])).toEqual([
      [1, 0],
      [2, 12],
      [3, 12],
      // The second half of the pattern: kicks on steps 8 and 12, hats on 8, 10, 12, 14.
      [4, 6],
    ]);
    expect(bars[1]!.notes).toEqual([
      { channelId: kick, count: 4 },
      { channelId: hat, count: 8 },
    ]);
    expect(bars[3]!.from).toBe(3 * BAR);
  });

  it('leaves out what does not play: muted clips, lanes, channels and notes', () => {
    const { p, hat } = song();
    const q = produce(p, (d) => {
      d.playlist.clips['clip_b' as ClipId]!.muted = true;
      d.channels[hat]!.muted = true;
    });
    const bars = barActivity(q, BAR, 4 * BAR);
    expect(bars.map((b) => b.total)).toEqual([4, 4, 0]);
    const r = produce(p, (d) => {
      d.playlist.lanes[d.playlist.laneOrder[0]!]!.muted = true;
    });
    expect(barActivity(r, 0, 4 * BAR).every((b) => b.total === 0)).toBe(true);
  });

  it('lists audio and automation clips per bar on the stacked song, and works on a draft', () => {
    const p = produce(createEmptyProject(), (d) => void buildStackedSong(d));
    const bars = barActivity(p, 12 * BAR, 20 * BAR);
    expect(bars.map((b) => b.bar)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    // The riser's pitch automation runs over bars 15–16; the filter sweep stops after bar 8.
    expect(bars.filter((b) => b.automation.length > 0).map((b) => b.bar)).toEqual([15, 16]);
    // Bar 16 has the tom fill on top of the break; bar 17 starts the verse.
    expect(bars[3]!.notes.some((n) => p.channels[n.channelId]?.name === 'Perc')).toBe(true);
    expect(bars[4]!.total).toBeGreaterThan(bars[3]!.total);
    let onDraft: ReturnType<typeof barActivity> = [];
    produce(p, (d) => {
      onDraft = barActivity(d as unknown as Project, 12 * BAR, 20 * BAR);
    });
    expect(onDraft.map((b) => b.total)).toEqual(bars.map((b) => b.total));
  });
});
