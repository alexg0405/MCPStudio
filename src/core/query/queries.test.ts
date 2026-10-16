import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import type { ChannelId, Note, NoteId, PatternId, Project } from '../model/types';
import { addChannel, toggleSoloChannel, setChannelProp } from '../ops/channels';
import { addNote, setStep } from '../ops/notes';
import { PPQ, TICKS_PER_STEP, constantTempo, formatBST, keyName, ticksPerBar } from '../time/ppq';
import { effectivelyMuted, lowestNoteKey, notesOverlapping, notesStartingIn, patternLength, sortedNotes, stepView } from './queries';

const n = (id: string, tick: number, length = TICKS_PER_STEP, key = 60): Note => ({
  id: id as NoteId,
  tick,
  length,
  key,
  velocity: 0.8,
});

function withChannel(): { p: Project; pid: PatternId; cid: ChannelId } {
  const base = createEmptyProject();
  const ch = makeInstrumentChannel('Kick', makePluginInstance('x', 1, {}));
  const p = produce(base, (d) => addChannel(d, ch));
  return { p, pid: p.patternOrder[0] as PatternId, cid: ch.id };
}

describe('time', () => {
  it('converts ticks and seconds at constant tempo', () => {
    const t = constantTempo(120);
    expect(t.tickToSeconds(PPQ)).toBeCloseTo(0.5);
    expect(t.secondsToTick(1)).toBeCloseTo(2 * PPQ);
    expect(ticksPerBar({ num: 4, den: 4 })).toBe(3840);
    expect(ticksPerBar({ num: 6, den: 8 })).toBe(2880);
  });

  it('formats bar:step:tick like FL', () => {
    const ts = { num: 4, den: 4 };
    expect(formatBST(0, ts)).toBe('1:01:000');
    expect(formatBST(3840 + 5 * 240 + 120, ts)).toBe('2:06:120');
    expect(keyName(60)).toBe('C5');
    expect(keyName(69)).toBe('A5');
  });
});

describe('note queries', () => {
  const notes = { a: n('a', 960, 3000), b: n('b', 0), c: n('c', 480), d: n('d', 4000) } as Record<NoteId, Note>;

  it('sorts and memoizes by identity', () => {
    const s1 = sortedNotes(notes);
    expect(s1.map((x) => x.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(sortedNotes(notes)).toBe(s1);
  });

  it('finds notes starting in a range', () => {
    expect(notesStartingIn(sortedNotes(notes), 480, 1000).map((x) => x.id)).toEqual(['c', 'a']);
    expect(notesStartingIn(sortedNotes(notes), 4001, 9999)).toEqual([]);
  });

  it('includes long notes that started before the range', () => {
    expect(notesOverlapping(sortedNotes(notes), 3500, 3600).map((x) => x.id)).toEqual(['a']);
  });
});

describe('lowestNoteKey', () => {
  it('is the lowest unmuted note of the channel in any pattern, or null', () => {
    const { p, pid, cid } = withChannel();
    expect(lowestNoteKey(p, cid)).toBeNull();
    const q = produce(p, (d) => {
      addNote(d, pid, cid, n('a', 0, 240, 64));
      addNote(d, pid, cid, n('b', 240, 240, 52));
      addNote(d, pid, cid, { ...n('c', 480, 240, 30), muted: true });
    });
    expect(lowestNoteKey(q, cid)).toBe(52);
    expect(lowestNoteKey(q, 'other' as ChannelId)).toBeNull();
  });
});

describe('pattern queries', () => {
  it('derives length from steps and notes in whole bars', () => {
    const { p, pid, cid } = withChannel();
    const ts = p.transport.timeSig;
    expect(patternLength(p.patterns[pid]!, ts)).toBe(3840);
    const p2 = produce(p, (d) => addNote(d, pid, cid, n('x', 3840 * 2 + 10)));
    expect(patternLength(p2.patterns[pid]!, ts)).toBe(3840 * 3);
  });

  it('projects step notes onto the grid', () => {
    const { p, pid, cid } = withChannel();
    const p2 = produce(p, (d) => {
      setStep(d, pid, cid, 0, true, { rootKey: 60 });
      setStep(d, pid, cid, 4, true, { rootKey: 60, velocity: 0.5 });
    });
    const view = stepView(p2.patterns[pid]!.notes[cid], 16);
    expect(view.isSteps).toBe(true);
    expect(view.velocities.map((v) => (v > 0 ? 1 : 0)).join('')).toBe('1000100000000000');
    const p3 = produce(p2, (d) => addNote(d, pid, cid, n('long', 0, 960, 64)));
    expect(stepView(p3.patterns[pid]!.notes[cid], 16).isSteps).toBe(false);
  });

  it('setStep off removes the note and grows stepCount when needed', () => {
    const { p, pid, cid } = withChannel();
    const on = produce(p, (d) => setStep(d, pid, cid, 20, true, { rootKey: 60 }));
    expect(on.patterns[pid]!.stepCount).toBe(32);
    const off = produce(on, (d) => setStep(d, pid, cid, 20, false, { rootKey: 60 }));
    expect(off.patterns[pid]!.notes[cid]).toBeUndefined();
  });
});

describe('mute/solo', () => {
  it('computes FL-style exclusive solo', () => {
    let { p } = withChannel();
    const b = makeInstrumentChannel('Snare', makePluginInstance('x', 1, {}));
    p = produce(p, (d) => addChannel(d, b));
    const [a] = p.channelOrder as [ChannelId];
    const soloed = produce(p, (d) => toggleSoloChannel(d, b.id));
    expect([...effectivelyMuted(soloed.channels)]).toEqual([a]);
    const unsolo = produce(soloed, (d) => toggleSoloChannel(d, b.id));
    expect([...effectivelyMuted(unsolo.channels)]).toEqual([]);
    const muted = produce(p, (d) => setChannelProp(d, a, 'muted', true));
    expect(effectivelyMuted(muted.channels).has(a)).toBe(true);
  });
});
