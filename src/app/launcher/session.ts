/**
 * The clip launcher while it plays: presses (launch a slot or scene, stop a track), the performance record, and
 * the clock it all runs on. Live launch state is session state, like the DJ decks: never saved, never undoable.
 * Only what the musician writes down (the grid, "Record performance to playlist") goes through History.
 *
 * One `LauncherSession` per services object. It owns the `LaunchSequencer` (core/launcher) and hands it to the
 * engine, which plays its runs in time with the transport and asks it to advance on every scheduler tick.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { History } from '@core/history/history';
import { slotOf } from '@core/launcher/grid';
import { writePerformance } from '@core/launcher/perform';
import type { LaunchClock, LaunchRun, SlotPlayState } from '@core/launcher/run';
import { LaunchSequencer, type PerformanceTake } from '@core/launcher/sequencer';
import type { LaunchTrackId, Project, SceneId } from '@core/model/types';
import { LAUNCH_PAD_SIZE, type LaunchPageDir } from '@core/midi-map/targets';
import type { EngineApi } from '@engine/api';
import type { DocStore } from '../stores/doc';

/** The look of a pad on a controller. */
export type PadState = 'empty' | 'loaded' | 'queued' | 'playing';

export interface LauncherSessionState {
  /** A performance record is on (it ends at a bar line, then the playlist gets the clips). */
  recording: boolean;
  /** The slot the keyboard acts on (0-based track and scene). */
  cursor: { track: number; scene: number };
  /**
   * Which 8 × 8 page of the grid the controller pads show and press (0-based page numbers: tracks across, scenes down).
   * View state, not the project; a page that no longer exists (the grid shrank) counts as the last one (`padPage`).
   */
  page: { track: number; scene: number };
}

export interface LauncherDeps {
  engine: EngineApi;
  doc: DocStore;
  history: History;
  toast(message: string, kind?: 'error'): void;
  /** Called with the clips a record wrote (to select them, to show the playlist). */
  onRecorded?(clips: readonly string[], take: PerformanceTake): void;
}

const IDLE_CLOCK: LaunchClock = { playing: false, heardU: 0, earliestU: 0 };

export class LauncherSession {
  readonly seq: LaunchSequencer;
  readonly store: StoreApi<LauncherSessionState> = createStore<LauncherSessionState>(() => ({
    recording: false,
    cursor: { track: 0, scene: 0 },
    page: { track: 0, scene: 0 },
  }));
  private readonly listeners = new Set<() => void>();
  /** The runs the last listener call saw (a change is reported once). */
  private seen: readonly LaunchRun[] = [];

  constructor(private readonly deps: LauncherDeps) {
    this.seq = new LaunchSequencer({
      project: () => this.project,
      onTake: (take) => this.write(take),
    });
    deps.engine.setLauncher?.(this.seq);
    // The transport stopping ends every run (the engine tells the sequencer); the window and the LEDs hear of it here.
    deps.engine.subscribe(() => {
      if (this.store.getState().recording && !this.seq.recording) this.store.setState({ recording: false });
      this.changed();
    });
  }

  get project(): Project {
    return this.deps.doc.getState().project;
  }

  /** Where the transport is, in launcher ticks (all zero while nothing plays). */
  clock(): LaunchClock {
    return this.deps.engine.launcherClock?.() ?? IDLE_CLOCK;
  }

  get runs(): readonly LaunchRun[] {
    return this.seq.runs;
  }

  /** What a slot is doing right now. */
  stateOf(trackId: LaunchTrackId, sceneId: SceneId, heardU = this.clock().heardU): { state: SlotPlayState; run: LaunchRun | null } {
    return this.seq.stateOf(trackId, sceneId, heardU);
  }

  // ---- the controller pads: an 8 × 8 page of the grid ------------------------------------------

  /** The page the pads are on (page numbers), kept inside the grid. */
  padPage(): { track: number; scene: number } {
    const l = this.project.launcher;
    const p = this.store.getState().page;
    const last = (n: number) => Math.max(0, Math.ceil(n / LAUNCH_PAD_SIZE) - 1);
    return { track: Math.min(p.track, last(l?.trackOrder.length ?? 0)), scene: Math.min(p.scene, last(l?.sceneOrder.length ?? 0)) };
  }

