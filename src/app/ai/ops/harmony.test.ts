import { describe, expect, it } from 'vitest';
import { formatChord, mod12 } from '@core/harmony/chord';
import { makeHarmonySong } from '@core/harmony/test-song';
import { symbolOf } from '@core/ops/chords';
import { chordTrackLines, chordsSorted } from '@core/query/chords';
import { projectContext } from '../context';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

type TestServices = ReturnType<typeof createTestServices>;

function setup() {
  const s = createTestServices();
  const song = makeHarmonySong(['C', 'C', 'C', 'C']);
  s.history.load(song.project);
  s.view.getState().setCurrentPattern(song.patternId);
  return { s, song };
}
const run = (s: TestServices, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const chordNames = (s: TestServices) => chordsSorted(s.doc.getState().project).map((event) => formatChord(symbolOf(event)));
const keysAt = (s: TestServices, song: ReturnType<typeof setup>['song'], channel: 'chords' | 'bass' | 'lead', tick: number) =>
  Object.values(s.doc.getState().project.patterns[song.patternId]!.notes[song.channels[channel]] ?? {})
    .filter((note) => note.tick === tick)
    .map((note) => note.key);

describe('harmony actions', () => {
  it('sets, replaces and clears the chord track, one undo step for the answer', () => {
    const { s } = setup();
    const steps = s.history.steps().done.length;
    const turn = run(s, [{ op: 'chords', action: 'set', text: 'Am7 | F | C | G' }]);
    expect(turn.warnings).toEqual([]);
    expect(chordNames(s)).toEqual(['Am7', 'F', 'C', 'G']);
    expect(s.history.steps().done.length).toBe(steps + 1);
    run(s, [{ op: 'chords', action: 'set', text: 'Dm', from_bar: 2 }]);
    expect(chordNames(s)).toEqual(['Am7', 'Dm', 'C', 'G']);
    run(s, [{ op: 'chords', action: 'clear', from_bar: 2, to_bar: 3 }]);
    expect(chordNames(s)).toEqual(['Am7', 'G']);
    run(s, [{ op: 'chords', action: 'clear' }]);
    expect(s.doc.getState().project.chords).toBeUndefined();
    expect(run(s, [{ op: 'chords', action: 'clear' }]).warnings.join(' ')).toContain('no chords');
    expect(run(s, [{ op: 'chords', action: 'set', text: 'Am Q' }]).warnings.join(' ')).toContain('not chords: Q');
  });

  it('applies a palette progression in the song key and reads chords from existing notes', () => {
    const { s } = setup();
    run(s, [{ op: 'song', key: 'A minor' }, { op: 'chords', action: 'progression', progression: 'minor-epic', bars: 8 }]);
    expect(chordTrackLines(s.doc.getState().project)).toEqual(['bars 1–8: Am | F | C | G | Am | F | C | G']);
    expect(run(s, [{ op: 'chords', action: 'progression', progression: 'nope' }]).warnings.join(' ')).toContain('no progression');
    const other = setup();
    other.s.history.load(makeHarmonySong(['Dm', 'Bb', 'F', 'C']).project);
    run(other.s, [{ op: 'chords', action: 'detect' }]);
    expect(chordNames(other.s)).toEqual(['Dm', 'A#', 'F', 'C']);
  });

  it('voices chords, writes basslines and fits a melody, seeing chords set earlier in the same answer', () => {
    const { s, song } = setup();
    const turn = run(s, [
      { op: 'chords', action: 'set', text: 'Am | F | C | G' },
      { op: 'voice_chords', channel: song.channels.chords, register: 'low' },
      { op: 'bassline', channel: song.channels.bass, style: '808' },
      { op: 'fit_melody', channel: song.channels.lead, strength: 1 },
    ]);
    expect(turn.warnings).toEqual([]);
    expect(turn.changes.join('\n')).toContain('voiced chords');
    expect(keysAt(s, song, 'chords', 0).map(mod12).sort((a, b) => a - b)).toEqual([0, 4, 9]);
    expect(mod12(keysAt(s, song, 'bass', 3840)[0]!)).toBe(5);
    const lead = keysAt(s, song, 'lead', 0)[0]!;
    expect([0, 4, 9]).toContain(mod12(lead));
    s.history.undo();
    expect(s.doc.getState().project.chords).toBeUndefined();
  });

  it('says what is missing', () => {
    const { s, song } = setup();
    const turn = run(s, [
      { op: 'voice_chords', channel: song.channels.chords },
      { op: 'bassline', channel: song.channels.bass, style: 'sideways' },
      { op: 'fit_melody', channel: song.channels.lead },
    ]);
    expect(turn.warnings.join('\n')).toContain('chord track has no chords');
    expect(turn.warnings.join('\n')).toContain('style must be one of');
  });

  it('shows the chord track in the context Studio reads', () => {
    const { s } = setup();
    run(s, [{ op: 'chords', action: 'set', text: 'Am7 | F | C | G' }]);
    const text = projectContext(s);
    expect(text).toContain('Chord track');
    expect(text).toContain('  bars 1–4: Am7 | F | C | G');
  });

  it('get_chords reads the track back with Roman numerals, next-chord ideas and palette progressions', () => {
    const { s } = setup();
    run(s, [{ op: 'song', key: 'C major' }, { op: 'chords', action: 'set', text: 'C | F | G' }]);
    const read = runReadTool(s, 'get_chords', { next_bar: 4, genre: 'trap' }) as {
      chords: { bar: number; chord: string; roman: string }[];
      next: { chord: string }[];
      progressions: { id: string }[];
    };
    expect(read.chords.map((entry) => `${entry.bar} ${entry.chord} ${entry.roman}`)).toEqual(['1 C I', '2 F IV', '3 G V']);
    expect(read.next[0]!.chord).toBe('C');
    expect(read.progressions.map((entry) => entry.id)).toContain('trap-two');
  });
});
