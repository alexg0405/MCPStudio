/**
 * The words of the lyrics lane written under the notes they are sung on. A word belongs to the note that starts where it
 * does (a little early is fine: dragged words are rarely exact); of notes that start together the highest is the melody and
 * carries it. Words with no note under them are not drawn here (the lane shows them). Matching is pure (tested in Node);
 * the drawing is one pass of text on the notes layer, done only when that layer is stale.
 */
import { wordLabel } from '@core/lyrics/lines';
import type { Note, Tick } from '@core/model/types';
import type { PatternLyric } from '@core/query/lyrics';
import { alpha, type TimelineTheme } from '../../timeline/canvas';
import type { Viewport } from '../../timeline/viewport';
import { rowForKey } from './render';

/** How early (ticks, a 1/32 note) a note may start and still carry a word. */
export const MATCH_EARLY_TICKS = 120;

/** A word and the note it is sung on. */
export interface LyricLabel {
  note: Note;
  text: string;
}

/** The first index of `notes` (sorted by start) whose start is at or after `tick`. */
function firstNoteFrom(notes: readonly Note[], tick: Tick): number {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((notes[middle] as Note).tick < tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Pairs words (in time order) with notes (sorted by start): each word takes the note starting in its span, each note one word. */
export function lyricLabelsFor(notes: readonly Note[], words: readonly PatternLyric[]): LyricLabel[] {
  const labels: LyricLabel[] = [];
  const taken = new Set<string>();
  for (const entry of words) {
    const from = entry.tick - MATCH_EARLY_TICKS;
    const to = entry.tick + entry.length;
    let best: Note | null = null;
    for (let i = firstNoteFrom(notes, from); i < notes.length; i++) {
      const note = notes[i] as Note;
      if (note.tick >= to) break;
      if (taken.has(note.id)) continue;
      // The earliest start wins; of notes starting together, the highest (a chord's melody note).
      if (!best || note.tick < best.tick || (note.tick === best.tick && note.key > best.key)) best = note;
    }
    if (!best) continue;
    taken.add(best.id);
    labels.push({ note: best, text: wordLabel(entry.word) });
  }
  return labels;
}

/** The text size (px) of a lyric under a note, and the room (px) it needs under the row. */
const LABEL_SIZE = 11;

/** Writes each word under its note (clipped to the room before the next label), when the rows are tall enough to leave a line. */
export function drawLyricLabels(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, labels: readonly LyricLabel[]): void {
  if (labels.length === 0) return;
  const [firstTick, lastTick] = vp.visibleTicks();
  ctx.save();
  ctx.font = `600 ${LABEL_SIZE}px ${theme.font}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = alpha(theme.text, 0.9);
  for (let i = 0; i < labels.length; i++) {
    const { note, text } = labels[i] as LyricLabel;
    if (note.tick > lastTick) break;
    if (note.tick + note.length < firstTick) continue;
    const next = labels[i + 1];
    const x = vp.tickToPx(note.tick);
    const room = next ? vp.tickToPx(next.note.tick) - x - 2 : 160;
    if (room < 6) continue;
    const y = vp.rowToY(rowForKey(note.key)) + vp.rowHeight;
    ctx.fillText(text, x + 1, y + 1, Math.min(room, 160));
  }
  ctx.restore();
}
