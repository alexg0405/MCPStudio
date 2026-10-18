/**
 * The <focus> block of a turn: what the AI is told about the part of the song a request is about, the song around it,
 * the clips and notes in it, and what may change.
 */
import { formatAutomationValue, targetName, type PluginInfoResolver } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import type { ChannelId, Clip, LaneId, Note, Project } from '@core/model/types';
import { barActivity } from '@core/query/activity';
import { laneRuns, type ClipRun } from '@core/query/arrangement';
import { patternLength } from '@core/query/queries';
import { songSections, type Section } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { TICKS_PER_STEP, ticksPerBar } from '@core/time/ppq';
import type { ParamSpecs } from '@agstudio/sdk';
import { channelSound, noteName } from '../../assistant/context';
import { noteLines } from '../note-lines';
import { mergedSpans, partPatterns, usesOutside } from './spans';
import { plural, type ResolvedFocus } from './types';

/** Bars either side of the part whose clips are listed (for transitions). */
const CLIP_CONTEXT_BARS = 2;
/** Bars either side of the part whose activity is listed. */
const ACTIVITY_CONTEXT_BARS = 4;
/** Most bars of activity listed. */
const MAX_ACTIVITY_BARS = 64;
/** Notes listed per channel before "… +N more". */
const MAX_NOTES_SHOWN = 96;
/** A run of this many clips or fewer lists their ids. */
const MAX_RUN_IDS = 4;
/** The velocity notes have unless said otherwise (not written out). */
const DEFAULT_VELOCITY = 0.8;

const round2 = (value: number) => Math.round(value * 100) / 100;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const formatStep = (steps: number) => String(round2(steps));
/** "@.6" for a velocity other than the default, "" for the default. */
const formatVelocity = (velocity: number) =>
  Math.abs(velocity - DEFAULT_VELOCITY) < 0.005 ? '' : `@${String(round2(velocity)).replace(/^0(?=\.)/, '')}`;

/** Notes as the AI writes them: drums as steps, pitched notes as step:note/length (velocity when not 0.8). */
function formatNotes(project: Project, channelId: ChannelId, notes: readonly Note[]): string {
  const channel = project.channels[channelId];
  const sound = channel ? channelSound(project, channel) : null;
  const isDrum = sound !== null && DRUM_SOUNDS.has(sound as BeatSound);
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.key - b.key);
  const shown = sorted.slice(0, MAX_NOTES_SHOWN).map((note) => {
    const step = formatStep(note.tick / TICKS_PER_STEP);
    if (isDrum) return `${step}${formatVelocity(note.velocity)}`;
    return `${step}:${noteName(note.key)}/${formatStep(note.length / TICKS_PER_STEP)}${formatVelocity(note.velocity)}`;
  });
  const more = sorted.length > MAX_NOTES_SHOWN ? ` … (+${sorted.length - MAX_NOTES_SHOWN} more)` : '';
  return `${shown.join(' ')}${more}`;
}

/** What a clip is: its pattern's name, or "audio" / "automation" with its channel's. */
function clipWhat(project: Project, clip: Clip): string {
  if (clip.kind === 'pattern') return `“${project.patterns[clip.patternId]?.name ?? '?'}”`;
  return `${clip.kind} “${project.channels[clip.channelId]?.name ?? '?'}”`;
}

/** One run of clips for the track lines. `withIds` lists the clip ids of short runs. */
function runText(project: Project, run: ClipRun, withIds: boolean): string {
  const timeSig = project.transport.timeSig;
  const clip = project.playlist.clips[run.clipIds[0]!]!;
  const flags = [run.muted ? 'muted' : '', run.stacked ? `STACKED: plays ${run.stacked + 1}× here` : ''].filter(
    Boolean,
  );
  const ids = withIds && run.count <= MAX_RUN_IDS ? ` ${run.clipIds.join(', ')}` : '';
  const repeat = run.count > 1 ? ` ×${run.count}` : '';
  return `${clipWhat(project, clip)}${repeat} ${barSpan(run.from, run.to, timeSig)}${flags.length ? ` (${flags.join(', ')})` : ''}${ids}`;
}

