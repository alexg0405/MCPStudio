/**
 * The lyrics as user actions: paste lyrics for a section (on notes, on a singer's notes, or evenly), type or retype a
 * word, move, resize, break and join lines, clear, and export as text or LRC. Each is one undo step. The lane, the Lyrics
 * window, the commands and the AI all use the same planning code in `core/lyrics`.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { lyricsToLrc, lyricsToText } from '@core/lyrics/lrc';
import { describePlan, planLyrics, type LyricAlign } from '@core/lyrics/plan';
import type { Slot } from '@core/lyrics/slots';
import type { ChannelId, ClipId, LyricId, LyricWord, Tick } from '@core/model/types';
import {
  breakLyricLine,
  clearLyrics,
  joinLyricLine,
  moveLyricWords,
  placeLyricWords,
  removeLyricWords,
  resizeLyricWord,
  retextLyricWord,
} from '@core/ops/lyrics';
import { lastLineNumber, lyricsSorted } from '@core/query/lyrics';
import { ticksPerBar } from '@core/time/ppq';
import { downloadBytes } from '@platform/fs-access';
import type { Services } from '../services';
import { channelSongSlots, clipSungSlots, pianoRollSlots } from './slots';

/** What an action did, for a toast or the AI's change line. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const barTicks = (s: Services): Tick => ticksPerBar(s.doc.getState().project.transport.timeSig);

/** What to paste and where. */
export interface PasteOptions {
  text: string;
  align: LyricAlign;
  /** Where the lyrics start (ticks). */
  fromTick: Tick;
  /** Where they end (ticks), optional. */
  toTick?: Tick;
  /** `notes`: this channel's notes as the song plays them (default: the notes selected in the piano roll, else its channel's). */
  channelId?: ChannelId;
  /** `clip`: the audio clip whose sung notes are used (default: the selected audio clip). */
  clipId?: ClipId;
  /** `even` without an end: bars one line takes (default 1). */
  barsPerLine?: number;
}

/** The slots a paste uses (and where the words start when the notes themselves say: the piano roll's selection), or a reason there are none. */
async function slotsFor(s: Services, options: PasteOptions): Promise<{ slots: Slot[]; fromTick?: Tick } | { why: string }> {
  if (options.align === 'even') return { slots: [] };
  if (options.align === 'clip') {
    const project = s.doc.getState().project;
    const selected = [...s.editor.getState().clipSelection].find((id) => project.playlist.clips[id]?.kind === 'audio');
    const clipId = options.clipId ?? selected;
    if (!clipId) return { why: 'select the audio clip with the singing first' };
    try {
      return { slots: await clipSungSlots(s, clipId) };
    } catch (error) {
      return { why: error instanceof Error ? error.message : String(error) };
    }
  }
  if (options.channelId) return { slots: channelSongSlots(s.doc.getState().project, options.channelId, options.fromTick, options.toTick) };
  const fromRoll = pianoRollSlots(s);
  if (!fromRoll) return { why: 'select the notes in the piano roll first (or pick a channel)' };
  // The notes the musician picked say where the words start, wherever the song position is.
  return { slots: fromRoll.slots, fromTick: Math.min(...fromRoll.slots.map((slot) => slot.tick)) };
}

/**
 * Pastes lyrics: splits the text into lines, words and syllables ("beau-ti-ful") and spreads them as asked, replacing the
 * lyrics under them. One undo step.
 */
export async function pasteLyrics(s: Services, options: PasteOptions): Promise<ActionResult> {
  const source = await slotsFor(s, options);
  if ('why' in source) return { ok: false, message: `No lyrics placed: ${source.why}.` };
  const project = s.doc.getState().project;
  const plan = planLyrics({
    text: options.text,
    align: options.align,
    fromTick: source.fromTick ?? options.fromTick,
    barTicks: barTicks(s),
    slots: source.slots,
    firstLine: lastLineNumber(project) + 1,
    ...(options.toTick !== undefined ? { toTick: options.toTick } : {}),
    ...(options.barsPerLine !== undefined ? { barsPerLine: options.barsPerLine } : {}),
  });
  if (plan.words.length === 0) return { ok: false, message: describePlan(plan, options.align) };
  s.history.transact('Paste lyrics', (draft) => void placeLyricWords(draft, plan.words, { replaceSpan: true }));
  return { ok: true, message: describePlan(plan, options.align) };
}

/** The line a word typed at `tick` belongs to: the one before when it ends close by, else a new line. */
function lineNumberFor(s: Services, tick: Tick): number {
  const project = s.doc.getState().project;
  const before = [...lyricsSorted(project)].reverse().find((word) => word.tick <= tick);
  const isClose = !!before && tick - (before.tick + before.length) <= barTicks(s);
  return isClose ? before.line : lastLineNumber(project) + 1;
}

