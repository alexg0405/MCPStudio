import type { PatternId, Tick } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';

// "Play this" actions behind the editors' ▶ buttons and menus. Each sets the transport view first
// (which pattern or which span) and then starts playing, so the toolbar's own play button is not needed.

/** True while `patternId` (default: the current pattern) is the one looping in pattern mode. */
export function isPatternPlaying(s: Services, patternId: PatternId | null = s.view.getState().currentPatternId): boolean {
  const v = s.view.getState();
  return !!patternId && s.engine.playing && v.mode === 'pattern' && v.currentPatternId === patternId;
}

/** A pattern by id, name or number (1 = the first); undefined when nothing matches. */
export function findPattern(s: Services, ref: unknown): PatternId | undefined {
  const p = s.doc.getState().project;
  if (typeof ref === 'number') return p.patternOrder[Math.round(ref) - 1];
  if (typeof ref !== 'string' || !ref.trim()) return undefined;
  const text = ref.trim();
  if (p.patterns[text as PatternId]) return text as PatternId;
  const lower = text.toLowerCase();
  return p.patternOrder.find((id) => p.patterns[id]?.name.toLowerCase() === lower);
}

/**
 * Plays a pattern (default: the current one) on a loop from its start, in pattern mode: it becomes the
 * current pattern first. False when there is no such pattern.
 */
export function playPattern(s: Services, patternId: PatternId | null = s.view.getState().currentPatternId): boolean {
  if (!patternId || !s.doc.getState().project.patterns[patternId]) return false;
  const v = s.view.getState();
  v.setCurrentPattern(patternId);
  v.setMode('pattern');
  s.engine.play(0);
  return true;
}

/**
 * Plays the song from `tick` (song mode). A loop region that does not contain the start is cleared,
 * since playback would jump to its start instead.
 */
export function playFrom(s: Services, tick: Tick): void {
  const v = s.view.getState();
  const from = Math.max(0, Math.round(tick));
  if (v.loop && (from < v.loop.start || from >= v.loop.end)) v.setLoop(null);
  v.setSongStart(from);
  v.setMode('song');
  s.engine.play(from);
}

/** Loops the span `from`..`to` in song mode and plays it from its start. False for an empty span. */
export function playRange(s: Services, from: Tick, to: Tick): boolean {
  const start = Math.max(0, Math.round(from));
  const end = Math.round(to);
  if (!(end > start)) return false;
  const v = s.view.getState();
  v.setLoop({ start, end });
  v.setSongStart(start);
  v.setMode('song');
  s.engine.play(start);
  return true;
}

/** Bars (1 = the first, both ends included) as ticks. */
export function barsToRange(s: Services, fromBar: number, toBar: number): { from: Tick; to: Tick } {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const a = Math.max(1, Math.round(fromBar));
  const b = Math.max(a, Math.round(toBar));
  return { from: (a - 1) * bar, to: b * bar };
}
