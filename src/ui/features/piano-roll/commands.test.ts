import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import type { ChannelId, Note, NoteId, PatternId } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { pianoRollCommands as pr, noteTarget } from './commands';

const n = (id: string, tick: number, key: number, length = 240): Note => ({
  id: id as NoteId,
  tick,
  length,
  key,
  velocity: 0.8,
});

function setup() {
  const s = createTestServices();
  const p = s.doc.getState().project;
  const cid = p.channelOrder[0] as ChannelId;
  const pid = p.patternOrder[0] as PatternId;
  s.session.getState().selectChannel(cid);
  s.history.transact('seed', (d) => addNotes(d, pid, cid, [n('a', 0, 60), n('b', 300, 64), n('c', 960, 67, 480)]));
  s.editor.getState().setPianoRoll({ snap: 'step' });
  const notes = () => [...noteTarget(s)!.notes].map((x) => `${x.tick}:${x.key}:${x.length}`);
  return { s, cid, pid, notes };
}

describe('piano roll commands', () => {
  it('deletes the selection as one undo step', () => {
    const { s, notes } = setup();
    s.editor.getState().selectNotes(['a', 'c'] as NoteId[]);
    pr.deleteSelection(s);
    expect(notes()).toEqual(['300:64:240']);
    expect(s.editor.getState().noteSelection).toEqual([]);
    s.history.undo();
    expect(notes()).toHaveLength(3);
  });

  it('copies and pastes after the selection with new ids', () => {
    const { s, notes } = setup();
    s.editor.getState().selectNotes(['a', 'b'] as NoteId[]);
    pr.copy(s);
    pr.paste(s);
    // The selection ends at 540, so the copy starts on the next step line (720).
    expect(notes()).toEqual(['0:60:240', '300:64:240', '720:60:240', '960:67:480', '1020:64:240']);
    const ids = s.editor.getState().noteSelection;
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain('a');
  });

  it('duplicates the selection right after itself', () => {
    const { s, notes } = setup();
    s.editor.getState().selectNotes(['c'] as NoteId[]);
    pr.duplicate(s);
    expect(notes()).toContain('1440:67:480');
  });

  it('transposes within MIDI range and merges repeated presses', () => {
    const { s, notes } = setup();
    s.editor.getState().selectNotes(['c'] as NoteId[]);
    pr.transpose(s, 12);
    pr.transpose(s, 12);
    pr.transpose(s, 100); // clamps at 127
    expect(notes()).toContain('960:127:480');
    s.history.undo();
    expect(notes()).toContain('960:67:480');
  });

  it('nudges by the grid but not before zero', () => {
    const { s, notes } = setup();
    s.editor.getState().selectNotes(['a'] as NoteId[]);
    pr.nudge(s, -1);
    expect(notes()[0]).toBe('0:60:240');
    pr.nudge(s, 1);
    expect(notes()).toContain('240:60:240');
  });

  it('quantizes starts to the grid (all notes when nothing is selected)', () => {
    const { s, notes } = setup();
    pr.quantize(s);
    expect(notes()).toEqual(['0:60:240', '240:64:240', '960:67:480']);
  });
});