/** The sections the part touches, and what is before and after it. */
function sectionLines(project: Project, focus: ResolvedFocus): string[] {
  const timeSig = project.transport.timeSig;
  const sections = songSections(project);
  const lines: string[] = [];
  const touched = sections.filter((section) => section.from < focus.to && section.to > focus.from);
  const before = [...sections].reverse().find((section) => section.to <= focus.from);
  const after = sections.find((section) => section.from >= focus.to);
  const name = (section: Section) => `“${section.name}” ${barSpan(section.from, section.to, timeSig)}`;
  if (!focus.section && touched.length) lines.push(`Sections it is in: ${touched.map(name).join(', ')}.`);
  const around = [
    before ? `before it ${name(before)}` : 'nothing before it',
    after ? `after it ${name(after)}` : 'the song ends after it',
  ];
  if (sections.length) lines.push(`Around it: ${around.join('; ')}.`);
  return lines;
}

/** What the part is, where it sits among the sections, and what may change. */
function introLines(project: Project, focus: ResolvedFocus): string[] {
  const timeSig = project.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const span = barSpan(focus.from, focus.to, timeSig);
  const bars = round2((focus.to - focus.from) / barTicks);
  let what = `${span} (a range the musician looped)`;
  if (focus.section) what = `the section “${focus.section.name}” (marker ${focus.section.markerId}), ${span}`;
  else if (focus.clips) what = `${plural(focus.clips.size, 'selected clip')} (${span})`;
  const lines = [`The musician is asking about ${what}: ${plural(bars, 'bar')}.`, ...sectionLines(project, focus)];
  const transitionStart = Math.max(0, focus.from - barTicks);
  const transitionEnd = focus.to + barTicks;
  const startsIn = barSpan(transitionStart, transitionStart + barTicks, timeSig);
  const endsIn = barSpan(focus.to, transitionEnd, timeSig);
  lines.push(
    focus.clips
      ? `Change only these clips (and clips you add within ${span}); a transition may start at ${startsIn} or end in ${endsIn}.`
      : `Change only ${span}; a transition may start in ${startsIn} or end in ${endsIn}. Everything else stays as it is.`,
  );
  return lines;
}

/** The clips of a clips focus, one line each. */
function selectedClipLines(project: Project, focus: ResolvedFocus): string[] {
  if (!focus.clips) return [];
  const timeSig = project.transport.timeSig;
  const lines = ['', 'The selected clips:'];
  for (const id of focus.clips) {
    const clip = project.playlist.clips[id]!;
    const track = project.playlist.laneOrder.indexOf(clip.laneId) + 1;
    const muted = clip.muted ? ' (muted)' : '';
    lines.push(
      `- ${clipWhat(project, clip)} on track ${track}, ${barSpan(clip.start, clip.start + clip.length, timeSig)}${muted} ${clip.id}`,
    );
  }
  return lines;
}

/** The clips of one track around the part, grouped into before, in the part and after. */
function trackLine(
  project: Project,
  focus: ResolvedFocus,
  laneId: LaneId,
  trackNumber: number,
  runs: ClipRun[],
): string {
  const groups: Record<'before' | 'in' | 'after', string[]> = { before: [], in: [], after: [] };
  for (const run of runs) {
    if (run.to <= focus.from) {
      groups.before.push(runText(project, run, false));
    } else if (run.from >= focus.to) {
      groups.after.push(runText(project, run, false));
    } else {
      let edge = '';
      if (run.from < focus.from) edge = ' (starts before the part)';
      else if (run.to > focus.to) edge = ' (runs past the part)';
      groups.in.push(`${runText(project, run, true)}${edge}`);
    }
  }
  const lane = project.playlist.lanes[laneId];
  const name = lane && !/^Track \d+$/.test(lane.name) ? ` "${lane.name}"` : '';
  const parts = [
    groups.before.length ? `before: ${groups.before.join('; ')}` : '',
    groups.in.length ? `in the part: ${groups.in.join('; ')}` : '',
    groups.after.length ? `after: ${groups.after.join('; ')}` : '',
  ].filter(Boolean);
  return `- Track ${trackNumber}${name}${lane?.muted ? ' (muted)' : ''}: ${parts.join(' | ')}`;
}

