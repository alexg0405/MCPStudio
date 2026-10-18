import type { Draft } from 'immer';
import {
  DEFAULT_LAUNCH_QUANTIZE,
  DEFAULT_SCENES,
  DEFAULT_TRACKS,
  MAX_SCENES,
  MAX_TRACKS,
  contentExists,
} from '../launcher/grid';
import { followsTempo, playbackMode } from '../audio/playback';
import { newId } from '../model/ids';
import { paletteColor } from '../model/defaults';
import { PPQ } from '../time/ppq';
import type {
  AudioClip,
  ChannelId,
  FollowAction,
  LaneId,
  LaunchContent,
  LaunchMode,
  LaunchQuantize,
  LaunchScene,
  LaunchSlot,
  LaunchTrack,
  LaunchTrackId,
  Launcher,
  PatternId,
  Project,
  SceneId,
} from '../model/types';
import { FOLLOW_KINDS, LAUNCH_MODES, LAUNCH_QUANTIZES } from '../model/types';

// Draft mutators for the clip launcher's grid (Project.launcher). Launching itself is session state.

const MAX_NAME = 64;
const cleanName = (name: string, fallback: string) => name.trim().slice(0, MAX_NAME) || fallback;

function newTrack(index: number): LaunchTrack {
  return { id: newId.launchTrack(), name: `Track ${index + 1}`, color: paletteColor(index), slots: {} };
}

function newScene(index: number): LaunchScene {
  return { id: newId.scene(), name: `Scene ${index + 1}` };
}

/** The grid, made (8 tracks × 8 scenes, launching on the bar) the first time it is needed. */
export function ensureLauncher(d: Draft<Project>): Draft<Launcher> {
  if (!d.launcher) {
    const l: Launcher = { quantize: DEFAULT_LAUNCH_QUANTIZE, tracks: {}, trackOrder: [], scenes: {}, sceneOrder: [] };
    for (let i = 0; i < DEFAULT_TRACKS; i++) {
      const t = newTrack(i);
      l.tracks[t.id] = t;
      l.trackOrder.push(t.id);
    }
    for (let i = 0; i < DEFAULT_SCENES; i++) {
      const s = newScene(i);
      l.scenes[s.id] = s;
      l.sceneOrder.push(s.id);
    }
    d.launcher = l as Draft<Launcher>;
  }
  return d.launcher as Draft<Launcher>;
}

/** Makes the grid at least `tracks` × `scenes` (capped); returns it. */
export function ensureCapacity(d: Draft<Project>, tracks: number, scenes: number): Draft<Launcher> {
  const l = ensureLauncher(d);
  while (l.trackOrder.length < Math.min(tracks, MAX_TRACKS)) addLaunchTrack(d);
  while (l.sceneOrder.length < Math.min(scenes, MAX_SCENES)) addScene(d);
  return l;
}

export function addLaunchTrack(d: Draft<Project>, name?: string): LaunchTrackId {
  const l = ensureLauncher(d);
  const t = newTrack(l.trackOrder.length);
  if (name) t.name = cleanName(name, t.name);
  l.tracks[t.id] = t as Draft<LaunchTrack>;
  l.trackOrder.push(t.id);
  return t.id;
}

export function addScene(d: Draft<Project>, name?: string): SceneId {
  const l = ensureLauncher(d);
  const s = newScene(l.sceneOrder.length);
  if (name) s.name = cleanName(name, s.name);
  l.scenes[s.id] = s as Draft<LaunchScene>;
  l.sceneOrder.push(s.id);
  return s.id;
}

export function removeLaunchTrack(d: Draft<Project>, id: LaunchTrackId): void {
  const l = d.launcher;
  if (!l?.tracks[id]) return;
  delete l.tracks[id];
  l.trackOrder.splice(l.trackOrder.indexOf(id), 1);
}

