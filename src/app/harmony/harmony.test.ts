import { describe, expect, it } from 'vitest';
import { formatChord } from '@core/harmony/chord';
import { makeHarmonySong } from '@core/harmony/test-song';
import { chordsSorted, chordTrackLines } from '@core/query/chords';
import { symbolOf } from '@core/ops/chords';
import { mod12 } from '@core/harmony/chord';
import { createTestServices } from '../testing';
import { applyProgressionByName, clearChordTrack, nextChordSuggestions, renameChord, typeChords } from './chord-track';
import { detectChords } from './detect';
import { fitMelodyToChords, makeBassline, makeChordPart } from './parts';

const BAR = 3840;

function servicesWithSong(names: readonly string[] = ['C', 'C', 'C', 'C'], key = { root: 0, scale: 'major' }) {
  const s = createTestServices();
  const song = makeHarmonySong(names, key);
  s.history.load(song.project);
  s.view.getState().setCurrentPattern(song.patternId);
  return { s, song };
}

const names = (s: ReturnType<typeof createTestServices>) => chordsSorted(s.doc.getState().project).map((event) => formatChord(symbolOf(event)));
const undoSteps = (s: ReturnType<typeof createTestServices>) => s.history.steps().done.length;

describe('the chord track from the app', () => {
  it('types a progression, one undo step', () => {
    const { s } = servicesWithSong();
    const before = undoSteps(s);
    expect(typeChords(s, 'Am7 | F | C | G').ok).toBe(true);
    expect(names(s)).toEqual(['Am7', 'F', 'C', 'G']);
    expect(undoSteps(s)).toBe(before + 1);
    s.history.undo();
    expect(s.doc.getState().project.chords).toBeUndefined();
  });

  it('refuses text that is not chords, and lets a dot hold the chord before', () => {
    const { s } = servicesWithSong();
    expect(typeChords(s, 'Am Q F')).toEqual({ ok: false, message: expect.stringContaining('Not chords: Q') });
    expect(s.doc.getState().project.chords).toBeUndefined();
    typeChords(s, 'Am . F G', { startBar: 3 });
    expect(chordTrackLines(s.doc.getState().project)).toEqual(['bars 1–6: – | – | Am | Am | F | G']);
  });

  it('applies a palette progression in the song key, repeated to fill, replacing what was there (one undo step)', () => {
    const { s } = servicesWithSong(['C'], { root: 9, scale: 'minor' });
    typeChords(s, 'Dm | Dm | Dm | Dm | Dm | Dm');
    const before = undoSteps(s);
    const result = applyProgressionByName(s, 'minor-epic', { startBar: 1, bars: 8 });
    expect(result.ok).toBe(true);
    expect(chordTrackLines(s.doc.getState().project)).toEqual(['bars 1–8: Am | F | C | G | Am | F | C | G']);
    expect(undoSteps(s)).toBe(before + 1);
    s.history.undo();
    expect(names(s)).toEqual(['Dm', 'Dm', 'Dm', 'Dm', 'Dm', 'Dm']);
  });

  it('moves a minor progression to the relative key of a major song', () => {
    const { s } = servicesWithSong(['C'], { root: 0, scale: 'major' });
    applyProgressionByName(s, 'minor-epic', { startBar: 1 });
    expect(names(s)).toEqual(['Am', 'F', 'C', 'G']);
    expect(applyProgressionByName(s, 'no such thing').ok).toBe(false);
  });

  it('edits and clears chords as one undo step each', () => {
    const { s } = servicesWithSong();
    typeChords(s, 'Am | F');
    const id = chordsSorted(s.doc.getState().project)[0]!.id;
    expect(renameChord(s, id, 'Dm7/C')).toBe(true);
    expect(renameChord(s, id, 'nonsense')).toBe(false);
    expect(names(s)).toEqual(['Dm7/C', 'F']);
    s.history.undo();
    expect(names(s)).toEqual(['Am', 'F']);
    expect(clearChordTrack(s, 2, 2).ok).toBe(true);
    expect(names(s)).toEqual(['Am']);
    expect(clearChordTrack(s).ok).toBe(true);
    expect(clearChordTrack(s).ok).toBe(false);
    s.history.undo();
    expect(names(s)).toEqual(['Am']);
  });

  it('suggests what comes next in the key from the chord before the position', () => {
    const { s } = servicesWithSong();
    typeChords(s, 'C | F');
    const next = nextChordSuggestions(s, BAR * 2);
    expect(['G', 'C']).toContain(formatChord(next[0]!.chord));
    expect(formatChord(nextChordSuggestions(s, 0)[0]!.chord)).toBe('C');
  });
});

