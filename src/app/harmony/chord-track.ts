/**
 * The chord track as user actions: type a progression, apply one from the palette, edit one chord, clear it. Each action is
 * one undo step. The UI, the action search and the AI's `chords` action all use the same planning code in `core/harmony`.
 */
import { parseChordLine, formatChord, type ChordSymbol } from '@core/harmony/chord';
import { harmonyKey, keyForMode } from '@core/harmony/key';
import { layoutProgression, lookupProgression, suggestNext, type NextChord, type Progression } from '@core/harmony/progressions';
import type { KeyLike } from '@core/harmony/scale';
import type { ChordEvent, ChordId, Tick } from '@core/model/types';
import { clearChords, editChord, placeChords, removeChord, resizeChord, setChord, splitChord, symbolOf, type ChordSpan } from '@core/ops/chords';
import { chordAt, chordTrackEnd, chordsSorted, projectUsesFlats } from '@core/query/chords';
import { ticksPerBar } from '@core/time/ppq';
import { rolesOf } from '../arrange/env';
import type { Services } from '../services';
import { songPosition } from '../actions/markers';

/** What an action did, for a toast or the AI's change line. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const barTicks = (s: Services): Tick => ticksPerBar(s.doc.getState().project.transport.timeSig);

/** The 1-based bar a tick falls in. */
export const barOfTick = (s: Services, tick: Tick): number => Math.floor(tick / barTicks(s)) + 1;

/** The key harmony works in (the song key, else what the notes say, else a default). */
export function currentHarmonyKey(s: Services, fallbackMode: 'major' | 'minor' = 'minor') {
  const project = s.doc.getState().project;
  return harmonyKey(project, rolesOf(project), fallbackMode);
}

/**
 * Types a progression: "Am7 | F | C | G" puts one chord a bar from `startBar` (1-based); a "." or "-" lets the chord before
 * hold another bar, and `barsPerChord` stretches each chord. Chords already there are replaced.
 */
export function typeChords(s: Services, text: string, options: { startBar?: number; barsPerChord?: number } = {}): ActionResult {
  const { chords, bad } = parseChordLine(text);
  if (bad.length) return { ok: false, message: `Not chords: ${bad.join(', ')}. Try names like Am7, F, C/E, Gsus4.` };
  const spans = chordLineSpans(chords, barTicks(s), Math.max(0, ((options.startBar ?? 1) - 1) * barTicks(s)), options.barsPerChord ?? 1);
  if (spans.length === 0) return { ok: false, message: 'Type some chords, for example Am7 | F | C | G.' };
  s.history.transact('Type chords', (draft) => {
    placeChords(draft, spans);
  });
  return { ok: true, message: `Put ${spans.length} chord${spans.length === 1 ? '' : 's'} on the chord track.` };
}

/** Lays chords (null = the one before holds) out one slot after another. */
export function chordLineSpans(chords: readonly (ChordSymbol | null)[], bar: Tick, startTick: Tick, barsPerChord: number): ChordSpan[] {
  const spans: ChordSpan[] = [];
  const slot = Math.max(1, Math.round(bar * barsPerChord));
  chords.forEach((chord, index) => {
    const tick = startTick + index * slot;
    const previous = spans[spans.length - 1];
    if (chord) spans.push({ tick, length: slot, chord });
    else if (previous) previous.length += slot;
  });
  return spans;
}

/** Options for putting a palette progression on the chord track. */
export interface ApplyProgressionOptions {
  /** 1-based bar to start at (default: the song position). */
  startBar?: number;
  /** Bars to fill; the progression repeats (default: one pass). */
  bars?: number;
  sevenths?: boolean;
}

/** Puts a palette progression on the chord track in the song key (or the key its notes suggest). */
export function applyProgression(s: Services, progression: Progression, options: ApplyProgressionOptions = {}): ActionResult {
  const project = s.doc.getState().project;
  const bar = barTicks(s);
  const key: KeyLike = keyForMode(currentHarmonyKey(s, progression.mode), progression.mode);
  const startTick = options.startBar !== undefined ? Math.max(0, (options.startBar - 1) * bar) : Math.floor(songPosition(s) / bar) * bar;
  const built = layoutProgression(progression, key, {
    startTick,
    bar,
    ...(options.bars !== undefined ? { bars: options.bars } : {}),
    ...(options.sevenths ? { sevenths: true } : {}),
  });
  if (built.length === 0) return { ok: false, message: 'That progression has no chords.' };
  const end = built[built.length - 1] as { tick: Tick; length: Tick };
  s.history.transact(`Chords: ${progression.name}`, (draft) => {
    clearChords(draft, startTick, end.tick + end.length);
    placeChords(draft, built.map((entry) => ({ tick: entry.tick, length: entry.length, chord: entry.chord })));
  });
  const flats = projectUsesFlats(project);
  const names = built.slice(0, 8).map((entry) => formatChord(entry.chord, flats)).join(' | ');
  return { ok: true, message: `${progression.name} from bar ${barOfTick(s, startTick)}: ${names}${built.length > 8 ? ' …' : ''}` };
}