export function removeScene(d: Draft<Project>, id: SceneId): void {
  const l = d.launcher;
  if (!l?.scenes[id]) return;
  delete l.scenes[id];
  l.sceneOrder.splice(l.sceneOrder.indexOf(id), 1);
  for (const t of Object.values(l.tracks)) delete t.slots[id];
}

export function renameScene(d: Draft<Project>, id: SceneId, name: string): void {
  const s = d.launcher?.scenes[id];
  if (s) s.name = cleanName(name, s.name);
}

export function renameLaunchTrack(d: Draft<Project>, id: LaunchTrackId, name: string): void {
  const t = d.launcher?.tracks[id];
  if (t) t.name = cleanName(name, t.name);
}

/** A '#rrggbb' colour, or null for the default. */
export function recolorLaunchTrack(d: Draft<Project>, id: LaunchTrackId, color: string | null): void {
  const t = d.launcher?.tracks[id];
  if (!t) return;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) t.color = color;
  else delete t.color;
}

export function recolorScene(d: Draft<Project>, id: SceneId, color: string | null): void {
  const s = d.launcher?.scenes[id];
  if (!s) return;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) s.color = color;
  else delete s.color;
}

/** The playlist track a launcher track takes over while it plays (null = none). */
export function setTrackLane(d: Draft<Project>, id: LaunchTrackId, laneId: LaneId | null): void {
  const t = d.launcher?.tracks[id];
  if (!t) return;
  if (laneId && d.playlist.lanes[laneId]) t.laneId = laneId;
  else delete t.laneId;
}

export function setLauncherQuantize(d: Draft<Project>, q: LaunchQuantize): void {
  if ((LAUNCH_QUANTIZES as readonly string[]).includes(q)) ensureLauncher(d).quantize = q;
}

/** Puts something in a slot (replacing what was there, keeping the slot's mode, loop, quantize and follow settings when it already existed). */
export function setSlotContent(d: Draft<Project>, trackId: LaunchTrackId, sceneId: SceneId, content: LaunchContent): boolean {
  const l = d.launcher;
  const t = l?.tracks[trackId];
  if (!l || !t || !l.scenes[sceneId]) return false;
  const old = t.slots[sceneId];
  if (old) {
    old.content = content as Draft<LaunchContent>;
    delete old.name;
    delete old.color;
  } else t.slots[sceneId] = { content: content as Draft<LaunchContent> } as Draft<LaunchSlot>;
  return true;
}

export function clearSlot(d: Draft<Project>, trackId: LaunchTrackId, sceneId: SceneId): void {
  const t = d.launcher?.tracks[trackId];
  if (t) delete t.slots[sceneId];
}

export interface SlotPatch {
  name?: string | null;
  color?: string | null;
  mode?: LaunchMode | null;
  loop?: boolean | null;
  quantize?: LaunchQuantize | null;
  follow?: FollowAction | null;
}

