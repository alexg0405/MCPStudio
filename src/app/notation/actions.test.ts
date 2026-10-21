import { describe, expect, it } from 'vitest';
import { makeHarmonySong } from '@core/harmony/test-song';
import type { Note, NoteId } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { createTestServices } from '../testing';
import {
  deleteSelectedNotes,
  importMusicXmlText,
  insertNoteAt,
  moveSelectedNotes,
  musicXmlOfSheet,
  setSelectedDuration,
} from './actions';
import { DRUMS_PART, listParts, resolvePart } from './part';
import { sheetState } from './sheet';

function setup() {
  const s = createTestServices();
  const song = makeHarmonySong(['Am', 'F', 'C', 'G'], { root: 0, scale: 'major' });
  s.history.load(song.project);
  s.view.getState().setCurrentPattern(song.patternId);
  s.session.getState().selectChannel(song.channels.lead);
  return { s, song };
}

type Setup = ReturnType<typeof setup>;
const leadNotes = ({ s, song }: Setup): Note[] =>
  Object.values(s.doc.getState().project.patterns[song.patternId]!.notes[song.channels.lead] ?? {}).sort((a, b) => a.tick - b.tick);
const select = ({ s }: Setup, ids: NoteId[]) => s.editor.getState().selectNotes(ids);

describe('which part the sheet shows', () => {
  it('follows the piano roll channel, and lists parts with notes (the kick as a drum part)', () => {
    const { s, song } = setup();
    const state = sheetState(s)!;
    expect(state.part.label).toBe('Lead');
    expect(state.part.isPercussion).toBe(false);
    expect(state.score.clefs).toEqual(['treble']);
    const parts = listParts(s.doc.getState().project, song.patternId);
    expect(parts.map((part) => [part.label, part.isPercussion])).toEqual([
      ['Chords', false],
      ['Bass', false],
      ['Kick', true],
      ['Lead', false],
    ]);
    s.session.getState().selectChannel(song.channels.kick);
    const drums = sheetState(s)!;
    expect(drums.part.isPercussion).toBe(true);
    expect(drums.score.clefs).toEqual(['percussion']);
  });

  it('writes a kick channel as the General MIDI kick, not as the key its sampler plays', () => {
    const { s, song } = setup();
    const part = resolvePart(s.doc.getState().project, song.patternId, 'auto', song.channels.kick)!;
    expect(part.notes.every((note) => note.key === 36)).toBe(true);
    expect(part.notes).toHaveLength(16);
  });

  it('puts every drum channel on one staff as "All drums" when there are several', () => {
    const { s, song } = setup();
    const snare = makeInstrumentChannel('Snare', makePluginInstance('agstudio.3xosc', 1, {}));
    s.history.transact('add snare', (draft) => {
      addChannel(draft, snare);
      draft.patterns[song.patternId]!.notes[snare.id] = { ['n1' as NoteId]: { id: 'n1' as NoteId, tick: 960, length: 120, key: 60, velocity: 0.9 } };
    });
    const parts = listParts(s.doc.getState().project, song.patternId);
    expect(parts[0]).toMatchObject({ id: DRUMS_PART, label: 'All drums', isPercussion: true, noteCount: 17 });
    const all = resolvePart(s.doc.getState().project, song.patternId, DRUMS_PART, null)!;
    expect(new Set(all.notes.map((note) => note.key))).toEqual(new Set([36, 38]));
  });
});

