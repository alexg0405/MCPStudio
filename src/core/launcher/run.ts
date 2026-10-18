/**
 * What the clip launcher plays right now: runs of slots on the launcher axis `u`.
 *
 * `u` is a continuous tick count that advances with the transport and never wraps: a looping song or pattern
 * jumps its own tick back, `u` keeps counting. Played from the start of a song `u` equals the song tick (so the
 * quantize grid is the song's bar grid); the launcher on its own starts at `u = 0`. Runs are session state: they
 * are never saved and never undoable.
 */
import type { FollowAction, LaneId, LaunchContent, LaunchTrackId, SceneId, Tick } from '../model/types';

export interface LaunchRun {
  id: string;
  trackId: LaunchTrackId;
  sceneId: SceneId;
  /** What the slot held when it was launched (later edits of the slot apply to the next launch). */
  content: LaunchContent;
  /** One pass of the content in ticks when it was launched. */
  passLength: Tick;
  loop: boolean;
  /** Where it starts on the launcher axis (a quantize boundary). */
  startU: number;
  /** Where it ends: null while it plays until something stops it; a one-shot ends after one pass. */
  endU: number | null;
  /** Set when a stop was asked for: where it will stop. */
  stopU?: number;
  /** The playlist track this one takes over while it plays. */
  laneId?: LaneId;
  /** For the performance record and the display. */
  name: string;
  color: string;
  follow?: FollowAction;
}

/** Where the transport is, in launcher ticks. */
export interface LaunchClock {
  /** A transport is running (the song or the launcher alone). */
  playing: boolean;
  /** The tick being heard right now. */
  heardU: number;
  /** The earliest tick a launch can still be scheduled at (the scheduler's frontier plus a margin). */
  earliestU: number;
}

/** What the engine asks of whatever decides what is playing: the sequencer (`sequencer.ts`). */
export interface LaunchDriver {
  /** The runs; the array is replaced (never changed in place) whenever they change. */
  readonly runs: readonly LaunchRun[];
  /** Called on every scheduler tick: follow actions, ended runs. */
  advance(clock: LaunchClock): void;
  /** True when nothing plays or waits to play at `heardU`. */
  idleAt(heardU: number): boolean;
  /** The transport stopped: every run is over. */
  reset?(): void;
}

export type SlotPlayState = 'empty' | 'idle' | 'queued' | 'playing' | 'stopping';

/** What the launcher is doing with one slot at `heardU`. */
export function slotStateAt(
  runs: readonly LaunchRun[],
  trackId: LaunchTrackId,
  sceneId: SceneId,
  heardU: number,
  filled: boolean,
): { state: SlotPlayState; run: LaunchRun | null } {
  if (!filled) return { state: 'empty', run: null };
  let queued: LaunchRun | null = null;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i] as LaunchRun;
    if (r.trackId !== trackId || r.sceneId !== sceneId) continue;
    if (r.endU !== null && r.endU <= heardU) continue;
    if (r.startU > heardU) {
      queued ??= r;
      continue;
    }
    return { state: r.stopU !== undefined ? 'stopping' : 'playing', run: r };
  }
  return queued ? { state: 'queued', run: queued } : { state: 'idle', run: null };
}

/** How far into its content a run is at `heardU`, 0–1 (a loop shows its current pass). */
export function runProgress(run: LaunchRun, heardU: number): number {
  const t = heardU - run.startU;
  if (t <= 0 || run.passLength <= 0) return 0;
  return run.loop ? (t % run.passLength) / run.passLength : Math.min(1, t / run.passLength);
}
