/** Questions the editor asks about what it is editing: the notes, the snap grid, how far the view scrolls, the song key. */
import { chordPitchClasses, formatChord } from '@core/harmony/chord';
import type { Note, NoteId, Tick } from '@core/model/types';
import { patternChords, projectUsesFlats } from '@core/query/chords';
import { notesSorted, patternLength } from '@core/query/queries';
import { ticksPerBar } from '@core/time/ppq';
import { gridTicks } from '@core/time/snap';
import { scaleMask } from '@agstudio/sdk/notes';
import type { ChordBand, ScaleRows } from '../render';
import type { EditTarget, PianoRollContext } from './context';

/** The view scrolls on past the pattern's last note by this many bars, so there is room to add more. */
const EXTRA_BARS_PAST_LAST_NOTE = 8;

/** The notes of the selected instrument channel in the current pattern, with the project and the song key. */
export function editTarget(ctx: PianoRollContext): EditTarget {
  const project = ctx.s.doc.getState().project;
  const channelId = ctx.s.session.getState().selectedChannelId;
  const patternId = ctx.s.view.getState().currentPatternId;
  const pattern = patternId ? project.patterns[patternId] : undefined;
  const channel = channelId ? project.channels[channelId] : undefined;
  const instrument = channel?.kind === 'instrument' ? channel : null;
  return {
    project,
    channelId: instrument ? channelId : null,
    patternId: pattern ? patternId : null,
    pattern,
    rootKey: instrument?.rootKey ?? null,
    notes: instrument && pattern ? notesSorted(pattern.notes[instrument.id]) : [],
    songKey: project.transport.key ?? null,
  };
}

/** The snap grid in ticks, from the toolbar's setting and the zoom. */
export function gridTicksOf(ctx: PianoRollContext, target: EditTarget): Tick {
  const settings = ctx.s.editor.getState().pianoRoll;
  return gridTicks(settings.snap, target.project.transport.timeSig, ctx.vp.pxPerTick);
}

/** The snap in ticks for a pointer event: Alt bypasses snapping (1 tick), like FL. */
export function snapTicksFor(ctx: PianoRollContext, target: EditTarget, event: { altKey: boolean }): Tick {
  return event.altKey ? 1 : gridTicksOf(ctx, target);
}

/** Where the pattern ends (ticks); one bar when there is no pattern. */
export function patternEnd(target: EditTarget): Tick {
  const timeSig = target.project.transport.timeSig;
  return target.pattern ? patternLength(target.pattern, timeSig) : ticksPerBar(timeSig);
}

/**
 * The length of the scrollable area (ticks): the pattern or its last note, whichever ends later, then some bars of room.
 * Remembered for the notes array it was computed from, because this runs every frame while the view follows.
 */
export function maxScrollTick(ctx: PianoRollContext, target: EditTarget): Tick {
  const bar = ticksPerBar(target.project.transport.timeSig);
  const end = patternEnd(target);
  const memo = ctx.state.maxTickMemo;
  if (memo.notes === target.notes && memo.end === end && memo.bar === bar) return memo.result;
  let lastEnd = end;
  // Indexed: a for-of iterator per note is garbage, and this walks every note.
  for (let i = 0; i < target.notes.length; i++) {
    const note = target.notes[i] as Note;
    lastEnd = Math.max(lastEnd, note.tick + note.length);
  }
  memo.notes = target.notes;
  memo.end = end;
  memo.bar = bar;
  memo.result = lastEnd + bar * EXTRA_BARS_PAST_LAST_NOTE;
  return memo.result;
}

/** The selected notes. */
export function selectedNoteIds(ctx: PianoRollContext): ReadonlySet<NoteId> {
  return new Set(ctx.s.editor.getState().noteSelection);
}

/** The song key's rows for drawing (kept for the key object they came from); null when highlighting is off. */
export function scaleRowsOf(ctx: PianoRollContext, target: EditTarget): ScaleRows | null {
  if (!ctx.s.editor.getState().pianoRoll.scaleHighlight) return null;
  const { state } = ctx;
  if (state.scaleCache.key !== target.songKey) {
    const key = target.songKey;
    state.scaleCache = { key, rows: key ? { mask: scaleMask(key.root, key.scale), root: key.root } : null };
  }
  return state.scaleCache.rows;
}

/** The chord track as this pattern plays it, for the tint behind the notes; null when it is off or there are no chords. */
export function chordBandsOf(ctx: PianoRollContext, target: EditTarget): ChordBand[] | null {
  const wanted = ctx.s.editor.getState().pianoRoll.chordHighlight;
  if (!wanted || !target.patternId || !target.project.chords) return null;
  const usesFlats = projectUsesFlats(target.project);
  return patternChords(target.project, target.patternId).map((entry) => {
    const mask: boolean[] = new Array<boolean>(12).fill(false);
    for (const pitchClass of chordPitchClasses(entry.chord)) mask[pitchClass] = true;
    return { tick: entry.tick, length: entry.length, mask, root: entry.chord.root, name: formatChord(entry.chord, usesFlats) };
  });
}