describe('detecting chords in the app', () => {
  it('reads the whole song, a selection, and says when there is nothing to read', async () => {
    const { s } = servicesWithSong(['Am', 'F', 'C', 'G']);
    const before = undoSteps(s);
    const result = await detectChords(s);
    expect(result.ok).toBe(true);
    expect(names(s)).toEqual(['Am', 'F', 'C', 'G']);
    expect(undoSteps(s)).toBe(before + 1);
    expect(Object.values(s.doc.getState().project.chords!).every((event) => event.confidence !== undefined)).toBe(true);
    expect((await detectChords(s, { where: 'selection' })).message).toContain('Select some clips');
    expect((await detectChords(s, { where: 'loop' })).message).toContain('no loop region');
    s.history.undo();
    expect(s.doc.getState().project.chords).toBeUndefined();
    const empty = createTestServices();
    expect((await detectChords(empty)).ok).toBe(false);
  });

  it('reads only the loop region and keeps chords outside it', async () => {
    const { s } = servicesWithSong(['Am', 'F', 'C', 'G']);
    typeChords(s, 'Dm | Dm | Dm | Dm | Dm | Dm');
    s.view.getState().setLoop({ start: BAR * 2, end: BAR * 4 });
    await detectChords(s, { where: 'loop' });
    expect(names(s)).toEqual(['Dm', 'Dm', 'C', 'G', 'Dm', 'Dm']);
  });

  it('reads half bars when asked', async () => {
    const { s } = servicesWithSong(['Am', 'F']);
    await detectChords(s, { resolution: 'half' });
    expect(names(s)).toEqual(['Am', 'F']);
    expect(Object.values(s.doc.getState().project.chords!).map((event) => event.length)).toEqual([BAR, BAR]);
  });
});

describe('writing parts from the chord track', () => {
  function withChordsAndTarget(channel: 'chords' | 'bass' | 'lead') {
    const { s, song } = servicesWithSong(['C', 'C', 'C', 'C']);
    typeChords(s, 'Am | F | C | G');
    s.session.getState().selectChannel(song.channels[channel]);
    return { s, song };
  }
  const notesOf = (s: ReturnType<typeof createTestServices>, channelId: string, patternId: string) =>
    Object.values(s.doc.getState().project.patterns[patternId as never]!.notes[channelId as never] ?? {});

  it('makes voiced chords in the selected channel, replacing its notes, one undo step', () => {
    const { s, song } = withChordsAndTarget('chords');
    const before = undoSteps(s);
    const result = makeChordPart(s, { register: 'mid' });
    expect(result.ok).toBe(true);
    expect(undoSteps(s)).toBe(before + 1);
    const notes = notesOf(s, song.channels.chords, song.patternId);
    const first = notes.filter((note) => note.tick === 0).map((note) => mod12(note.key)).sort((a, b) => a - b);
    expect(first).toEqual([0, 4, 9]);
    s.history.undo();
    expect(notesOf(s, song.channels.chords, song.patternId).filter((note) => note.tick === 0).map((note) => mod12(note.key)).sort((a, b) => a - b)).toEqual([0, 4, 7]);
  });

  it('makes a bassline of each style and says what the channel must be', () => {
    const { s, song } = withChordsAndTarget('bass');
    for (const style of ['roots', 'root-fifth', 'walking', '808'] as const) {
      expect(makeBassline(s, { style }).ok, style).toBe(true);
    }
    const notes = notesOf(s, song.channels.bass, song.patternId);
    expect(notes.length).toBeGreaterThan(4);
    expect(notes.every((note) => note.key >= 28 && note.key < 40)).toBe(true);
    s.session.getState().selectChannel(null);
    expect(makeBassline(s, { style: 'roots' }).message).toContain('Select an instrument channel');
  });

  it('refuses without chords', () => {
    const { s, song } = servicesWithSong();
    s.session.getState().selectChannel(song.channels.chords);
    expect(makeChordPart(s).message).toContain('no chords there yet');
  });

  it('fits the melody to the chords, by strength, one undo step', () => {
    const { s, song } = withChordsAndTarget('lead');
    const before = notesOf(s, song.channels.lead, song.patternId).map((note) => note.key);
    const steps = undoSteps(s);
    const result = fitMelodyToChords(s, 1);
    expect(result.ok).toBe(true);
    expect(undoSteps(s)).toBe(steps + 1);
    const after = notesOf(s, song.channels.lead, song.patternId).map((note) => note.key);
    expect(after).not.toEqual(before);
    expect(fitMelodyToChords(s, 1).message).toContain('already fits');
    s.history.undo();
    expect(notesOf(s, song.channels.lead, song.patternId).map((note) => note.key)).toEqual(before);
  });
});
