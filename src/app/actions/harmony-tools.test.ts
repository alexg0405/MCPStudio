import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import type { ChannelId, PatternId } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { notesSorted } from '@core/query/queries';
import { note } from '../../../test/helpers/notes';
import { applyNoteScript } from './note-scripts';

/** A C major chord held for a bar, in a project at 120 BPM. */
function chordSetup() {
  const s = createTestServices();
  const project = s.doc.getState().project;
  const channelId = project.channelOrder[0] as ChannelId;
  const patternId = project.patternOrder[0] as PatternId;
  s.session.getState().selectChannel(channelId);
  s.history.transact('seed', (draft) => {
    draft.transport.bpm = 120;
    addNotes(draft, patternId, channelId, [note('a', 0, 60, 3840), note('b', 0, 64, 3840), note('c', 0, 67, 3840)]);
  });
  const read = () => notesSorted(s.doc.getState().project.patterns[patternId]!.notes[channelId]);
  return { s, read };
}

describe('strum and arpeggiate as one undo step', () => {
  it('strums a chord over milliseconds, up or down, whatever the tempo', () => {
    const { s, read } = chordSetup();
    const steps = s.history.steps().done.length;
    // 125 ms at 120 BPM is 240 ticks end to end; three notes are spread evenly.
    expect(applyNoteScript(s, s.plugins.script('agstudio.notes.strum')!, { ms: 125 })).toBe(true);
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect(read().map((n) => [n.key, n.tick])).toEqual([[60, 0], [64, 120], [67, 240]]);
    s.history.undo();
    expect(read().map((n) => n.tick)).toEqual([0, 0, 0]);
    applyNoteScript(s, s.plugins.script('agstudio.notes.strum')!, { ms: 125, direction: 'down' });
    expect(read().map((n) => [n.key, n.tick])).toEqual([[67, 0], [64, 120], [60, 240]].sort((a, b) => (a[1] as number) - (b[1] as number)));
    s.history.undo();
    s.history.transact('tempo', (draft) => {
      draft.transport.bpm = 60;
    });
    applyNoteScript(s, s.plugins.script('agstudio.notes.strum')!, { ms: 125 });
    // The same 125 ms is half as many ticks at half the tempo.
    expect(Math.max(...read().map((n) => n.tick))).toBe(120);
  });

  it('arpeggiates by pattern, rate and octaves, one step, and undoes', () => {
    const { s, read } = chordSetup();
    const steps = s.history.steps().done.length;
    expect(applyNoteScript(s, s.plugins.script('agstudio.notes.arpeggiate')!, { pattern: 'up', rate: '1/8', octaves: 2 })).toBe(true);
    expect(s.history.steps().done.length).toBe(steps + 1);
    const notes = read().filter((n) => n.tick < 3840);
    expect(notes.slice(0, 6).map((n) => n.key)).toEqual([60, 64, 67, 72, 76, 79]);
    expect(notes[1]!.tick - notes[0]!.tick).toBe(480);
    s.history.undo();
    expect(read()).toHaveLength(3);
    applyNoteScript(s, s.plugins.script('agstudio.notes.arpeggiate')!, { pattern: 'down', rate: '1/16' });
    expect(read().slice(0, 3).map((n) => n.key)).toEqual([67, 64, 60]);
    expect(read()[1]!.tick - read()[0]!.tick).toBe(240);
  });
});