/**
 * Types a word on the lane: a span of song time and its text; text with hyphens or spaces ("beau-ti-ful") becomes several
 * words sharing the span. Returns the ids placed (empty when the text has no words). One undo step.
 */
export function addLyricAt(s: Services, tick: Tick, length: Tick, text: string): LyricId[] {
  const plan = planLyrics({ text, align: 'even', fromTick: tick, toTick: tick + Math.max(1, length), barTicks: barTicks(s), firstLine: lineNumberFor(s, tick) });
  if (plan.words.length === 0) return [];
  let ids: LyricId[] = [];
  s.history.transact('Add lyric', (draft) => {
    ids = placeLyricWords(draft, plan.words);
  });
  return ids;
}

/** Retypes a word (hyphens or spaces split it into syllables sharing its span). One undo step. */
export function retypeLyric(s: Services, id: LyricId, text: string): boolean {
  return s.history.transact('Edit lyric', (draft) => retextLyricWord(draft, id, text).length > 0);
}

/** Moves words by `deltaTicks` (one undo step; a drag commits once). */
export function moveLyrics(s: Services, ids: readonly LyricId[], deltaTicks: Tick): boolean {
  return s.history.transact(ids.length > 1 ? 'Move lyrics' : 'Move lyric', (draft) => moveLyricWords(draft, ids, deltaTicks));
}

/** Sets a word's start and length (one undo step). */
export function resizeLyric(s: Services, id: LyricId, startTick: Tick, length: Tick): boolean {
  return s.history.transact('Resize lyric', (draft) => resizeLyricWord(draft, id, startTick, length));
}

/** Deletes words (one undo step). */
export function deleteLyrics(s: Services, ids: readonly LyricId[]): boolean {
  return s.history.transact(ids.length > 1 ? 'Delete lyrics' : 'Delete lyric', (draft) => removeLyricWords(draft, ids));
}

/** Starts a new line at a word. */
export function startLineAt(s: Services, id: LyricId): boolean {
  return s.history.transact('Start a new lyric line', (draft) => void breakLyricLine(draft, id));
}

/** Joins a word's line to the one before it. */
export function joinLineAt(s: Services, id: LyricId): boolean {
  return s.history.transact('Join lyric lines', (draft) => void joinLyricLine(draft, id));
}

/** Clears the lyrics, or the bars `fromBar`–`toBar` (1-based, inclusive) of them. */
export function clearLyricTrack(s: Services, fromBar?: number, toBar?: number): ActionResult {
  const bar = barTicks(s);
  const from = fromBar !== undefined ? Math.max(0, Math.round(fromBar - 1) * bar) : undefined;
  const to = fromBar !== undefined ? Math.round(toBar ?? fromBar) * bar : undefined;
  let removed = 0;
  const changed = s.history.transact('Clear lyrics', (draft) => {
    removed = clearLyrics(draft, from, to);
  });
  if (!changed) return { ok: false, message: 'There are no lyrics there.' };
  return { ok: true, message: `Cleared ${removed} lyric word${removed === 1 ? '' : 's'}.` };
}

/** What can be exported. */
export type LyricsExportKind = 'text' | 'lrc' | 'lrc-words';

/** The lyrics as a file's text and name (the project's title), or null when there are none. */
export function lyricsExport(s: Services, kind: LyricsExportKind): { text: string; name: string } | null {
  const project = s.doc.getState().project;
  const words: readonly LyricWord[] = lyricsSorted(project);
  if (words.length === 0) return null;
  const title = project.meta.title || 'Lyrics';
  if (kind === 'text') return { text: `${lyricsToText(words)}\n`, name: `${title}.txt` };
  const text = lyricsToLrc(words, tempoMapOf(project, 'song'), { title, perWord: kind === 'lrc-words' });
  return { text: `${text}\n`, name: `${title}.lrc` };
}

/** Saves the lyrics as a text or LRC file (a download). */
export function saveLyricsFile(s: Services, kind: LyricsExportKind): ActionResult {
  const out = lyricsExport(s, kind);
  if (!out) return { ok: false, message: 'There are no lyrics to export: add some on the lyrics lane first.' };
  const safeName = out.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
  downloadBytes(safeName, new TextEncoder().encode(out.text), 'text/plain;charset=utf-8');
  return { ok: true, message: `Saved ${safeName}.` };
}

/** Puts the lyrics as text on the clipboard. */
export async function copyLyrics(s: Services): Promise<ActionResult> {
  const out = lyricsExport(s, 'text');
  if (!out) return { ok: false, message: 'There are no lyrics to copy.' };
  try {
    await navigator.clipboard.writeText(out.text.trimEnd());
    return { ok: true, message: 'Copied the lyrics.' };
  } catch {
    return { ok: false, message: 'The browser would not let the lyrics be copied.' };
  }
}
