import { makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { addPattern } from '@core/ops/playlist';
import { PPQ, ticksPerBar } from '@core/time/ppq';
import type { LiveEvent, LiveInput } from './live-input';
import type { Services } from './services';

/**
 * FL's score log: everything played on a keyboard (MIDI, the typing piano, the on-screen piano) in
 * the last five minutes is kept, recording or not, so a good idea played while just noodling can be
 * dumped into a pattern afterwards. Times are AudioContext seconds (the live input's clock).
 */
export interface LoggedNote {
  /** The channel it played (null: none was selected). */
  channelId: ChannelId | null;
  key: number;
  velocity: number;
  release: number;
  on: number;
  /** null while the key is still held. */
  off: number | null;
}

export const LOG_SECONDS = 300;
/** A pause this long (seconds without a new note) ends a phrase. */
export const PHRASE_GAP = 4;

export class ScoreLog {
  private notes: LoggedNote[] = [];
  private readonly open = new Map<number, LoggedNote>();
  private readonly listeners = new Set<() => void>();

  constructor(live: LiveInput) {
    live.subscribe((e) => this.hear(e));
  }

  /** What is in the log (oldest first). */
  all(): readonly LoggedNote[] {
    return this.notes;
  }

  clear(): void {
    this.notes = [];
    this.open.clear();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private hear(e: LiveEvent): void {
    if (e.type === 'noteOn') {
      const n: LoggedNote = { channelId: e.channelId, key: e.key, velocity: e.velocity, release: 0.5, on: e.time, off: null };
      this.open.set(e.id, n);
      this.notes.push(n);
      // Keep five minutes.
      const cut = e.time - LOG_SECONDS;
      if (this.notes.length > 0 && (this.notes[0] as LoggedNote).on < cut) this.notes = this.notes.filter((x) => x.on >= cut);
      this.emit();
    } else if (e.type === 'noteOff') {
      const n = this.open.get(e.id);
      if (!n) return;
      this.open.delete(e.id);
      n.off = e.time;
      n.release = e.release;
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** The last phrase: the newest notes back to the last pause of PHRASE_GAP seconds or more. */
export function lastPhrase(notes: readonly LoggedNote[], gap = PHRASE_GAP): LoggedNote[] {
  if (notes.length === 0) return [];
  let i = notes.length - 1;
  // A pause is measured from where the earlier notes stopped sounding, not where they started.
  let earliest = (notes[i] as LoggedNote).on;
  while (i > 0) {
    const prev = notes[i - 1] as LoggedNote;
    const end = prev.off ?? prev.on;
    if (earliest - Math.max(prev.on, end) >= gap) break;
    earliest = Math.min(earliest, prev.on);
    i--;
  }
  return notes.slice(i);
}

export interface DumpOptions {
  /** The last phrase, or everything in the log (five minutes). */
  span: 'phrase' | 'all';
  /** Ticks to snap note starts to (0 = as played). */
  quantize: number;
  /** A new pattern, or the current one (from its start). */
  into: 'new' | 'current';
}

/**
 * The notes to write, per channel, with the first one at tick 0 (or its bar position, snapped),
 * at the song's tempo. Notes played with no channel selected go to `fallback`.
 */
export function planDump(
  logged: readonly LoggedNote[],
  bpm: number,
  quantize: number,
  fallback: ChannelId | null,
  now: number,
): Map<ChannelId, Omit<Note, 'id'>[]> {
  const out = new Map<ChannelId, Omit<Note, 'id'>[]>();
  if (logged.length === 0) return out;
  const t0 = Math.min(...logged.map((n) => n.on));
  const ticksPerSecond = (bpm / 60) * PPQ;
  for (const n of logged) {
    const channel = n.channelId ?? fallback;
    if (!channel) continue;
    let tick = Math.round((n.on - t0) * ticksPerSecond);
    const end = Math.round(((n.off ?? now) - t0) * ticksPerSecond);
    if (quantize > 0) tick = Math.round(tick / quantize) * quantize;
    const length = Math.max(quantize > 0 ? Math.min(quantize, 60) : 30, end - tick);
    const list = out.get(channel) ?? [];
    list.push({ tick: Math.max(0, tick), length, key: n.key, velocity: n.velocity, release: n.release });
    out.set(channel, list);
  }
  return out;
}

/** Writes the score log into a pattern (one undo step). The count of notes, or why it can't. */
export function dumpScoreLog(s: Services, opts: DumpOptions): { notes: number; bars: number; patternId: PatternId } | { error: string } {
  const all = s.scoreLog.all();
  const picked = opts.span === 'phrase' ? lastPhrase(all) : [...all];
  if (picked.length === 0)
    return { error: 'Nothing played yet: play something on your keyboard (MIDI or the typing piano), then dump it.' };
  const project = s.doc.getState().project;
  const now = Math.max(...picked.map((n) => n.off ?? n.on));
  const plan = planDump(picked, project.transport.bpm, opts.quantize, s.session.getState().selectedChannelId, now);
  if (plan.size === 0) return { error: 'Select a channel first: the notes were played with none selected.' };
  const current = s.view.getState().currentPatternId;
  const patternId = opts.into === 'current' && current && project.patterns[current] ? current : newId.pattern();
  const fresh = patternId !== current || !project.patterns[patternId];
  let count = 0;
  let end = 0;
  s.history.transact('Dump what I played', (d) => {
    if (fresh) {
      const index = current ? d.patternOrder.indexOf(current) + 1 : d.patternOrder.length;
      addPattern(d, makePattern(`Played ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, paletteColor(d.patternOrder.length), patternId), index);
    }
    for (const [channel, notes] of plan) {
      if (!d.channels[channel]) continue;
      addNotes(d, patternId, channel, notes.map((n) => ({ ...n, id: newId.note() })));
      count += notes.length;
      for (const n of notes) end = Math.max(end, n.tick + n.length);
    }
  });
  s.view.getState().setCurrentPattern(patternId);
  return { notes: count, bars: Math.max(1, Math.ceil(end / ticksPerBar(project.transport.timeSig))), patternId };
}
