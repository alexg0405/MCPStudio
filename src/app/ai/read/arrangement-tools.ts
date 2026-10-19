/** Read tools for how the song is laid out in time: playlist clips, automation, recording takes and the clip launcher. */
import type { ParamSpecs } from '@agstudio/sdk';
import { formatAutomationValue } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { filledSlots, slotLabel, slotLoops, slotMode } from '@core/launcher/grid';
import { sameTarget } from '@core/model/targets';
import type { AutomationChannel, Clip, ClipId, LaneId, ParamTarget, Project } from '@core/model/types';
import { compSegmentsOf } from '@core/ops/comp';
import { groupName, overlappingGroups, takeGroups, type TakeGroup } from '@core/query/takes';
import type { Services } from '../../services';
import { automationDrives, ownUnitOf, paramTargetOf } from '../ops/automation';
import type { OpContext } from '../ops/context';
import { num, str } from '../ops/values';
import * as S from '../schema/parts';
import { BAR_RANGE, barCount, barEndAt, barNumberAt, barRange, projectOf, round2, tool, type ToolArgs } from './tool';

const CLIP_KINDS = ['pattern', 'audio', 'automation'];
/** Most clips get_clips returns when no limit is given. */
const DEFAULT_CLIP_LIMIT = 400;
/** Most clips it ever returns. */
const MAX_CLIP_LIMIT = 3000;

/** The 1-based playlist track number a lane is shown as. */
const trackNumberOf = (project: Project, laneId: LaneId) => project.playlist.laneOrder.indexOf(laneId) + 1;

/** The lanes the `tracks` argument names (1-based numbers), or null for all of them. */
function wantedLanes(project: Project, tracks: unknown): Set<LaneId | undefined> | null {
  if (!Array.isArray(tracks)) return null;
  const numbers = tracks.map(num).filter((value): value is number => value !== undefined);
  return new Set(numbers.map((trackNumber) => project.playlist.laneOrder[Math.round(trackNumber) - 1]));
}

/** The clips that touch the bar range, on the wanted tracks and of the wanted kind, by track and start. */
function clipsMatching(project: Project, args: ToolArgs): Clip[] {
  const range = barRange(project, args);
  const lanes = wantedLanes(project, args.tracks);
  const kind = CLIP_KINDS.find((candidate) => candidate === str(args.kind));
  const order = project.playlist.laneOrder;
  return (Object.values(project.playlist.clips) as Clip[])
    .filter((clip) => clip.start < range.to && clip.start + clip.length > range.from)
    .filter((clip) => !lanes || lanes.has(clip.laneId))
    .filter((clip) => !kind || clip.kind === kind)
    .sort((a, b) => order.indexOf(a.laneId) - order.indexOf(b.laneId) || a.start - b.start);
}

/** What a clip plays: its pattern's name, or its audio or automation channel's. */
function clipTargetName(project: Project, clip: Clip): string {
  if (clip.kind === 'pattern') return project.patterns[clip.patternId]?.name ?? '(deleted pattern)';
  return project.channels[clip.channelId]?.name ?? '(deleted channel)';
}

export const getClips = tool(
  'get_clips',
  'Playlist clips: id, track, bar where it starts, length in bars, kind (pattern, audio, automation), what it plays, muted. Filter by bars and tracks. Also the track names.',
  {
    ...BAR_RANGE,
    tracks: { type: 'array', items: { type: 'integer' }, description: '1-based playlist tracks (default all).' },
    kind: { type: 'string', enum: ['pattern', 'audio', 'automation'], description: 'Only this kind of clip.' },
    limit: S.int('Most clips to return (default 400).'),
  },
  (services, args) => {
    const project = projectOf(services);
    const limit = Math.max(1, Math.min(MAX_CLIP_LIMIT, Math.round(num(args.limit) ?? DEFAULT_CLIP_LIMIT)));
    const matching = clipsMatching(project, args);
    const shown = matching.slice(0, limit);
    const shownTrackNumbers = [...new Set(shown.map((clip) => trackNumberOf(project, clip.laneId)))];
    return {
      tracks: shownTrackNumbers.map((trackNumber) => {
        const lane = project.playlist.lanes[project.playlist.laneOrder[trackNumber - 1]!]!;
        return {
          n: trackNumber,
          name: lane.name,
          ...(lane.muted ? { muted: true } : {}),
          ...(lane.solo ? { solo: true } : {}),
        };
      }),
      clips: shown.map((clip) => ({
        id: clip.id,
        track: trackNumberOf(project, clip.laneId),
        bar: barNumberAt(project, clip.start),
        bars: barCount(project, clip.length),
        kind: clip.kind,
        name: clipTargetName(project, clip),
        ...(clip.muted ? { muted: true } : {}),
      })),
      total: matching.length,
      ...(matching.length > shown.length ? { truncated: true } : {}),
    };
  },
);

