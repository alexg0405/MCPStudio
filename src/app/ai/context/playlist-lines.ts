/** The playlist and the song check as text. */
import type { Clip, LaneId, Project } from '@core/model/types';
import { laneRuns, songCheck } from '@core/query/arrangement';
import { songLength } from '@core/query/playlist';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { cachedForProject } from './project-cache';
import { fullRender, SHORT_NOTE, SHORT_RUNS, type ContextRender } from './budget';
import { formatDb } from './units';

/** Runs per track beyond which the listing says how many more there are (it never cuts silently). */
const MAX_RUNS = 120;
/** A run of this many clips or fewer lists their ids (longer runs are found by track and bar). */
const MAX_RUN_IDS = 3;

/** What a clip is, for its run: the pattern's name, or the audio or automation channel's with its edits. */
function clipDescription(project: Project, clip: Clip): string {
  if (clip.kind === 'pattern') return `"${project.patterns[clip.patternId]?.name ?? '?'}"`;
  const channelName = project.channels[clip.channelId]?.name ?? '?';
  if (clip.kind === 'automation') return `automation "${channelName}"`;
  const edits = [
    clip.gain !== undefined ? `gain ${formatDb(clip.gain)}` : '',
    clip.fadeIn ? `fade-in ${Math.round(clip.fadeIn * 1000)} ms` : '',
    clip.fadeOut ? `fade-out ${Math.round(clip.fadeOut * 1000)} ms` : '',
  ].filter(Boolean);
  return `audio "${channelName}"${edits.length ? ` (${edits.join(', ')})` : ''}`;
}

/** One run of back-to-back clips: what, how many, which bars, and flags. */
function runText(project: Project, run: ReturnType<typeof laneRuns>[number]): string {
  const timeSig = project.transport.timeSig;
  const clip = project.playlist.clips[run.clipIds[0]!]!;
  const ids = run.count <= MAX_RUN_IDS ? ` ${run.clipIds.join(', ')}` : '';
  const flags = [run.muted ? 'muted' : '', run.stacked ? `STACKED: plays ${run.stacked + 1}× here` : ''].filter(
    Boolean,
  );
  const repeat = run.count > 1 ? ` ×${run.count}` : '';
  return `${clipDescription(project, clip)}${repeat} ${barSpan(run.from, run.to, timeSig)}${flags.length ? ` (${flags.join(', ')})` : ''}${ids}`;
}

/** One track's line: its name and flags, then its runs (the first `cap`), and how many more there are. */
function trackLine(
  project: Project,
  laneId: LaneId,
  trackNumber: number,
  runs: ReturnType<typeof laneRuns>,
  cap: number,
): string {
  const lane = project.playlist.lanes[laneId];
  const name = lane && !/^Track \d+$/.test(lane.name) ? ` "${lane.name}"` : '';
  const flags = [lane?.muted ? 'muted' : '', lane?.solo ? 'solo' : ''].filter(Boolean).join(', ');
  const parts = runs.slice(0, cap).map((run) => runText(project, run));
  const lastRun = runs[runs.length - 1]!;
  const more =
    runs.length > cap
      ? `; … +${runs.length - cap} more up to ${barSpan(lastRun.from, lastRun.to, project.transport.timeSig)}`
      : '';
  return `- Track ${trackNumber}${name}${flags ? ` (${flags})` : ''}: ${parts.join('; ')}${more}`;
}

/** Every track's runs, split at the marker sections; worked out once per project version (shortening renders reuse it). */
function allLaneRuns(project: Project): Map<LaneId, ReturnType<typeof laneRuns>> {
  return cachedForProject(project, 'lane-runs', () => {
    const cuts = songSections(project).map((section) => section.from);
    return new Map(project.playlist.laneOrder.map((laneId) => [laneId, laneRuns(project, laneId, cuts)] as const));
  });
}

/**
 * The playlist: every track's clips, back-to-back repeats as one run ("“Drop” ×8 bars 37–52"), split
 * at the marker sections, which are listed first. Clip ids for short runs; longer runs are found by
 * track and bar.
 */
export function playlistLines(project: Project, render: ContextRender = fullRender()): string[] {
  const timeSig = project.transport.timeSig;
  const sections = songSections(project);
  const songEnd = songLength(project);
  const cap = render.shorten.runs ? SHORT_RUNS : MAX_RUNS;
  const lines = [
    `Playlist (song mode plays it). Bar ranges are 1-based and inclusive ("bars 81–112" is 32 bars)${
      songEnd ? `; the song is ${songEnd / ticksPerBar(timeSig)} bars long` : ''
    }.`,
    sections.length
      ? `Sections (markers): ${sections.map((section) => `"${section.name}" ${barSpan(section.from, section.to, timeSig)} ${section.markerId}`).join('; ')}`
      : 'Sections (markers): none',
  ];
  if (Object.keys(project.playlist.clips).length === 0) {
    lines.push('The playlist is empty.');
    return lines;
  }
  const runsByLane = allLaneRuns(project);
  project.playlist.laneOrder.forEach((laneId, index) => {
    const runs = runsByLane.get(laneId) ?? [];
    if (!runs.length) return;
    if (runs.length > cap && render.shorten.runs) render.cut.add('playlist');
    lines.push(trackLine(project, laneId, index + 1, runs, cap));
  });
  if (render.cut.has('playlist')) lines.splice(2, 0, SHORT_NOTE);
  return lines;
}

/** Problems in the arrangement, in plain words with the action that fixes them. */
export function songCheckLines(project: Project): string[] {
  return cachedForProject(project, 'song-check-lines', () => writeSongCheckLines(project));
}

function writeSongCheckLines(project: Project): string[] {
  const timeSig = project.transport.timeSig;
  const trackName = (laneId: string) => `Track ${project.playlist.laneOrder.indexOf(laneId as LaneId) + 1}`;
  const patternName = (patternId: keyof Project['patterns']) => project.patterns[patternId]?.name ?? '?';
  const lines: string[] = [];
  for (const issue of songCheck(project)) {
    switch (issue.kind) {
      case 'stacked':
        lines.push(
          `- ${barSpan(issue.from, issue.to, timeSig)} play the same clips ${issue.times} times at once (${issue.lanes.map(trackName).join(', ')}): that part is ${issue.times}× too loud. The tidy action removes the copies.`,
        );
        break;
      case 'doubled':
        lines.push(
          `- "${patternName(issue.patternId)}" overlaps itself at ${barSpan(issue.from, issue.to, timeSig)} (it plays twice there).`,
        );
        break;
      case 'repeats':
        lines.push(
          `- "${patternName(issue.patternId)}" repeats ${issue.count} times unchanged on ${trackName(issue.laneId)} (${barSpan(issue.from, issue.to, timeSig)}).`,
        );
        break;
      case 'unnamedLanes':
        lines.push(
          `- ${issue.count} track${issue.count === 1 ? ' has' : 's have'} no name ("Track N"): the track action names them.`,
        );
        break;
      case 'duplicateAutomation':
        lines.push(`- ${issue.count} automation channels "${issue.name}" are the same curve: tidy merges them.`);
        break;
    }
  }
  return lines;
}
