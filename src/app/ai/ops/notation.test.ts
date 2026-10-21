import { describe, expect, it } from 'vitest';
import { makeHarmonySong } from '@core/harmony/test-song';
import type { Note } from '@core/model/types';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

type TestServices = ReturnType<typeof createTestServices>;

function setup() {
  const s = createTestServices();
  const song = makeHarmonySong(['Am', 'F', 'C', 'G'], { root: 0, scale: 'major' });
  s.history.load(song.project);
  s.view.getState().setCurrentPattern(song.patternId);
  s.session.getState().selectChannel(song.channels.lead);
  return { s, song };
}
const run = (s: TestServices, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const notesOf = (s: TestServices, patternId: string, channelId: string): Array<[number, number, number]> =>
  Object.values(s.doc.getState().project.patterns[patternId as never]!.notes[channelId as never] ?? {})
    .sort((a: Note, b: Note) => a.tick - b.tick || a.key - b.key)
    .map((note: Note) => [note.tick, note.length, note.key]);

describe('write_notation', () => {
  it('writes a channel’s notes from the text, replacing what was there, as one undo step', () => {
    const { s, song } = setup();
    const steps = s.history.steps().done.length;
    const turn = run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| C4q E4q G4h | [C4 E4 G4]w |' }]);
    expect(turn.warnings).toEqual([]);
    expect(turn.changes[0]).toBe('Wrote 6 notes for “Lead” in “Loop” from the notation (2 bars)');
    expect(notesOf(s, song.patternId, song.channels.lead)).toEqual([
      [0, 960, 60],
      [960, 960, 64],
      [1920, 1920, 67],
      [3840, 3840, 60],
      [3840, 3840, 64],
      [3840, 3840, 67],
    ]);
    expect(s.history.steps().done.length).toBe(steps + 1);
    s.history.undo();
    expect(notesOf(s, song.patternId, song.channels.lead)).toHaveLength(16);
  });

  it('starts at from_bar, adds when replace is false, and joins ties', () => {
    const { s, song } = setup();
    run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| C4h~ C4q rq |', from_bar: 3, replace: false }]);
    const all = notesOf(s, song.patternId, song.channels.lead);
    expect(all).toHaveLength(17);
    expect(all.filter(([, , key]) => key === 60)).toEqual([[7680, 2880, 60]]);
  });

  it('reports words it did not understand and bars that do not add up, and writes the rest', () => {
    const { s, song } = setup();
    const turn = run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| C4q zzz D4q |' }]);
    expect(turn.warnings.join(' ')).toContain('"zzz" is not a note');
    expect(turn.warnings.join(' ')).toContain('bar 1 holds 2 beats but the meter has 4');
    expect(notesOf(s, song.patternId, song.channels.lead)).toEqual([
      [0, 960, 60],
      [960, 960, 62],
    ]);
  });

  it('says what is wrong instead of guessing', () => {
    const { s, song } = setup();
    expect(run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '   ' }]).warnings.join(' ')).toMatch(/needs text/);
    expect(run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| zzz |' }]).warnings.join(' ')).toContain('"zzz" is not a note');
    expect(run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| rw |' }]).warnings.join(' ')).toContain('no notes');
    expect(run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| kick:q |' }]).warnings.join(' ')).toContain('not a drum kit');
    expect(notesOf(s, song.patternId, song.channels.lead)).toHaveLength(16);
  });
});

describe('get_notation', () => {
  it('reads a part as the compact text, with the header, clef and bars', () => {
    const { s, song } = setup();
    run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: '| C5q E5q G5h | [C5 E5 G5]h rh |' }]);
    const read = runReadTool(s, 'get_notation', { channel: song.channels.lead }) as Record<string, unknown>;
    expect(read.part).toBe('Lead');
    expect(read.header).toBe('4/4 key=C-major tempo=130');
    expect(read.clefs).toEqual(['treble']);
    expect(read.text).toBe('| C5q E5q G5h | [C5 E5 G5]h rh | R | R |');
  });

  it('what it reads, write_notation writes back unchanged', () => {
    const { s, song } = setup();
    const first = runReadTool(s, 'get_notation', { channel: song.channels.lead }) as { text: string };
    run(s, [{ op: 'write_notation', pattern: 'current', channel: song.channels.lead, text: first.text }]);
    const second = runReadTool(s, 'get_notation', { channel: song.channels.lead }) as { text: string };
    expect(second.text).toBe(first.text);
    expect(notesOf(s, song.patternId, song.channels.lead).map(([tick, , key]) => [tick, key])).toEqual(
      [0, 1, 2, 3].flatMap((bar) => [0, 1, 2, 3].map((beat) => [bar * 3840 + beat * 960, 72 + beat])),
    );
  });

  it('reads drums with their names, takes a bar range and says when there is more', () => {
    const { s, song } = setup();
    const drums = runReadTool(s, 'get_notation', { channel: song.channels.kick, from_bar: 1, to_bar: 2 }) as { text: string; more?: string; part: string };
    expect(drums.part).toBe('Kick');
    expect(drums.text).toBe('| kick:q kick:q kick:q kick:q | kick:q kick:q kick:q kick:q |');
    expect(drums.more).toContain('bars 3-4');
  });

  it('answers with an error when there is nothing to write', () => {
    const s = createTestServices();
    expect(runReadTool(s, 'get_notation', {})).toHaveProperty('error');
  });
});