/** The automation channels the arguments ask about: one by channel, those moving a control, or all. Or an error reply. */
function wantedAutomation(
  project: Project,
  args: ToolArgs,
  lookup: OpContext,
): AutomationChannel[] | { error: string } {
  const all = project.channelOrder
    .map((id) => project.channels[id]!)
    .filter((channel): channel is AutomationChannel => channel.kind === 'automation');
  if (args.channel !== undefined) {
    const channel = project.channels[lookup.channel(args.channel)]!;
    if (channel.kind !== 'automation') return { error: `“${channel.name}” is not an automation channel` };
    return [channel];
  }
  if (args.target !== undefined) {
    const target = paramTargetOf(lookup, args.target);
    return all.filter((channel) => channel.target && sameTarget(channel.target, target));
  }
  return all;
}

/** The curve of an automation channel: bar, value in the control's own unit, shown text, shape and tension. */
function describeCurve(services: Services, project: Project, channel: AutomationChannel, target: ParamTarget) {
  const specsOf = (pluginId: string) => services.plugins.get(pluginId)?.params as ParamSpecs | undefined;
  const resolved = resolveTarget(project, target, specsOf, channel.range);
  if (!resolved) return [];
  return channel.points.map((point) => ({
    bar: barCount(project, point.tick),
    value: ownUnitOf(resolved, target, point.value),
    text: formatAutomationValue(resolved, target, point.value),
    ...(point.shape && point.shape !== 'curve' ? { shape: point.shape } : {}),
    ...(point.tension ? { tension: round2(point.tension) } : {}),
  }));
}

export const getAutomation = tool(
  'get_automation',
  'Automation: the automation channels (what each drives, its clips on the playlist), or the curve points of one: by its channel or by the control it moves. Point values are in the control’s own unit (dB, BPM, Hz…), bars from the clip start.',
  {
    channel: { ...S.CHANNEL, description: 'An automation channel: its id or name.' },
    target: S.AUTOMATION_TARGET,
  },
  (services, args, lookup) => {
    const project = projectOf(services);
    const wanted = wantedAutomation(project, args, lookup);
    if (!Array.isArray(wanted)) return wanted;
    const wantsCurves = args.channel !== undefined || args.target !== undefined;
    return {
      automation: wanted.map((channel) => {
        const clips = (Object.values(project.playlist.clips) as Clip[])
          .filter((clip) => clip.kind === 'automation' && clip.channelId === channel.id)
          .sort((a, b) => a.start - b.start)
          .map((clip) => ({
            id: clip.id,
            track: trackNumberOf(project, clip.laneId),
            bar: barNumberAt(project, clip.start),
            bars: barCount(project, clip.length),
          }));
        const head = {
          id: channel.id,
          name: channel.name,
          drives: automationDrives(services, project, channel),
          points: channel.points.length,
          clips,
        };
        if (!wantsCurves || !channel.target) return head;
        return { ...head, curve: describeCurve(services, project, channel, channel.target) };
      }),
    };
  },
);

/** One take group: its tracks, takes (1-based, in recording order), the comp, and which take is being auditioned. */
function describeTakeGroup(services: Services, project: Project, group: TakeGroup, auditionedClipId: ClipId | null) {
  const takeNumber = (takeIndex: number) => group.takes.findIndex((take) => take.index === takeIndex) + 1;
  const auditionedTake = group.takes.find((take) => take.clips.some((clip) => clip.id === auditionedClipId));
  const compName = groupName(project, group);
  // Takes of more than one recording (after "add these takes to the comp") say which recording each came from.
  const recordings = new Set(group.takes.map((take) => take.clips[0]?.channelId));
  const channelName = (take: TakeGroup['takes'][number]) => project.channels[take.clips[0]?.channelId as never]?.name;
  return {
    group: group.id,
    name: compName,
    // Other recordings of the same bars: add_takes can move their takes into this comp (or this one's into theirs).
    overlaps_groups: overlappingGroups(project, group).map((other) => other.id),
    comp_track: group.compLane ? trackNumberOf(project, group.compLane) : null,
    take_tracks: group.takeLanes.map((laneId) => trackNumberOf(project, laneId)),
    takes_open: services.editor.getState().openTakes.includes(group.id),
    // The take the musician is listening to on its own (a session switch, not in the project), else null.
    listening_to_take: takeNumber(auditionedTake?.index ?? -1) || null,
    crossfade_ms: group.crossfadeMs,
    takes: group.takes.map((take) => ({
      take: takeNumber(take.index),
      ...(recordings.size > 1 ? { recording: channelName(take) } : {}),
      clips: take.clips.map((clip) => ({
        id: clip.id,
        track: trackNumberOf(project, clip.laneId),
        bar: barNumberAt(project, clip.start),
        bars: barCount(project, clip.length),
      })),
    })),
    comp: compSegmentsOf(group).map((segment) => ({
      take: takeNumber(segment.take),
      bar: barNumberAt(project, segment.from),
      bars: barCount(project, segment.to - segment.from),
    })),
  };
}