/** Clips per track over the part and two bars either side. */
function clipsAroundLines(project: Project, focus: ResolvedFocus): string[] {
  const timeSig = project.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const windowStart = Math.max(0, focus.from - CLIP_CONTEXT_BARS * barTicks);
  const windowEnd = focus.to + CLIP_CONTEXT_BARS * barTicks;
  const cuts = [focus.from, focus.to];
  const trackLines: string[] = [];
  project.playlist.laneOrder.forEach((laneId, index) => {
    const runs = laneRuns(project, laneId, cuts).filter((run) => run.from < windowEnd && run.to > windowStart);
    if (runs.length) trackLines.push(trackLine(project, focus, laneId, index + 1, runs));
  });
  return [
    '',
    `Clips on the playlist around it (${barSpan(windowStart, windowEnd, timeSig)}; “before” and “after” are the ${CLIP_CONTEXT_BARS} bars either side, for transitions):`,
    ...(trackLines.length ? trackLines : ['(nothing plays here)']),
  ];
}

/** The patterns that play in the part, with their notes and whether editing them gives the part its own copy. */
function patternBlockLines(project: Project, focus: ResolvedFocus): string[] {
  const patternIds = partPatterns(project, focus);
  if (patternIds.length === 0) return [];
  const timeSig = project.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const lines = [
    '',
    'Patterns that play in the part (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8):',
  ];
  const originalOfCopy = new Map([...focus.copies].map(([original, copy]) => [copy, original]));
  for (const patternId of patternIds) {
    const pattern = project.patterns[patternId]!;
    const bars = round2(patternLength(pattern, timeSig) / barTicks);
    const outside = usesOutside(project, focus, patternId);
    const where = outside.length
      ? `also plays at ${outside.map((span) => barSpan(span.from, span.to, timeSig)).join(', ')} (editing it gives the part its own copy first)`
      : 'plays only in this part (edits change only the part)';
    const original = originalOfCopy.get(patternId);
    const copyNote =
      original && project.patterns[original] ? `; the part's own copy of “${project.patterns[original]!.name}”` : '';
    lines.push(`- “${pattern.name}” ${patternId}, ${plural(bars, 'bar')}: ${where}${copyNote}`);
    const notes = noteLines(project, pattern);
    lines.push(...(notes.length ? notes : ['  (empty)']));
  }
  return lines;
}

/** What plays, bar by bar, from four bars before the part to four after. */
function activityLines(project: Project, focus: ResolvedFocus): string[] {
  const timeSig = project.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const from = Math.max(0, focus.from - ACTIVITY_CONTEXT_BARS * barTicks);
  const to = focus.to + ACTIVITY_CONTEXT_BARS * barTicks;
  const activity = barActivity(project, from, to);
  const shown = activity.slice(0, MAX_ACTIVITY_BARS);
  const channelName = (id: ChannelId) => project.channels[id]?.name ?? '?';
  const lines = ['', `What plays per bar (notes starting in each bar, ${barSpan(from, to, timeSig)}):`];
  for (const bar of shown) {
    let where = '';
    if (bar.to <= focus.from) where = ' (before)';
    else if (bar.from >= focus.to) where = ' (after)';
    const parts = [
      bar.total
        ? `${plural(bar.total, 'note')}: ${bar.notes.map((entry) => `${channelName(entry.channelId)} ${entry.count}`).join(', ')}`
        : '',
      bar.audio.length ? `audio ${bar.audio.map((id) => `“${channelName(id)}”`).join(', ')}` : '',
      bar.automation.length ? `automation ${bar.automation.map((id) => `“${channelName(id)}”`).join(', ')}` : '',
    ].filter(Boolean);
    lines.push(`- bar ${bar.bar}${where}: ${parts.length ? parts.join('; ') : 'silence'}`);
  }
  if (activity.length > shown.length) lines.push(`- … +${activity.length - shown.length} more bars`);
  return lines;
}