  /** How many pages the grid has: tracks across, scenes down (at least 1 each). */
  padPages(): { tracks: number; scenes: number } {
    const l = this.project.launcher;
    const n = (len: number) => Math.max(1, Math.ceil(len / LAUNCH_PAD_SIZE));
    return { tracks: n(l?.trackOrder.length ?? 0), scenes: n(l?.sceneOrder.length ?? 0) };
  }

  /** Moves the pads one page (left/right over the tracks, up/down over the scenes); false at the edge of the grid. */
  movePage(dir: LaunchPageDir): boolean {
    const cur = this.padPage();
    const pages = this.padPages();
    const next = { ...cur };
    if (dir === 'left') next.track--;
    else if (dir === 'right') next.track++;
    else if (dir === 'up') next.scene--;
    else next.scene++;
    if (next.track < 0 || next.scene < 0 || next.track >= pages.tracks || next.scene >= pages.scenes) return false;
    this.store.setState({ page: next });
    // The lights show the new page at once.
    this.force = true;
    this.changed();
    return true;
  }

  /** Back to the first page (the pads show tracks and scenes 1–8). */
  homePage(): void {
    const stored = this.store.getState().page;
    if (stored.track === 0 && stored.scene === 0) return;
    this.store.setState({ page: { track: 0, scene: 0 } });
    this.force = true;
    this.changed();
  }

  /** Grid positions (0-based) of the pad at 0-based pad positions of the current page. */
  private padAbs(track: number, scene: number): { track: number; scene: number } {
    const p = this.padPage();
    return { track: p.track * LAUNCH_PAD_SIZE + track, scene: p.scene * LAUNCH_PAD_SIZE + scene };
  }

  /** A pad of the current page was pressed (`down`) or let go: the slot under it, by its mode. */
  padPress(track: number, scene: number, down = true): void {
    const a = this.padAbs(track, scene);
    this.pressAt(a.track, a.scene, down);
  }

  /** The scene button of a row of the current page. */
  padScene(scene: number): void {
    this.launchSceneAt(this.padAbs(0, scene).scene);
  }

  /** The stop button of a column of the current page. */
  padStop(track: number): void {
    this.stopTrackAt(this.padAbs(track, 0).track);
  }

  /** The pad colour state of the pad at 0-based positions of the current page. */
  padState(track: number, scene: number, heardU = this.clock().heardU): PadState {
    const a = this.padAbs(track, scene);
    return this.slotPadState(a.track, a.scene, heardU);
  }

  /** The pad colour state of the slot at 0-based grid positions. */
  private slotPadState(track: number, scene: number, heardU: number): PadState {
    const l = this.project.launcher;
    const t = l?.trackOrder[track];
    const s = l?.sceneOrder[scene];
    if (!l || !t || !s || !slotOf(l, t, s)) return 'empty';
    const { state } = this.seq.stateOf(t, s, heardU);
    return state === 'playing' ? 'playing' : state === 'queued' || state === 'stopping' ? 'queued' : 'loaded';
  }

  /** A scene button's light: playing when its row plays, queued when a slot of it waits, loaded when it has slots. */
  sceneState(row: number, heardU = this.clock().heardU): PadState {
    const l = this.project.launcher;
    const id = l?.sceneOrder[this.padAbs(0, row).scene];
    if (!l || !id) return 'empty';
    let any = false;
    let queued = false;
    let playing = 0;
    let total = 0;
    for (const t of l.trackOrder) {
      if (!l.tracks[t]?.slots[id]) continue;
      any = true;
      total++;
      const st = this.seq.stateOf(t, id, heardU).state;
      if (st === 'queued') queued = true;
      if (st === 'playing') playing++;
    }
    return !any ? 'empty' : queued ? 'queued' : playing === total ? 'playing' : 'loaded';
  }

  /** Called when what the launcher does changed (a press, the transport stopped). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    if (this.seq.runs === this.seen && !this.force) return;
    this.force = false;
    this.seen = this.seq.runs;
    for (const fn of this.listeners) fn();
  }
  private force = false;

  /** After a press: the engine plays the new runs (and starts the transport for the launcher alone if nothing plays). */
  private pushed(): void {
    this.deps.engine.launcherChanged?.();
    this.force = true;
    this.changed();
  }

