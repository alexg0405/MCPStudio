/**
 * Edits of the clip launcher's grid (the document): every one is one History step. Shared by the window, the
 * commands and the AI. Launching itself is `LauncherSession` (live state, never undoable).
 */
import { filledSlots, MAX_SCENES, MAX_TRACKS } from '@core/launcher/grid';
import { DEFAULT_CHANNEL_VOLUME, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { AudioClipChannel, ChannelId, ClipId, LaunchContent, LaunchTrackId, PatternId, Project, SampleRef, SceneId } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import {
  addScene,
  clearSlot,
  contentFromAudioChannel,
  contentFromAudioClip,
  ensureCapacity,
  ensureLauncher,
  patternContent,
  setSlotContent,
  setTrackLane,
  type SlotPatch,
  patchSlot,
} from '@core/ops/launcher';
import { importAudioFile } from '../actions/samples';
import type { Services } from '../services';

/** What a drop or a menu puts in a slot. */
export type SlotSource =
  | { kind: 'pattern'; patternId: PatternId }
  | { kind: 'clip'; clipId: ClipId }
  | { kind: 'channel'; channelId: ChannelId };

/** The content for a source, or why there is none. */
export function contentFor(p: Project, src: SlotSource): LaunchContent | string {
  if (src.kind === 'pattern') return p.patterns[src.patternId] ? patternContent(src.patternId) : 'That pattern is gone.';
  if (src.kind === 'channel') return contentFromAudioChannel(p, src.channelId) ?? 'That channel has no audio of a known length.';
  const clip = p.playlist.clips[src.clipId];
  if (!clip) return 'That clip is gone.';
  if (clip.kind === 'pattern') return patternContent(clip.patternId);
  if (clip.kind === 'audio') return contentFromAudioClip(clip);
  return 'Automation clips can’t be launched.';
}

/** Puts a pattern, a playlist clip or an audio channel into a slot (the grid is made first when there is none). */
export function putInSlot(s: Services, trackId: LaunchTrackId, sceneId: SceneId, src: SlotSource): string | null {
  const content = contentFor(s.doc.getState().project, src);
  if (typeof content === 'string') return content;
  s.history.transact('Put in launcher slot', (d) => {
    ensureLauncher(d);
    setSlotContent(d, trackId, sceneId, content);
  });
  return null;
}

/** The same, by 0-based grid position; the grid grows to reach it. */
export function putInSlotAt(s: Services, track: number, scene: number, src: SlotSource): string | null {
  const content = contentFor(s.doc.getState().project, src);
  if (typeof content === 'string') return content;
  if (track >= MAX_TRACKS || scene >= MAX_SCENES) return 'The grid is not that big.';
  s.history.transact('Put in launcher slot', (d) => {
    const l = ensureCapacity(d, track + 1, scene + 1);
    setSlotContent(d, l.trackOrder[track]!, l.sceneOrder[scene]!, content);
  });
  return null;
}

/**
 * Playlist clips dropped on a slot (a pointer drag handed over by the playlist, see ui/clip-drop.ts): the first clip
 * (in time order) goes in the slot at 0-based `track`, `scene`, the next ones in the slots below it, one undo step. Pattern
 * clips become their pattern, audio clips their sample from the clip's trim; automation clips are skipped. Slots that were
 * filled are replaced, the grid grows to reach the last one. The playlist and its tracks are left alone.
 */
export function putClipsAt(s: Services, clipIds: readonly ClipId[], track: number, scene: number): { placed: number; skipped: number } {
  const project = s.doc.getState().project;
  const clips = clipIds
    .map((id) => project.playlist.clips[id])
    .filter((c): c is NonNullable<typeof c> => !!c && c.kind !== 'automation')
    .sort((a, b) => a.start - b.start);
  const room = Math.max(0, MAX_SCENES - scene);
  const take = track >= MAX_TRACKS ? [] : clips.slice(0, room);
  if (take.length === 0) return { placed: 0, skipped: clipIds.length };
  let placed = 0;
  s.history.transact(take.length === 1 ? 'Put clip in launcher slot' : 'Put clips in launcher slots', (d) => {
    const l = ensureCapacity(d, track + 1, scene + take.length);
    take.forEach((c, i) => {
      const content = contentFor(d as unknown as Project, { kind: 'clip', clipId: c.id });
      if (typeof content === 'string') return;
      if (setSlotContent(d, l.trackOrder[track]!, l.sceneOrder[scene + i]!, content)) placed++;
    });
  });
  return { placed, skipped: clipIds.length - placed };
}

/**
 * Audio files dropped on a slot (from the computer, or dragged out of the sample browser): each is imported through the
 * sample store like any dropped file, gets an audio-clip channel (the one a playlist drop makes), and goes in a slot: the
 * first in the slot at 0-based `track`, `scene`, the next ones below it. One undo step for all of them. Returns how many
 * were placed (files that are not readable audio are reported with a toast by the import).
 */
export async function putAudioFilesAt(
  s: Services,
  files: readonly Pick<File, 'name' | 'arrayBuffer'>[] | Promise<readonly Pick<File, 'name' | 'arrayBuffer'>[]>,
  track: number,
  scene: number,
  importFile: (s: Services, f: Pick<File, 'name' | 'arrayBuffer'>) => Promise<SampleRef | null> = importAudioFile,
): Promise<number> {
  if (track >= MAX_TRACKS || scene >= MAX_SCENES) return 0;
  const refs: SampleRef[] = [];
  for (const f of (await files).slice(0, MAX_SCENES - scene)) {
    const ref = await importFile(s, f);
    if (!ref) continue;
    // A launched pass needs the sound's length.
    if (!(ref.durationSec && ref.durationSec > 0)) s.session.getState().toast(`Can't tell how long "${f.name}" is, so it can't be launched.`, 'error');
    else refs.push(ref);
  }
  if (refs.length === 0) return 0;
  let placed = 0;
  s.history.transact(refs.length === 1 ? `Put ${refs[0]!.name} in a launcher slot` : `Put ${refs.length} audio files in launcher slots`, (d) => {
    const l = ensureCapacity(d, track + 1, scene + refs.length);
    refs.forEach((ref, i) => {
      const channel: AudioClipChannel = {
        kind: 'audioClip',
        id: newId.channel(),
        name: ref.name,
        color: paletteColor(d.channelOrder.length),
        muted: false,
        solo: false,
        volume: DEFAULT_CHANNEL_VOLUME,
        pan: 0,
        output: d.mixer.order[0] ?? ('master' as AudioClipChannel['output']),
        sampleId: ref.id,
      };
      addSample(d, ref);
      addChannel(d, channel);
      const content = contentFromAudioChannel(d as unknown as Project, channel.id);
      if (content && setSlotContent(d, l.trackOrder[track]!, l.sceneOrder[scene + i]!, content)) placed++;
    });
  });
  return placed;
}

export function clearSlotAt(s: Services, trackId: LaunchTrackId, sceneId: SceneId): void {
  s.history.transact('Clear launcher slot', (d) => clearSlot(d, trackId, sceneId));
}

export function editSlot(s: Services, trackId: LaunchTrackId, sceneId: SceneId, patch: SlotPatch, label = 'Edit launcher slot'): void {
  s.history.transact(label, (d) => void patchSlot(d, trackId, sceneId, patch), { mergeKey: `launcher-slot:${trackId}:${sceneId}:${Object.keys(patch).join(',')}` });
}

/** The next empty slot in reading order (scene by scene, track by track), or null when the grid is full. */
function nextFree(p: Project, taken: ReadonlySet<string>): { track: number; scene: number } | null {
  const l = p.launcher;
  const tracks = l?.trackOrder.length ?? 8;
  const scenes = l?.sceneOrder.length ?? 8;
  const filled = new Set(filledSlots(l).map((f) => `${f.track}:${f.scene}`));
  for (let scene = 0; scene < scenes; scene++)
    for (let track = 0; track < tracks; track++) if (!filled.has(`${track}:${scene}`) && !taken.has(`${track}:${scene}`)) return { track, scene };
  return null;
}

/**
 * Puts the selected playlist clips (patterns and audio) into free slots, a clip to a slot, in the order they start.
 * Each playlist track fills its own launcher track (which takes that playlist track over while it plays).
 * Returns how many were placed and how many could not be (automation clips, no room).
 */
export function fillFromClips(s: Services, clipIds: readonly ClipId[]): { placed: number; skipped: number } {
  const project = s.doc.getState().project;
  const clips = clipIds
    .map((id) => project.playlist.clips[id])
    .filter((c): c is NonNullable<typeof c> => !!c && c.kind !== 'automation')
    .sort((a, b) => a.start - b.start);
  const skipped = clipIds.length - clips.length;
  if (!clips.length) return { placed: 0, skipped };
  let placed = 0;
  s.history.transact('Send clips to the launcher', (d) => {
    ensureLauncher(d);
    const taken = new Set<string>();
    const laneTrack = new Map<string, number>();
    for (const c of clips) {
      const content = contentFor(d as unknown as Project, { kind: 'clip', clipId: c.id });
      if (typeof content === 'string') continue;
      // The playlist track's own column when it has a free slot, else the first free one.
      let want = laneTrack.get(c.laneId);
      if (want === undefined) {
        want = laneTrack.size;
        laneTrack.set(c.laneId, want);
      }
      const l = d.launcher!;
      let at: { track: number; scene: number } | null = null;
      for (let scene = 0; scene < l.sceneOrder.length && !at; scene++)
        if (want < l.trackOrder.length && !l.tracks[l.trackOrder[want]!]!.slots[l.sceneOrder[scene]!] && !taken.has(`${want}:${scene}`)) at = { track: want, scene };
      at ??= nextFree(d as unknown as Project, taken);
      if (!at) {
        addScene(d);
        at = nextFree(d as unknown as Project, taken);
      }
      if (!at) continue;
      taken.add(`${at.track}:${at.scene}`);
      const dl = d.launcher!;
      const trackId = dl.trackOrder[at.track]!;
      setSlotContent(d, trackId, dl.sceneOrder[at.scene]!, content);
      // Sent from a playlist track: the launcher track takes that playlist track over while it plays (FL's Performance mode).
      if (!dl.tracks[trackId]!.laneId) setTrackLane(d, trackId, c.laneId);
      placed++;
    }
  });
  return { placed, skipped: skipped + (clips.length - placed) };
}

/** One pattern per scene on the first track (a quick start: Pattern 1 in scene 1, Pattern 2 in scene 2…). */
export function fillFromPatterns(s: Services): number {
  const p = s.doc.getState().project;
  let n = 0;
  s.history.transact('Put the patterns in the launcher', (d) => {
    const l = ensureCapacity(d, 1, Math.min(MAX_SCENES, p.patternOrder.length));
    p.patternOrder.slice(0, MAX_SCENES).forEach((id, i) => {
      if (setSlotContent(d, l.trackOrder[0]!, l.sceneOrder[i]!, patternContent(id))) n++;
    });
  });
  return n;
}
