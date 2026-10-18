import { tempoMapOf } from '@core/automation/tempo';
import type { Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { TransportView } from './api';
import type { Timeline } from './sched/core';
import { patternModeSource, songModeSource, type EventSource } from './sched/events';

/** What the transport plays and the timeline it plays it on. */
export interface TransportModel {
  source: EventSource;
  timeline: Timeline;
}

/** The ticks of a timeline that never ends (the launcher alone, a recording without a loop region). */
const ENDLESS = Number.MAX_SAFE_INTEGER;

/** Whether two transport views play the same thing. */
export function sameView(a: TransportView, b: TransportView): boolean {
  return a.mode === b.mode && a.patternId === b.patternId && a.loop?.start === b.loop?.start && a.loop?.end === b.loop?.end;
}

/** What the transport plays for a view: the pattern on loop, or the song (see `songModel`). */
export function planTransportModel(
  project: Project,
  view: TransportView,
  openEnded: boolean,
  launch: Pick<EventSource, 'launch'>,
): TransportModel {
  const model = view.mode === 'song' ? songModel(project, view, openEnded) : patternModel(project, view);
  return { source: { ...model.source, ...launch }, timeline: model.timeline };
}

/** The launcher on its own: no song, the project's tempo, until something stops it. */
export function launcherOnlyModel(project: Project, launch: Pick<EventSource, 'launch'>): TransportModel {
  return {
    source: { project, clips: [], ...launch },
    timeline: { tempo: tempoMapOf(project, 'pattern'), loop: null, endTick: ENDLESS },
  };
}

/**
 * Song mode loops the loop region, or the whole song (FL's default); while recording audio without a loop region
 * (`openEnded`) it plays on past the end.
 */
function songModel(project: Project, view: TransportView, openEnded: boolean): TransportModel {
  const tempo = tempoMapOf(project, 'song');
  const { source, length } = songModeSource(project);
  const songEnd = Math.max(length, ticksPerBar(project.transport.timeSig));
  const region = view.loop && view.loop.end > view.loop.start ? view.loop : null;
  if (!region && openEnded) return { source, timeline: { tempo, loop: null, endTick: ENDLESS } };
  return { source, timeline: { tempo, loop: region ?? { start: 0, end: songEnd }, endTick: songEnd } };
}

/** Pattern mode loops the chosen pattern (the first one when none is chosen). */
function patternModel(project: Project, view: TransportView): TransportModel {
  const tempo = tempoMapOf(project, 'pattern');
  const { source, length } = patternModeSource(project, view.patternId ?? project.patternOrder[0] ?? null);
  return { source, timeline: { tempo, loop: { start: 0, end: length }, endTick: length } };
}
