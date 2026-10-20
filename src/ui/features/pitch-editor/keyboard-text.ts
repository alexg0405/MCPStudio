/**
 * What a screen reader says about the Pitch editor's notes: a pitch with its cents, a time on the recording, a whole note
 * with its place, length, retuning and lyric word. Pure text, so it is unit-tested.
 */
import { joinParts, plural, spokenKeyName } from '../../timeline/key-cursor/describe';
import type { DrawNote } from './model';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** A pitch less than this many cents from a note counts as that note, with nothing said about cents. */
const IN_TUNE_CENTS = 1;

/** A time on the recording: "3.2 seconds", "1 minute 5.0 seconds". */
export function spokenTime(ms: number): string {
  const seconds = Math.max(0, ms) / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds.toFixed(1)} seconds`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${plural(minutes, 'minute')} ${(seconds - minutes * SECONDS_PER_MINUTE).toFixed(1)} seconds`;
}

/** A pitch (MIDI, fractional): "C sharp 5", or "C sharp 5 plus 23 cents" when it is off the note. */
export function spokenPitch(midi: number): string {
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = spokenKeyName(nearest);
  if (Math.abs(cents) < IN_TUNE_CENTS) return name;
  return `${name} ${cents > 0 ? 'plus' : 'minus'} ${plural(Math.abs(cents), 'cent')}`;
}

/** A note of the list as a sentence: its number, pitch, place and length, what was changed, its word, and whether it is selected. */
export function noteSentence(note: DrawNote, count: number, options: { word?: string; isSelected: boolean }): string {
  return joinParts([
    `Note ${note.index + 1} of ${count}`,
    spokenPitch(note.target),
    `at ${spokenTime(note.fromMs)}`,
    `${((note.toMs - note.fromMs) / MS_PER_SECOND).toFixed(1)} seconds long`,
    note.edited && Math.abs(note.target - note.sung) > IN_TUNE_CENTS / 100 && `retuned from ${spokenPitch(note.sung)}`,
    options.word && `word ${options.word}`,
    options.isSelected && 'selected',
  ]);
}