/** Looks a progression up by id or name, then applies it. */
export function applyProgressionByName(s: Services, ref: string, options: ApplyProgressionOptions = {}): ActionResult {
  const progression = lookupProgression(ref);
  if (!progression) return { ok: false, message: `There is no progression called "${ref}" in the palette.` };
  return applyProgression(s, progression, options);
}

/** Clears the whole chord track, or the bars from `fromBar` to `toBar` (1-based, inclusive). */
export function clearChordTrack(s: Services, fromBar?: number, toBar?: number): ActionResult {
  if (!s.doc.getState().project.chords) return { ok: false, message: 'The chord track is already empty.' };
  // The lane was showing because of the chords: keep it, so the first new chord can be typed straight into it.
  if (s.editor.getState().chordLane === null) s.editor.getState().setChordLane(true);
  const bar = barTicks(s);
  const from = fromBar !== undefined ? (fromBar - 1) * bar : undefined;
  const to = toBar !== undefined ? toBar * bar : undefined;
  let removed = 0;
  s.history.transact('Clear chords', (draft) => {
    removed = clearChords(draft, from, to);
  });
  return { ok: true, message: `Removed ${removed} chord${removed === 1 ? '' : 's'}.` };
}

/** Changes one chord's symbol by text ("Dm7"); false when the text is not a chord or the chord is gone. */
export function renameChord(s: Services, id: ChordId, text: string): boolean {
  const parsed = parseChordLine(text).chords[0];
  if (!parsed || !s.doc.getState().project.chords?.[id]) return false;
  s.history.transact('Edit chord', (draft) => editChord(draft, id, parsed));
  return true;
}

/** Puts a chord at a tick with a length (typed in the lane); one undo step. */
export function addChordAt(s: Services, startTick: Tick, length: Tick, chord: ChordSymbol): ChordId {
  let id = '' as ChordId;
  s.history.transact('Add chord', (draft) => {
    id = setChord(draft, startTick, length, chord);
  });
  return id;
}

export function deleteChord(s: Services, id: ChordId): void {
  s.history.transact('Delete chord', (draft) => removeChord(draft, id));
}

/** Cuts a chord in two at a tick. */
export function splitChordAt(s: Services, id: ChordId, tick: Tick): void {
  s.history.transact('Split chord', (draft) => void splitChord(draft, id, tick));
}

/** Gives a chord new edges in one step (the lane's drag commits through a gesture; this is for commands). */
export function resizeChordTo(s: Services, id: ChordId, startTick: Tick, length: Tick): void {
  s.history.transact('Resize chord', (draft) => resizeChord(draft, id, startTick, length));
}

/** The chord a command means: the one under the song position, else the first. */
export function chordAtSongPosition(s: Services): ChordEvent | null {
  const project = s.doc.getState().project;
  return chordAt(project, songPosition(s)) ?? chordsSorted(project)[0] ?? null;
}

/**
 * Chords that could come after the chord at `tick` (or the last chord before it), ranked by function in the song key.
 * With no chord before, it suggests ways to open.
 */
export function nextChordSuggestions(s: Services, tick: Tick, sevenths = false): NextChord[] {
  const project = s.doc.getState().project;
  const list = chordsSorted(project);
  const before = list.filter((event) => event.tick < tick);
  const last = before[before.length - 1];
  const beforeThat = before[before.length - 2];
  const key = currentHarmonyKey(s);
  return suggestNext(key, last ? symbolOf(last) : null, { sevenths, before: beforeThat ? symbolOf(beforeThat) : null });
}

/** Where the chord track ends, in the 1-based bar after its last chord (where a new progression would continue). */
export function nextFreeBar(s: Services): number {
  const end = chordTrackEnd(s.doc.getState().project);
  return Math.ceil(end / barTicks(s)) + 1;
}
