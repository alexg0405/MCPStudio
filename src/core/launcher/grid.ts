/**
 * The clip launcher's grid as data: reading slots, what each one plays and how long, and the quantize grid.
 * Pure helpers shared by the sequencer, the engine, the UI and the AI.
 */
import { patternLength } from '../query/queries';
import { ticksPerBar, ticksPerBeat } from '../time/ppq';
import type {
  LaunchContent,
  LaunchMode,
  LaunchQuantize,
  LaunchSlot,
  LaunchTrack,
  LaunchTrackId,
  Launcher,
  Project,
  SceneId,
  TimeSignature,
  Tick,
} from '../model/types';
import { LAUNCH_MODES, LAUNCH_QUANTIZES } from '../model/types';

export const DEFAULT_LAUNCH_QUANTIZE: LaunchQuantize = 'bar';
/** The grid made the first time a slot is filled: 8 tracks × 8 scenes, like a pad controller. */
export const DEFAULT_TRACKS = 8;
export const DEFAULT_SCENES = 8;
export const MAX_TRACKS = 32;
export const MAX_SCENES = 64;

export const QUANTIZE_LABELS: Readonly<Record<LaunchQuantize, string>> = {
  none: 'Immediately',
  beat: '1 beat',
  bar: '1 bar',
  '2bars': '2 bars',
  '4bars': '4 bars',
};

export const MODE_LABELS: Readonly<Record<LaunchMode, string>> = {
  trigger: 'Trigger',
  toggle: 'Toggle',
  gate: 'Gate',
  retrigger: 'Retrigger',
};

export const MODE_HINTS: Readonly<Record<LaunchMode, string>> = {
  trigger: 'A press starts it (a press while it plays does nothing); it plays until something else replaces it',
  toggle: 'A press starts it, the next press stops it',
  gate: 'Plays only while the pad is held: letting go stops it',
  retrigger: 'Every press restarts it from its beginning',
};

/** Ticks of a quantize step in a time signature (0 = immediately). */
export function quantizeTicks(q: LaunchQuantize, ts: TimeSignature): Tick {
  switch (q) {
    case 'none':
      return 0;
    case 'beat':
      return ticksPerBeat(ts);
    case 'bar':
      return ticksPerBar(ts);
    case '2bars':
      return 2 * ticksPerBar(ts);
    case '4bars':
      return 4 * ticksPerBar(ts);
  }
}

export const isLaunchQuantize = (v: unknown): v is LaunchQuantize => (LAUNCH_QUANTIZES as readonly unknown[]).includes(v);
export const isLaunchMode = (v: unknown): v is LaunchMode => (LAUNCH_MODES as readonly unknown[]).includes(v);

export const slotMode = (s: LaunchSlot): LaunchMode => s.mode ?? 'trigger';
export const slotLoops = (s: LaunchSlot): boolean => s.loop !== false;
export const slotQuantize = (l: Launcher, s: LaunchSlot): LaunchQuantize => s.quantize ?? l.quantize;

/** The slot at 0-based (track, scene) positions of the grid. */
export function slotAt(l: Launcher | undefined, trackIndex: number, sceneIndex: number): LaunchSlot | undefined {
  if (!l) return undefined;
  const t = l.tracks[l.trackOrder[trackIndex] as LaunchTrackId];
  const sc = l.sceneOrder[sceneIndex];
  return t && sc ? t.slots[sc] : undefined;
}

export function slotOf(l: Launcher | undefined, trackId: LaunchTrackId, sceneId: SceneId): LaunchSlot | undefined {
  return l?.tracks[trackId]?.slots[sceneId];
}

/** Length of one pass of what a slot plays, in ticks (0 when the pattern or channel is gone). */
export function contentLength(p: Project, c: LaunchContent): Tick {
  if (c.kind === 'pattern') {
    const pat = p.patterns[c.patternId];
    return pat ? patternLength(pat, p.transport.timeSig) : 0;
  }
  return p.channels[c.channelId]?.kind === 'audioClip' ? Math.max(0, Math.round(c.length)) : 0;
}

/** True when what the slot points at still exists. */
export const contentExists = (p: Project, c: LaunchContent): boolean => contentLength(p, c) > 0;

/** What a slot is called: its own name, else the pattern's or channel's. */
export function slotLabel(p: Project, s: LaunchSlot): string {
  if (s.name) return s.name;
  if (s.content.kind === 'pattern') return p.patterns[s.content.patternId]?.name ?? 'Missing pattern';
  return p.channels[s.content.channelId]?.name ?? 'Missing audio';
}

/** A slot's colour: its own, else the pattern's, else the channel's, else the track's. */
export function slotColor(p: Project, s: LaunchSlot, track?: LaunchTrack): string {
  if (s.color) return s.color;
  if (s.content.kind === 'pattern') return p.patterns[s.content.patternId]?.color ?? track?.color ?? '#5f8fbf';
  return p.channels[s.content.channelId]?.color ?? track?.color ?? '#5f8fbf';
}

/** "track 2, scene 3" (1-based) for messages. */
export const positionName = (trackIndex: number, sceneIndex: number) => `track ${trackIndex + 1}, scene ${sceneIndex + 1}`;

export function emptyLauncher(): Launcher {
  return { quantize: DEFAULT_LAUNCH_QUANTIZE, tracks: {}, trackOrder: [], scenes: {}, sceneOrder: [] };
}

export interface FilledSlot {
  trackId: LaunchTrackId;
  sceneId: SceneId;
  slot: LaunchSlot;
  /** 0-based positions. */
  track: number;
  scene: number;
}

/** Every filled slot with its place, in row order (scene by scene, track by track). */
export function filledSlots(l: Launcher | undefined): FilledSlot[] {
  const out: FilledSlot[] = [];
  if (!l) return out;
  l.sceneOrder.forEach((sceneId, scene) => {
    l.trackOrder.forEach((trackId, track) => {
      const slot = l.tracks[trackId]?.slots[sceneId];
      if (slot) out.push({ trackId, sceneId, slot, track, scene });
    });
  });
  return out;
}
