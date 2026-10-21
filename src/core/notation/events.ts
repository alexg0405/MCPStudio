/**
 * The notes and rests of a score as one flat list in time order: what the keyboard cursor steps through, what the follow
 * highlight looks up by time, and what a screen reader is told about ("bar 3, beat 2, C sharp 5, quarter note").
 */
import type { NoteId, Tick, TimeSignature } from '../model/types';
import { restName, valueName } from './durations';
import { spokenDrumName } from './drums';
import { spellingName } from './spelling';
import type { ChordItem, Item, Measure, Score } from './types';
import { ticksPerBeat } from '../time/ppq';

/** One note, chord or rest of the score. */
export interface ScoreEvent {
  /** Where it starts in the pattern, in ticks. */
  tick: Tick;
  /** How long it sounds (this piece, when a note is tied over several symbols). */
  ticks: Tick;
  measure: Measure;
  staff: number;
  voice: 1 | 2;
  item: Item;
  /** The notes drawn here (empty for a rest), lowest first. */
  noteIds: NoteId[];
  /** A symbol that continues a tied note (it is skipped by the cursor but still lights while it plays). */
  isContinuation: boolean;
}

/** Every item of the score in time order (staff 0 before staff 1, voice 1 before voice 2 when they start together). */
export function scoreEvents(score: Score): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  for (const measure of score.measures) {
    measure.staves.forEach((staff, staffIndex) => {
      for (const voice of staff.voices) {
        for (const item of voice.items) {
          const isChord = item.kind === 'chord';
          events.push({
            tick: measure.startTick + item.tick,
            ticks: item.ticks,
            measure,
            staff: staffIndex,
            voice: voice.number,
            item,
            noteIds: isChord ? item.heads.map((head) => head.noteId) : [],
            isContinuation: isChord && item.heads.every((head) => head.tiedFromPrevious),
          });
        }
      }
    });
  }
  return events.sort((a, b) => a.tick - b.tick || a.staff - b.staff || a.voice - b.voice);
}

/**
 * The events a cursor visits: the notes and chords, but not the continuation of a tied note and not the rests (a rest is
 * a gap: the cursor says "nothing here" there, and a typed note fills it).
 */
export function cursorStops(events: readonly ScoreEvent[]): ScoreEvent[] {
  return events.filter((event) => !event.isContinuation && event.item.kind === 'chord');
}

/** "beat 2", "beat 2 and" (half a beat later), "beat 2 plus 3 steps". Beats count from 1. */
export function beatText(tickInBar: Tick, timeSig: TimeSignature): string {
  const unit = ticksPerBeat(timeSig);
  const beat = Math.floor(tickInBar / unit);
  const rest = tickInBar - beat * unit;
  const base = `beat ${beat + 1}`;
  if (rest === 0) return base;
  if (rest * 2 === unit) return `${base} and`;
  const step = unit / 4;
  if (rest % step === 0) return `${base} plus ${rest / step} ${rest / step === 1 ? 'step' : 'steps'}`;
  return `${base} plus ${Math.round(rest)} ticks`;
}

function headNames(chord: ChordItem, isPercussion: boolean): string {
  const names = chord.heads.map((head) => (isPercussion ? spokenDrumName(head.key) : spellingName(head.spelling, { spoken: true })));
  if (names.length === 1) return names[0] as string;
  const last = names[names.length - 1] as string;
  return `${isPercussion ? '' : 'chord '}${names.slice(0, -1).join(', ')} and ${last}`;
}

/** What a screen reader says about an event: "bar 3, beat 2, C sharp 5, quarter note, tied to the next". */
export function describeEvent(score: Score, event: ScoreEvent): string {
  const place = `bar ${event.measure.index + 1}, ${beatText(event.item.tick, score.timeSig)}`;
  const item = event.item;
  if (item.kind === 'rest') return `${place}, ${item.isWholeBar ? 'whole bar rest' : restName(item.value)}`;
  const parts = [place, headNames(item, score.isPercussion), valueName(item.value)];
  if (item.tuplet) parts.push('triplet');
  if (item.heads.some((head) => head.tiesToNext)) parts.push('tied to the next');
  if (item.lyric) parts.push(`word ${item.lyric.text}`);
  return parts.join(', ');
}

/** One sentence per bar for the hidden text version of the score: "Bar 2: beat 1 C5 quarter note; beat 2 rest". */
export function describeBar(score: Score, barIndex: number): string {
  const measure = score.measures[barIndex];
  if (!measure) return '';
  const spoken: string[] = [];
  for (const staff of measure.staves) {
    for (const voice of staff.voices) {
      for (const item of voice.items) {
        if (item.kind === 'chord' && item.heads.every((head) => head.tiedFromPrevious)) continue;
        const what = item.kind === 'rest' ? (item.isWholeBar ? 'whole bar rest' : restName(item.value)) : `${headNames(item, score.isPercussion)} ${valueName(item.value)}`;
        spoken.push(`${beatText(item.tick, score.timeSig)} ${what}`);
      }
    }
  }
  return `Bar ${barIndex + 1}: ${spoken.join('; ')}.`;
}