export const getTakes = tool(
  'get_takes',
  'Audio recordings that have takes (loop passes): for each take group its comp track and take tracks (1-based playlist tracks), the takes (1-based, in recording order, with their clip ids, bar and length; the recording they came from once takes of several recordings were added to one comp), the groups it overlaps in time (overlaps_groups: the comp action add_takes merges them), what the comp plays where (take number per range of bars), its crossfade and which take the musician is listening to on its own (listening_to_take; the comp.listenTake command starts that); also the punch range and recording settings. The comp action takes these numbers.',
  { group: S.str('Only this take group (its id).') },
  (services, args) => {
    const project = projectOf(services);
    const wanted = str(args.group);
    const auditioned = services.editor.getState().auditionTake;
    const groups = takeGroups(project)
      .filter((group) => !wanted || group.id === wanted)
      .map((group) => describeTakeGroup(services, project, group, auditioned));
    const view = services.view.getState();
    const prefs = services.prefs.getState();
    return {
      groups,
      punch: view.punch
        ? { from_bar: barNumberAt(project, view.punch.start), to_bar: barEndAt(project, view.punch.end) }
        : null,
      loop: view.loop
        ? { from_bar: barNumberAt(project, view.loop.start), to_bar: barEndAt(project, view.loop.end) }
        : null,
      recording: {
        record_mode_armed: services.recording.armed,
        records_audio: prefs.recordAudio,
        count_in_bars: prefs.countInBars,
        pre_roll_bars: prefs.preRollBars,
        input_channels: prefs.audioInputChannels,
        latency_ms: round2(services.audioInput.latency() * 1000),
      },
    };
  },
);

/** One filled launcher slot: what it plays, how it launches, and what it is doing now. */
function describeSlot(
  services: Services,
  project: Project,
  filled: ReturnType<typeof filledSlots>[number],
  heardUnit: number,
) {
  const { slot } = filled;
  const content = slot.content;
  const playing =
    content.kind === 'pattern'
      ? { pattern: project.patterns[content.patternId]?.name ?? null, pattern_id: content.patternId }
      : {
          audio: project.channels[content.channelId]?.name ?? null,
          audio_id: content.channelId,
          bars: barCount(project, content.length),
        };
  return {
    track: filled.track + 1,
    scene: filled.scene + 1,
    name: slotLabel(project, slot),
    ...playing,
    mode: slotMode(slot),
    loop: slotLoops(slot),
    quantize: slot.quantize ?? null,
    follow: slot.follow ?? null,
    state: services.launcher.stateOf(filled.trackId, filled.sceneId, heardUnit).state,
  };
}

export const getLauncher = tool(
  'get_launcher',
  'The clip launcher (Performance mode): its grid of slots (tracks across, scenes down) with, per slot, what it plays (a pattern or an audio clip channel), name, launch mode, loop, quantize (null = the grid’s), follow action and what it is doing now (idle, queued, playing, stopping); the scenes and tracks with their names and the playlist track a launcher track takes over; the default quantize and whether a performance is being recorded. Positions are 1-based, what launcher_slot and launcher_play take.',
  {},
  (services) => {
    const project = projectOf(services);
    const launcher = project.launcher;
    const isRecording = services.launcher.store.getState().recording;
    if (!launcher) {
      return {
        empty: true,
        note: 'The clip launcher has no slots yet: launcher_slot puts a pattern or audio in one.',
        recording: isRecording,
      };
    }
    const heardUnit = services.launcher.runs.length ? services.launcher.clock().heardU : 0;
    return {
      quantize: launcher.quantize,
      recording: isRecording,
      playing: services.launcher.runs.some(
        (run) => run.startU <= heardUnit && (run.endU === null || run.endU > heardUnit),
      ),
      tracks: launcher.trackOrder.map((id, index) => {
        const launcherTrack = launcher.tracks[id]!;
        const playlistTrack = launcherTrack.laneId ? trackNumberOf(project, launcherTrack.laneId) : 0;
        return {
          track: index + 1,
          name: launcherTrack.name,
          playlist_track: playlistTrack > 0 ? playlistTrack : null,
        };
      }),
      scenes: launcher.sceneOrder.map((id, index) => ({ scene: index + 1, name: launcher.scenes[id]!.name })),
      slots: filledSlots(launcher).map((filled) => describeSlot(services, project, filled, heardUnit)),
    };
  },
);
