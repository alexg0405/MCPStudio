import { tempoMapOf } from '@core/automation/tempo';
import type { PatternId, Project, Tick } from '@core/model/types';
import { patternLength } from '@core/query/queries';
import { songLength } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';

/** What an export renders: the whole song, the current pattern, or the playlist's loop region. */
export type ExportRange = 'song' | 'pattern' | 'loop';

export interface ExportPlan {
  mode: 'song' | 'pattern';
  patternId: PatternId | null;
  fromTick: Tick;
  /** Length in bars (fractions for a loop region that isn't whole bars). */
  bars: number;
}

/** The render for a range, or a reason it can't be exported. */
export function planExport(
  project: Project,
  view: { currentPatternId: PatternId | null; loop: { start: Tick; end: Tick } | null },
  range: ExportRange,
): ExportPlan | { error: string } {
  const bar = ticksPerBar(project.transport.timeSig);
  const patternId = view.currentPatternId;
  if (range === 'pattern') {
    const pattern = patternId ? project.patterns[patternId] : undefined;
    if (!pattern) return { error: 'There is no pattern to export.' };
    return { mode: 'pattern', patternId, fromTick: 0, bars: patternLength(pattern, project.transport.timeSig) / bar };
  }
  if (range === 'loop') {
    const loop = view.loop;
    if (!loop || loop.end <= loop.start) return { error: 'Select a loop region on the playlist ruler first.' };
    return { mode: 'song', patternId, fromTick: loop.start, bars: (loop.end - loop.start) / bar };
  }
  const length = songLength(project);
  if (length <= 0) return { error: 'The playlist is empty: add clips, or export the current pattern instead.' };
  return { mode: 'song', patternId, fromTick: 0, bars: length / bar };
}

/** Seconds the planned span lasts (it follows tempo automation in song mode). */
export function planSeconds(project: Project, plan: ExportPlan): number {
  const tempo = tempoMapOf(project, plan.mode);
  const end = plan.fromTick + plan.bars * ticksPerBar(project.transport.timeSig);
  return tempo.tickToSeconds(end) - tempo.tickToSeconds(plan.fromTick);
}