describe('editing from the sheet', () => {
  it('moves selected notes a scale step as one undo step, and the notes underneath change', () => {
    const t = setup();
    const [first] = leadNotes(t);
    select(t, [first!.id]);
    const steps = t.s.history.steps().done.length;
    expect(moveSelectedNotes(t.s, 1, 'scale')).toMatchObject({ ok: true });
    expect(leadNotes(t)[0]!.key).toBe(74);
    expect(moveSelectedNotes(t.s, 1, 'semitone').ok).toBe(true);
    expect(leadNotes(t)[0]!.key).toBe(75);
    expect(moveSelectedNotes(t.s, -1, 'octave').ok).toBe(true);
    expect(leadNotes(t)[0]!.key).toBe(63);
    expect(t.s.history.steps().done.length).toBe(steps + 1);
    t.s.history.undo();
    expect(leadNotes(t)[0]!.key).toBe(first!.key);
  });

  it('says why when nothing is selected or the part is drums', () => {
    const t = setup();
    expect(moveSelectedNotes(t.s, 1, 'scale')).toEqual({ ok: false, message: 'No note is selected: click a note on the sheet first.' });
    t.s.session.getState().selectChannel(t.song.channels.kick);
    const kick = Object.values(t.s.doc.getState().project.patterns[t.song.patternId]!.notes[t.song.channels.kick]!)[0]!;
    select(t, [kick.id]);
    expect(moveSelectedNotes(t.s, 1, 'scale').message).toContain('Drum hits do not move up or down');
    // A duration or a delete still works on drums.
    expect(setSelectedDuration(t.s, { base: 8, isDotted: false, isTriplet: false }).ok).toBe(true);
    expect(deleteSelectedNotes(t.s).ok).toBe(true);
  });

  it('changes the length of selected notes to a typed duration', () => {
    const t = setup();
    const [first, second] = leadNotes(t);
    select(t, [first!.id, second!.id]);
    expect(setSelectedDuration(t.s, { base: 8, isDotted: true, isTriplet: false }).message).toBe('Made 2 notes a dotted eighth note');
    expect(leadNotes(t).slice(0, 2).map((note) => note.length)).toEqual([720, 720]);
    expect(setSelectedDuration(t.s, { base: 8, isDotted: false, isTriplet: true }).ok).toBe(true);
    expect(leadNotes(t)[0]!.length).toBe(320);
  });

  it('deletes selected notes in one step and clears the selection', () => {
    const t = setup();
    const [first, second] = leadNotes(t);
    select(t, [first!.id, second!.id]);
    const steps = t.s.history.steps().done.length;
    expect(deleteSelectedNotes(t.s).message).toBe('Deleted 2 notes');
    expect(leadNotes(t)).toHaveLength(14);
    expect(t.s.editor.getState().noteSelection).toEqual([]);
    expect(t.s.history.steps().done.length).toBe(steps + 1);
  });

  it('inserts a note at a tick in the part’s channel, selects it, and refuses on drums', () => {
    const t = setup();
    const result = insertNoteAt(t.s, { tick: 480, key: 69 }, { base: 8, isDotted: false, isTriplet: false });
    expect(result.ok).toBe(true);
    const added = leadNotes(t).find((note) => note.id === result.noteId)!;
    expect([added.tick, added.length, added.key]).toEqual([480, 480, 69]);
    expect(t.s.editor.getState().noteSelection).toEqual([added.id]);
    expect(insertNoteAt(t.s, { tick: 3840 * 5, key: 60 }, { base: 4, isDotted: false, isTriplet: false }).message).toContain('after the end of the pattern');
    t.s.session.getState().selectChannel(t.song.channels.kick);
    expect(insertNoteAt(t.s, { tick: 0, key: 60 }, { base: 4, isDotted: false, isTriplet: false }).ok).toBe(false);
  });
});

describe('MusicXML in and out', () => {
  it('exports the shown part and imports it back to the same notes in one undo step', () => {
    const t = setup();
    const before = leadNotes(t).map((note) => [note.tick, note.length, note.key]);
    const file = musicXmlOfSheet(t.s)!;
    expect(file.name).toBe(`${t.s.doc.getState().project.meta.title} - Loop.musicxml`);
    t.s.history.transact('clear', (draft) => {
      delete draft.patterns[t.song.patternId]!.notes[t.song.channels.lead];
    });
    const steps = t.s.history.steps().done.length;
    expect(importMusicXmlText(t.s, file.xml, { replace: true }).message).toMatch(/^Imported 16 notes from "Lead"\.$/);
    expect(t.s.history.steps().done.length).toBe(steps + 1);
    expect(leadNotes(t).map((note) => [note.tick, note.length, note.key])).toEqual(before);
  });

  it('adds instead of replacing when asked, and warns about another meter', () => {
    const t = setup();
    const waltz = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Waltz</part-name></score-part></part-list>
      <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>6</octave></pitch><duration>3</duration></note></measure></part></score-partwise>`;
    const result = importMusicXmlText(t.s, waltz, { replace: false });
    expect(result.message).toContain('the file is in 3/4 and the song is in 4/4');
    expect(leadNotes(t)).toHaveLength(17);
  });

  it('says what is wrong with a file, and with the place it goes', () => {
    const t = setup();
    expect(importMusicXmlText(t.s, '<score-timewise/>', { replace: true }).message).toContain('timewise');
    expect(importMusicXmlText(t.s, 'not xml', { replace: true }).ok).toBe(false);
    const drumFile = `<score-partwise><part-list><score-part id="P1"><part-name>Drums</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><clef><sign>percussion</sign></clef></attributes>
      <note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration></note></measure></part></score-partwise>`;
    expect(importMusicXmlText(t.s, drumFile, { replace: true }).message).toContain('That file is a drum part');
    t.s.session.getState().selectChannel(null);
    expect(importMusicXmlText(t.s, drumFile, { replace: true }).message).toContain('Select an instrument channel');
  });
});
