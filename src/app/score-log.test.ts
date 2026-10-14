import { describe, expect, it } from 'vitest';
import type { ChannelId } from '@core/model/types';
import { dumpScoreLog, lastPhrase, planDump, type LoggedNote } from './score-log';
import { createTestServices } from './testing';

const typing = { source: 'typing' as const };
const note = (on: number, off: number | null, key = 60, channelId: ChannelId | null = 'ch1' as ChannelId): LoggedNote => ({
  channelId,
  key,
  velocity: 0.8,
  release: 0.5,
  on,
  off,
});

describe('score log', () => {
  it('keeps what was played, with its timing, recording or not', () => {
    const s = createTestServices();
    const ch = s.session.getState().selectedChannelId;
    s.live.noteOn(60, 0.9, typing, 1000);
    s.live.noteOff(60, 0.4, typing, 1500);
    s.live.noteOn(64, 0.7, typing, 2000);
    const log = s.scoreLog.all();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ channelId: ch, key: 60, velocity: 0.9, release: 0.4, on: 1, off: 1.5 });
    expect(log[1]).toMatchObject({ key: 64, off: null });
  });

  it('forgets notes older than five minutes', () => {
    const s = createTestServices();
    s.live.noteOn(60, 0.9, typing, 1000);
    s.live.noteOff(60, 0.4, typing, 1100);
    s.live.noteOn(62, 0.9, typing, 1000 + 301_000);
    expect(s.scoreLog.all().map((n) => n.key)).toEqual([62]);
  });

  it('finds the last phrase after a pause', () => {
    const notes = [note(0, 0.5), note(1, 1.5), note(10, 10.4), note(10.5, 11), note(12, 13)];
    expect(lastPhrase(notes).map((n) => n.on)).toEqual([10, 10.5, 12]);
    // A long held note bridges a gap between note starts.
    expect(lastPhrase([note(0, 8), note(9, 9.5)]).map((n) => n.on)).toEqual([0, 9]);
    expect(lastPhrase([])).toEqual([]);
  });

  it('turns seconds into ticks at the song tempo, snapping starts if asked', () => {
    // 120 BPM: a beat (960 ticks) every 0.5 s.
    const plan = planDump([note(10, 10.25), note(10.52, 10.9, 64)], 120, 0, null, 11);
    const notes = plan.get('ch1' as ChannelId)!;
    expect(notes.map((n) => [n.tick, n.length, n.key])).toEqual([
      [0, 480, 60],
      [998, 730, 64],
    ]);
    const snapped = planDump([note(10, 10.25), note(10.52, 10.9, 64)], 120, 240, null, 11).get('ch1' as ChannelId)!;
    expect(snapped.map((n) => n.tick)).toEqual([0, 960]);
    // No channel when played: the fallback channel gets it.
    expect(planDump([note(0, 1, 60, null)], 120, 0, 'other' as ChannelId, 2).has('other' as ChannelId)).toBe(true);
  });

  it('dumps into a new pattern in one undo step', () => {
    const s = createTestServices();
    const ch = s.session.getState().selectedChannelId!;
    s.live.noteOn(60, 0.9, typing, 0);
    s.live.noteOff(60, 0.4, typing, 400);
    s.live.noteOn(67, 0.6, typing, 500);
    s.live.noteOff(67, 0.5, typing, 900);
    const before = s.doc.getState().project.patternOrder.length;
    const undo = s.history.steps().done.length;
    const r = dumpScoreLog(s, { span: 'phrase', quantize: 240, into: 'new' });
    expect('notes' in r && r.notes).toBe(2);
    const p = s.doc.getState().project;
    expect(p.patternOrder.length).toBe(before + 1);
    expect(s.history.steps().done.length).toBe(undo + 1);
    const id = s.view.getState().currentPatternId!;
    const notes = Object.values(p.patterns[id]!.notes[ch] ?? {}).sort((a, b) => a.tick - b.tick);
    expect(notes.map((n) => n.key)).toEqual([60, 67]);
    expect(p.patterns[id]!.name).toMatch(/^Played /);
  });

  it('says what to do when nothing was played', () => {
    const s = createTestServices();
    expect(dumpScoreLog(s, { span: 'all', quantize: 0, into: 'new' })).toEqual({
      error: expect.stringMatching(/Nothing played yet/),
    });
  });
});
