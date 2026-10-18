/** Which part of the song leveling listens to: the busiest section (or the asked-for bars), short enough to render quickly. */
import { tempoMapOf } from '@core/automation/tempo';
import type { PatternId, Project, Tick } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { patternLength } from '@core/query/queries';
import { songSections } from '@core/query/sections';
import { playingChannels } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';

/** The part of the song to render and measure. */
export interface LevelWindow {
  mode: 'song' | 'pattern';
  patternId: PatternId | null;
  fromTick: Tick;
  bars: number;
}

/** At most this long a window (a slow lo-fi song's 8 bars are 27 s). */
const MAX_WINDOW_SECONDS = 20;
/** The window is about this many bars when nothing says otherwise. */
const DEFAULT_WINDOW_BARS = 8;
/** A bar's length (sec) assumed when the tempo map can't tell. */
const FALLBACK_BAR_SECONDS = 2;
/** A section's score: every playing channel counts this much, each note one (so channels decide and notes break ties). */
const SCORE_PER_PLAYING_CHANNEL = 10000;

/** How many bars fit in the window: `wantedBars`, shortened so the window stays under `MAX_WINDOW_SECONDS`. */
function barsThatFit(project: Project, mode: 'song' | 'pattern', fromTick: Tick, wantedBars: number): number {
  const oneBar = ticksPerBar(project.transport.timeSig);
  const tempo = tempoMapOf(project, mode);
  const barSeconds = tempo.tickToSeconds(fromTick + oneBar) - tempo.tickToSeconds(fromTick) || FALLBACK_BAR_SECONDS;
  return Math.max(1, Math.min(wantedBars, Math.floor(MAX_WINDOW_SECONDS / barSeconds)));
}

/** The sections of the song as spans, or (without sections) consecutive blocks of eight bars. */
function candidateSpans(project: Project, songEnd: Tick): { from: Tick; to: Tick }[] {
  const sections = songSections(project);
  if (sections.length) return sections.map((section) => ({ from: section.from, to: section.to }));
  const blockTicks = DEFAULT_WINDOW_BARS * ticksPerBar(project.transport.timeSig);
  const blockCount = Math.ceil(songEnd / blockTicks);
  return Array.from({ length: blockCount }, (_, block) => ({
    from: block * blockTicks,
    to: Math.min(songEnd, (block + 1) * blockTicks),
  }));
}

/** How many notes the unmuted pattern clips play inside the span. */
function noteCountIn(project: Project, from: Tick, to: Tick): number {
  let notes = 0;
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.muted || clip.start >= to || clip.start + clip.length <= from) continue;
    const pattern = project.patterns[clip.patternId];
    if (!pattern) continue;
    for (const notesOfChannel of Object.values(pattern.notes)) notes += Object.keys(notesOfChannel).length;
  }
  return notes;
}

/** The span whose first eight bars have the most channels playing (notes break ties). */
function busiestSpan(project: Project, spans: { from: Tick; to: Tick }[]): { from: Tick; to: Tick } {
  const blockTicks = DEFAULT_WINDOW_BARS * ticksPerBar(project.transport.timeSig);
  let best = spans[0]!;
  let bestScore = -1;
  for (const span of spans) {
    // Within the section's first 8 bars, what plays (every channel counts, notes break ties).
    const to = Math.min(span.to, span.from + blockTicks);
    const channels = playingChannels(project, { mode: 'song', patternId: null, fromTick: span.from, toTick: to }).size;
    const score = channels * SCORE_PER_PLAYING_CHANNEL + noteCountIn(project, span.from, to);
    if (score > bestScore) {
      bestScore = score;
      best = span;
    }
  }
  return best;
}

/** An empty song: the current pattern on a loop, in whole repeats of about eight bars. Null without a pattern. */
function patternLoopWindow(project: Project, currentPattern: PatternId | null, bars?: number): LevelWindow | null {
  const pattern = currentPattern ? project.patterns[currentPattern] : undefined;
  if (!pattern) return null;
  const patternBars = patternLength(pattern, project.transport.timeSig) / ticksPerBar(project.transport.timeSig);
  const repeats = Math.max(
    1,
    Math.round(barsThatFit(project, 'pattern', 0, bars ?? DEFAULT_WINDOW_BARS) / patternBars),
  );
  return { mode: 'pattern', patternId: pattern.id, fromTick: 0, bars: repeats * patternBars };
}

/** The busiest part of the song: the section (or 8 bars) with the most channels playing. */
export function busiestWindow(
  project: Project,
  currentPattern: PatternId | null,
  fromTick?: Tick,
  bars?: number,
): LevelWindow | null {
  const oneBar = ticksPerBar(project.transport.timeSig);
  const songEnd = songLength(project);
  if (songEnd <= 0) return patternLoopWindow(project, currentPattern, bars);
  if (fromTick !== undefined) {
    const from = Math.max(0, Math.min(fromTick, songEnd - oneBar));
    return {
      mode: 'song',
      patternId: null,
      fromTick: from,
      bars: barsThatFit(project, 'song', from, bars ?? DEFAULT_WINDOW_BARS),
    };
  }
  const best = busiestSpan(project, candidateSpans(project, songEnd));
  const spanBars = Math.max(
    1,
    Math.round((Math.min(best.to, best.from + DEFAULT_WINDOW_BARS * oneBar) - best.from) / oneBar),
  );
  return {
    mode: 'song',
    patternId: null,
    fromTick: best.from,
    bars: barsThatFit(project, 'song', best.from, bars ?? spanBars),
  };
}