/** Changes a slot's settings; null puts a setting back to its default. */
export function patchSlot(d: Draft<Project>, trackId: LaunchTrackId, sceneId: SceneId, patch: SlotPatch): boolean {
  const s = d.launcher?.tracks[trackId]?.slots[sceneId];
  if (!s) return false;
  if (patch.name !== undefined) {
    if (patch.name === null || !patch.name.trim()) delete s.name;
    else s.name = patch.name.trim().slice(0, MAX_NAME);
  }
  if (patch.color !== undefined) {
    if (patch.color && /^#[0-9a-f]{6}$/i.test(patch.color)) s.color = patch.color;
    else delete s.color;
  }
  if (patch.mode !== undefined) {
    if (patch.mode && (LAUNCH_MODES as readonly string[]).includes(patch.mode) && patch.mode !== 'trigger') s.mode = patch.mode;
    else delete s.mode;
  }
  if (patch.loop !== undefined) {
    if (patch.loop === false) s.loop = false;
    else delete s.loop;
  }
  if (patch.quantize !== undefined) {
    if (patch.quantize && (LAUNCH_QUANTIZES as readonly string[]).includes(patch.quantize)) s.quantize = patch.quantize;
    else delete s.quantize;
  }
  if (patch.follow !== undefined) {
    const f = patch.follow;
    if (f && (FOLLOW_KINDS as readonly string[]).includes(f.kind) && Number.isFinite(f.bars))
      s.follow = { kind: f.kind, bars: Math.max(1, Math.min(64, Math.round(f.bars))) };
    else delete s.follow;
  }
  return true;
}

/** Moves a slot to another place (swapping when the place is taken); `copy` leaves the original. */
export function moveSlot(
  d: Draft<Project>,
  from: { trackId: LaunchTrackId; sceneId: SceneId },
  to: { trackId: LaunchTrackId; sceneId: SceneId },
  copy = false,
): boolean {
  const l = d.launcher;
  const src = l?.tracks[from.trackId]?.slots[from.sceneId];
  const dstTrack = l?.tracks[to.trackId];
  if (!l || !src || !dstTrack || !l.scenes[to.sceneId]) return false;
  if (from.trackId === to.trackId && from.sceneId === to.sceneId) return false;
  const moved = JSON.parse(JSON.stringify(src)) as LaunchSlot;
  const displaced = dstTrack.slots[to.sceneId] ? (JSON.parse(JSON.stringify(dstTrack.slots[to.sceneId])) as LaunchSlot) : null;
  dstTrack.slots[to.sceneId] = moved as Draft<LaunchSlot>;
  if (!copy) {
    const srcTrack = l.tracks[from.trackId]!;
    if (displaced) srcTrack.slots[from.sceneId] = displaced as Draft<LaunchSlot>;
    else delete srcTrack.slots[from.sceneId];
  }
  return true;
}

/**
 * Drops what no longer exists: slots whose pattern or channel is gone and links to deleted playlist tracks.
 * Called by the ops that delete patterns, channels and lanes so undo brings it all back together.
 */
export function pruneLauncher(d: Draft<Project>): void {
  const l = d.launcher;
  if (!l) return;
  const p = d as unknown as Project;
  for (const t of Object.values(l.tracks)) {
    for (const [sceneId, slot] of Object.entries(t.slots)) {
      if (!contentExists(p, slot.content as LaunchContent)) delete t.slots[sceneId as SceneId];
    }
    if (t.laneId && !d.playlist.lanes[t.laneId]) delete t.laneId;
  }
}

/** The launcher content for a pattern. */
export const patternContent = (patternId: PatternId): LaunchContent => ({ kind: 'pattern', patternId });

/** The launcher content for a playlist audio clip (its channel's sample, its trim, gain and fades). */
export function contentFromAudioClip(clip: AudioClip): LaunchContent {
  return {
    kind: 'audio',
    channelId: clip.channelId,
    offsetSec: clip.offsetSec,
    length: Math.max(1, Math.round(clip.length)),
    ...(clip.gain !== undefined ? { gain: clip.gain } : {}),
    ...(clip.fadeIn !== undefined ? { fadeIn: clip.fadeIn } : {}),
    ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
  };
}

/**
 * The launcher content for a whole audio clip channel: its sample from the start. The length is the sample's
 * own, at the tempo it was recorded at when the channel follows the song tempo, else at the song's tempo.
 * Null when the channel is not an audio clip or its length is not known.
 */
export function contentFromAudioChannel(p: Project, channelId: ChannelId): LaunchContent | null {
  const ch = p.channels[channelId];
  if (ch?.kind !== 'audioClip') return null;
  const dur = p.samples[ch.sampleId]?.durationSec;
  if (!dur || !(dur > 0)) return null;
  const mode = playbackMode(ch);
  const bpm = followsTempo(mode) && mode.sourceBpm ? mode.sourceBpm : p.transport.bpm;
  const ticks = Math.max(1, Math.round((dur * bpm * PPQ) / 60 / mode.pitch));
  return { kind: 'audio', channelId, offsetSec: 0, length: ticks };
}