  // ---- presses --------------------------------------------------------------------------------

  /** A press on a slot: the slot's mode decides what it does. */
  press(trackId: LaunchTrackId, sceneId: SceneId): void {
    const before = this.seq.runs;
    this.seq.launch(trackId, sceneId, this.clock());
    if (this.seq.runs !== before) this.pushed();
  }

  /** The pad let go (a gate slot stops). */
  release(trackId: LaunchTrackId, sceneId: SceneId): void {
    const before = this.seq.runs;
    this.seq.release(trackId, sceneId, this.clock());
    if (this.seq.runs !== before) this.pushed();
  }

  launchScene(sceneId: SceneId): void {
    const before = this.seq.runs;
    this.seq.launchScene(sceneId, this.clock());
    if (this.seq.runs !== before) this.pushed();
  }

  stopTrack(trackId: LaunchTrackId, now = false): void {
    const before = this.seq.runs;
    this.seq.stopTrack(trackId, this.clock(), now);
    if (this.seq.runs !== before) this.pushed();
  }

  stopAll(now = false): void {
    const before = this.seq.runs;
    this.seq.stopAll(this.clock(), now);
    if (this.seq.runs !== before) this.pushed();
  }

  // ---- by position (controllers, the keyboard, the AI) ----------------------------------------

  trackAt(index: number): LaunchTrackId | undefined {
    return this.project.launcher?.trackOrder[index];
  }

  sceneAt(index: number): SceneId | undefined {
    return this.project.launcher?.sceneOrder[index];
  }

  /** 0-based grid positions; an empty position does nothing. */
  pressAt(track: number, scene: number, down = true): void {
    const t = this.trackAt(track);
    const s = this.sceneAt(scene);
    if (!t || !s) return;
    if (down) this.press(t, s);
    else this.release(t, s);
  }

  launchSceneAt(scene: number): void {
    const s = this.sceneAt(scene);
    if (s) this.launchScene(s);
  }

  stopTrackAt(track: number): void {
    const t = this.trackAt(track);
    if (t) this.stopTrack(t);
  }

  setCursor(track: number, scene: number): void {
    const l = this.project.launcher;
    if (!l) return;
    const c = {
      track: Math.max(0, Math.min(l.trackOrder.length - 1, track)),
      scene: Math.max(0, Math.min(l.sceneOrder.length - 1, scene)),
    };
    const cur = this.store.getState().cursor;
    if (cur.track !== c.track || cur.scene !== c.scene) this.store.setState({ cursor: c });
  }

  // ---- the performance record -----------------------------------------------------------------

  /** Starts keeping what is launched; it begins at the next bar line (or with the first launch when nothing plays). */
  startRecording(): void {
    if (this.seq.recording) return;
    this.seq.startRecording(this.clock());
    this.store.setState({ recording: true });
    this.deps.toast('Recording your performance: launch slots, then press Record again to put it on the playlist.');
  }

  /** Ends the record at the next bar line; the clips go on the playlist when the music gets there. */
  stopRecording(): void {
    if (!this.seq.recording) return;
    this.seq.stopRecording(this.clock());
    // Nothing playing: the record is over at once (nothing to write).
    if (!this.seq.recording) this.store.setState({ recording: false });
  }

  toggleRecording(): void {
    if (this.seq.recording) this.stopRecording();
    else this.startRecording();
  }

  /** The record ended: the playlist gets what was played, in one undo step. */
  private write(take: PerformanceTake): void {
    let written: ReturnType<typeof writePerformance> | null = null;
    this.deps.history.transact('Record performance to playlist', (d) => {
      written = writePerformance(d, take);
    });
    const w = written as ReturnType<typeof writePerformance> | null;
    this.store.setState({ recording: false });
    if (!w || w.clips.length === 0) return;
    this.deps.toast(
      `Recorded ${w.clips.length} clip${w.clips.length === 1 ? '' : 's'} on ${w.lanes.length} playlist track${w.lanes.length === 1 ? '' : 's'}. Undo takes them back.`,
    );
    this.deps.onRecorded?.(w.clips, take);
  }
}
