/**
 * Slots: the places in song time that syllables are sung on, taken from notes. Notes that start together (a chord, a
 * doubled melody) are one slot, and a slot never runs into the next one (words do not overlap on the lyrics lane).
 */
import { tickAtSourceSeconds, type PlaybackMode } from '../audio/playback';
import type { AudioClip, Tick } from '../model/types';
import type { TempoMap } from '../time/ppq';

/** A place for one syllable. */
export interface Slot {
  tick: Tick;
  length: Tick;
}

/** A note as `slotsFromNotes` needs it: where it starts, how long it is and its key (the highest of a chord is kept). */
export interface SlotNote {
  tick: Tick;
  length: Tick;
  key: number;
}

/** A note a singer sang, as the pitch analysis finds it: seconds into the clip's sample and a (fractional) MIDI pitch. */
export interface SungNote {
  from: number;
  to: number;
  pitch: number;
}

/**
 * Slots from the notes sung in an audio clip: each note's seconds are turned into song ticks through the clip's place and
 * playback mode (`tickAtSourceSeconds`), and only what the clip plays is kept (a note cut by the clip's edge is cut to it).
 */
export function slotsFromSungNotes(
  clip: Pick<AudioClip, 'start' | 'length' | 'offsetSec'>,
  mode: PlaybackMode,
  tempo: TempoMap,
  notes: readonly SungNote[],
): Slot[] {
  const clipEnd = clip.start + clip.length;
  const inClip: SlotNote[] = [];
  for (const note of notes) {
    const from = Math.max(clip.start, Math.round(tickAtSourceSeconds(clip, mode, tempo, note.from)));
    const to = Math.min(clipEnd, Math.round(tickAtSourceSeconds(clip, mode, tempo, note.to)));
    if (to > from) inClip.push({ tick: from, length: to - from, key: Math.round(note.pitch) });
  }
  return slotsFromNotes(inClip);
}

/** Notes starting within this many ticks of each other count as one (a 1/64 note: a strum or a loose chord). */
export const SAME_START_TICKS = 60;

/** Groups notes in time order: each group starts within SAME_START_TICKS of its first note. */
function groupByStart(notes: readonly SlotNote[]): SlotNote[][] {
  const sorted = notes.filter((note) => note.length > 0).sort((a, b) => a.tick - b.tick || b.key - a.key);
  const groups: SlotNote[][] = [];
  for (const note of sorted) {
    const group = groups[groups.length - 1];
    if (group && note.tick - (group[0] as SlotNote).tick <= SAME_START_TICKS) group.push(note);
    else groups.push([note]);
  }
  return groups;
}

/** Slots from notes: in time order, one per start (a chord's highest note sets the end), each cut to end where the next begins. */
export function slotsFromNotes(notes: readonly SlotNote[]): Slot[] {
  const slots: Slot[] = groupByStart(notes).map((group) => {
    const first = group[0] as SlotNote;
    const top = group.reduce((best, note) => (note.key > best.key ? note : best), first);
    return { tick: first.tick, length: Math.max(1, top.tick + top.length - first.tick) };
  });
  for (let i = 0; i + 1 < slots.length; i++) {
    const slot = slots[i] as Slot;
    slot.length = Math.max(1, Math.min(slot.length, (slots[i + 1] as Slot).tick - slot.tick));
  }
  return slots;
}