/** Automation clips over the part (and the two bars either side): what they drive and where they go. */
function automationLines(project: Project, focus: ResolvedFocus, plugins?: PluginInfoResolver): string[] {
  const timeSig = project.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const windowStart = Math.max(0, focus.from - CLIP_CONTEXT_BARS * barTicks);
  const windowEnd = focus.to + CLIP_CONTEXT_BARS * barTicks;
  const specsOf = (pluginId: string) => plugins?.(pluginId)?.params as ParamSpecs | undefined;
  const lines: string[] = [];
  const clips = Object.values(project.playlist.clips).sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    if (clip.kind !== 'automation' || clip.start >= windowEnd || clip.start + clip.length <= windowStart) continue;
    const channel = project.channels[clip.channelId];
    if (channel?.kind !== 'automation') continue;
    const target = channel.target;
    const what = (target && plugins ? targetName(project, target, plugins) : null) ?? channel.name;
    const resolved = target ? resolveTarget(project, target, specsOf, channel.range) : null;
    const valueText = (normalized: number) =>
      resolved && target ? formatAutomationValue(resolved, target, normalized) : `${Math.round(normalized * 100)}%`;
    const points = channel.points;
    const curve = points.length
      ? `${valueText(points[0]!.value)} → ${valueText(points[points.length - 1]!.value)}`
      : 'no points';
    const track = project.playlist.laneOrder.indexOf(clip.laneId) + 1;
    const muted = clip.muted ? ' (muted)' : '';
    lines.push(
      `- “${what}” (automation ${channel.id}) on track ${track}, ${barSpan(clip.start, clip.start + clip.length, timeSig)}: ${curve}${muted}`,
    );
  }
  return [
    '',
    'Automation over the part (a control keeps its last value after its clip ends):',
    ...(lines.length ? lines : ['(none)']),
  ];
}

/** The time part: where it is, the clips per track around it, its patterns' notes, activity, automation. */
function timeContext(project: Project, focus: ResolvedFocus, plugins?: PluginInfoResolver): string[] {
  return [
    ...introLines(project, focus),
    ...selectedClipLines(project, focus),
    ...clipsAroundLines(project, focus),
    ...patternBlockLines(project, focus),
    ...activityLines(project, focus),
    ...automationLines(project, focus, plugins),
  ];
}

/** The notes part: the selected notes, the channel's other notes, where the pattern plays. */
function notesContext(project: Project, focus: ResolvedFocus): string[] {
  const { patternId, channelId, ids } = focus.notes!;
  const timeSig = project.transport.timeSig;
  const pattern = project.patterns[patternId]!;
  const channel = project.channels[channelId]!;
  const allNotes = Object.values(pattern.notes[channelId] ?? {});
  const selected = allNotes.filter((note) => ids.has(note.id));
  const others = allNotes.filter((note) => !ids.has(note.id));
  const bars = round2(patternLength(pattern, timeSig) / ticksPerBar(timeSig));
  const lines = [
    `The musician selected ${plural(selected.length, 'note')} of “${channel.name}” ${channelId} in the pattern “${pattern.name}” ${patternId} (${plural(bars, 'bar')}) and the request is about them.`,
    'Only these notes may change: write_notes on that channel (replace) swaps them for the notes you write, note_tool works on them alone, and the steps tools are off. The channel’s other notes stay as they are.',
    '',
    `Selected notes (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8): ${formatNotes(project, channelId, selected)}`,
    `The other notes of “${channel.name}” in this pattern: ${others.length ? formatNotes(project, channelId, others) : 'none'}`,
  ];
  const otherChannels = project.channelOrder.filter(
    (id) => id !== channelId && Object.keys(pattern.notes[id] ?? {}).length > 0,
  );
  if (otherChannels.length) {
    const described = otherChannels.map(
      (id) => `${project.channels[id]?.name ?? id} (${Object.keys(pattern.notes[id] ?? {}).length})`,
    );
    lines.push(`Other channels in “${pattern.name}”: ${described.join(', ')}`);
  }
  const spans = mergedSpans(
    Object.values(project.playlist.clips)
      .filter((clip) => clip.kind === 'pattern' && clip.patternId === patternId)
      .map((clip) => ({ from: clip.start, to: clip.start + clip.length })),
  );
  lines.push(
    spans.length
      ? `“${pattern.name}” plays at ${spans.map((span) => barSpan(span.from, span.to, timeSig)).join(', ')} in the song: the changed notes play there.`
      : `“${pattern.name}” isn't in the song (it plays in pattern mode).`,
  );
  return lines;
}

/**
 * The <focus> block the AI gets with a request about a part: what the part is, the song around it,
 * the clips and notes in it, and what may change. `plugins` names plugin settings for automation.
 */
export function focusContext(project: Project, focus: ResolvedFocus, plugins?: PluginInfoResolver): string {
  const lines = focus.notes ? notesContext(project, focus) : timeContext(project, focus, plugins);
  return [`Working on: ${capitalize(focus.label)}`, ...lines].join('\n');
}
