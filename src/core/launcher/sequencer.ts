/**
 * The clip launcher's brain: turns presses (launch a slot, a scene, stop a track) into runs on the launcher axis
 * (see run.ts), with quantized starts and stops. Pure: it knows the project and, per call, a `LaunchClock`; the
 * engine plays what `runs` says and calls `advance` on every scheduler tick.
 *
 * - One slot plays per track: launching another replaces it at the boundary (the playing one is cut there, a
 *   queued one is dropped).
 * - Modes: trigger (a press while it plays does nothing), toggle (a second press stops it), gate (release stops
 *   it), retrigger (every press restarts it).
 * - Quantize: a slot's own, else the grid's. Boundaries are multiples of the quantize on the axis; a launch
 *   while nothing runs starts at once (and the engine starts the transport for it).
 * - Follow actions: after `bars` bars a slot stops, or hands over to the next slot of its track or a random one.
 *   The hand-over is scheduled a bar ahead, so a press in between still wins.
 * - Performance record: while on, the runs are kept and written to the playlist when it ends (`onTake`).
 */
import { contentLength, quantizeTicks, slotLabel, slotColor, slotLoops, slotMode, slotOf, slotQuantize } from './grid';
import { ticksPerBar } from '../time/ppq';
import type { LaunchQuantize, LaunchSlot, LaunchTrackId, Project, SceneId } from '../model/types';
import { QUANTIZE_ORDER } from './quantize-order';
import type { LaunchClock, LaunchDriver, LaunchRun } from './run';
import { slotStateAt } from './run';

/** A run as it played, for writing a jam to the playlist. */
export interface PerformanceEntry {
  trackId: LaunchTrackId;
  sceneId: SceneId;
  content: LaunchRun['content'];
  loop: boolean;
  passLength: number;
  /** Launcher ticks, clipped to the recording. */
  startU: number;
  endU: number;
  /** Where in its content it was at `startU` (a run that was already playing when recording began). */
  phase: number;
  laneId?: LaunchRun['laneId'];
  name: string;
  color: string;
}

export interface PerformanceTake {
  startU: number;
  endU: number;
  entries: PerformanceEntry[];
}

export interface SequencerDeps {
  project(): Project;
  /** 0 ≤ x < 1 (default Math.random); tests pass a seeded one. */
  random?(): number;
  /** A performance record ended: here is what played. */
  onTake?(take: PerformanceTake): void;
}

/** Ended runs kept for recording (oldest dropped). */
const HISTORY_MAX = 4096;

export class LaunchSequencer implements LaunchDriver {
  runs: readonly LaunchRun[] = [];
  /** Ended runs (pruned from `runs`), oldest first. */
  private history: LaunchRun[] = [];
  private seq = 0;
  /** Runs whose follow action has been carried out. */
  private readonly followed = new Set<string>();
  private rec: { startU: number; endU: number | null } | null = null;
  /** The newest heard tick seen (a record that ends with the transport ends here). */
  private lastU = 0;
  onTake: ((take: PerformanceTake) => void) | undefined;

  constructor(private readonly deps: SequencerDeps) {
    this.onTake = deps.onTake;
  }

  private get project(): Project {
    return this.deps.project();
  }

  private set(runs: readonly LaunchRun[]): void {
    this.runs = runs;
  }

  // ---- reading ------------------------------------------------------------------------------

  /** What a slot is doing at `heardU`. */
  stateOf(trackId: LaunchTrackId, sceneId: SceneId, heardU: number) {
    const p = this.project;
    return slotStateAt(this.runs, trackId, sceneId, heardU, !!slotOf(p.launcher, trackId, sceneId));
  }

  /** The run playing (or about to play) on a track at `heardU`, if any. */
  currentRun(trackId: LaunchTrackId, heardU: number): LaunchRun | null {
    let hit: LaunchRun | null = null;
    for (const r of this.runs) {
      if (r.trackId !== trackId || (r.endU !== null && r.endU <= heardU)) continue;
      if (!hit || r.startU >= hit.startU) hit = r;
    }
    return hit;
  }

  idleAt(heardU: number): boolean {
    return this.runs.every((r) => r.endU !== null && r.endU <= heardU);
  }

  get recording(): boolean {
    return this.rec !== null;
  }

  // ---- boundaries ----------------------------------------------------------------------------

  /** The tick a launch or stop made now happens at, for a quantize. */
  boundary(q: LaunchQuantize, clock: LaunchClock): number {
    if (!clock.playing) return 0;
    const g = quantizeTicks(q, this.project.transport.timeSig);
    const earliest = Math.ceil(clock.earliestU);
    if (g === 0) return earliest;
    let b = Math.ceil(clock.heardU / g - 1e-9) * g;
    if (b < earliest) b += Math.ceil((earliest - b) / g - 1e-9) * g;
    return b;
  }

  // ---- presses ------------------------------------------------------------------------------

  /**
   * A press on a slot, by its mode. Returns the tick it starts at, or null when nothing was launched (an empty or
   * broken slot, a trigger press on a slot that already plays, a toggle press that stopped it).
   */
  launch(trackId: LaunchTrackId, sceneId: SceneId, clock: LaunchClock): number | null {
    const p = this.project;
    const l = p.launcher;
    const slot = slotOf(l, trackId, sceneId);
    if (!l || !slot) return null;
    const earliest = clock.earliestU;
    const mine = this.runs.filter((r) => r.trackId === trackId && r.sceneId === sceneId && (r.endU === null || r.endU > earliest));
    const here = mine.length ? (mine[mine.length - 1] as LaunchRun) : null;
    switch (slotMode(slot)) {
      case 'toggle':
        if (here && here.stopU === undefined) {
          this.stopRun(here, trackId, clock, slotQuantize(l, slot));
          return null;
        }
        break;
      case 'trigger':
        if (here) {
          // Still playing or queued: nothing to do, except that a press cancels a stop that was asked for.
          if (here.stopU !== undefined && here.startU <= earliest) this.unstop(here);
          return null;
        }
        break;
      default:
        break;
    }
    return this.startRun(trackId, sceneId, slot, this.boundary(slotQuantize(l, slot), clock), clock);
  }

  /** The pad of a gate slot was let go: it stops at the next boundary. */
  release(trackId: LaunchTrackId, sceneId: SceneId, clock: LaunchClock): void {
    const l = this.project.launcher;
    const slot = slotOf(l, trackId, sceneId);
    if (!l || !slot || slotMode(slot) !== 'gate') return;
    const run = [...this.runs].reverse().find((r) => r.trackId === trackId && r.sceneId === sceneId && (r.endU === null || r.endU > clock.earliestU));
    if (run) this.stopRun(run, trackId, clock, slotQuantize(l, slot));
  }

  /** Launches a row: every track's slot in the scene starts together (at the coarsest quantize among them). */
  launchScene(sceneId: SceneId, clock: LaunchClock): number | null {
    const l = this.project.launcher;
    if (!l?.scenes[sceneId]) return null;
    const slots: { trackId: LaunchTrackId; slot: LaunchSlot }[] = [];
    for (const trackId of l.trackOrder) {
      const slot = l.tracks[trackId]?.slots[sceneId];
      if (slot) slots.push({ trackId, slot });
    }
    if (!slots.length) return null;
    const q = slots.map((s) => slotQuantize(l, s.slot)).reduce((a, b) => (QUANTIZE_ORDER.indexOf(b) > QUANTIZE_ORDER.indexOf(a) ? b : a));
    const at = this.boundary(q, clock);
    let any = false;
    for (const { trackId, slot } of slots) any = this.startRun(trackId, sceneId, slot, at, clock) !== null || any;
    return any ? at : null;
  }

  /** Stops what a track plays (at its slot's quantize), and drops what was queued on it. */
  stopTrack(trackId: LaunchTrackId, clock: LaunchClock, now = false): void {
    const l = this.project.launcher;
    if (!l?.tracks[trackId]) return;
    const earliest = clock.earliestU;
    let runs = this.runs.filter((r) => !(r.trackId === trackId && r.startU > earliest));
    const cur = [...runs].reverse().find((r) => r.trackId === trackId && (r.endU === null || r.endU > earliest));
    if (cur) {
      const slot = slotOf(l, cur.trackId, cur.sceneId);
      const at = this.boundary(now ? 'none' : slot ? slotQuantize(l, slot) : l.quantize, clock);
      runs = runs.map((r) => (r === cur ? cut(r, at, true) : r));
    }
    this.set(runs);
  }

  /** Stops every track at the grid's quantize (or at once). */
  stopAll(clock: LaunchClock, now = false): void {
    const l = this.project.launcher;
    if (!l) return;
    const at = this.boundary(now ? 'none' : l.quantize, clock);
    const earliest = clock.earliestU;
    this.set(
      this.runs
        .filter((r) => r.startU <= earliest)
        .map((r) => (r.endU === null || r.endU > at ? cut(r, at, true) : r)),
    );
  }

  /** Forgets every run (the transport stopped). A record in progress ends where the music did. */
  reset(): void {
    this.endRecording(this.lastU);
    this.history.push(...this.runs);
    this.trimHistory();
    this.followed.clear();
    this.set([]);
  }

  // ---- the heartbeat ------------------------------------------------------------------------

  /** Follow actions, ended runs, the end of a performance record. */
  advance(clock: LaunchClock): void {
    this.lastU = Math.max(this.lastU, clock.heardU);
    const l = this.project.launcher;
    const bar = ticksPerBar(this.project.transport.timeSig);
    if (l) {
      for (const run of this.runs) {
        if (!run.follow || this.followed.has(run.id) || run.follow.kind === 'stop') continue;
        const followU = run.startU + run.follow.bars * bar;
        if (followU - clock.earliestU > bar) continue;
        this.followed.add(run.id);
        const track = l.tracks[run.trackId];
        // Something else is already coming (a press queued another slot): that one wins.
        const queued = this.runs.some((r) => r.trackId === run.trackId && r.startU > clock.earliestU);
        if (!track || queued || (run.endU !== null && run.endU < followU) || followU <= clock.earliestU) continue;
        const next = this.followTarget(run, l.sceneOrder);
        if (next) this.startRun(run.trackId, next.sceneId, next.slot, followU, clock);
      }
    }
    // Ended long enough ago that nothing of them is left to play: into the history.
    const gone = this.runs.filter((r) => r.endU !== null && r.endU < clock.earliestU - 2 * bar);
    if (gone.length) {
      this.history.push(...gone);
      this.trimHistory();
      for (const r of gone) this.followed.delete(r.id);
      this.set(this.runs.filter((r) => !gone.includes(r)));
    }
    if (this.rec?.endU != null && clock.heardU >= this.rec.endU) this.endRecording(this.rec.endU);
  }

  // ---- the performance record -----------------------------------------------------------------

  /** Starts keeping what is launched, from the next bar (from tick 0 when nothing plays: the first launch starts it). */
  startRecording(clock: LaunchClock): void {
    this.rec = { startU: clock.playing ? this.boundary('bar', clock) : 0, endU: null };
  }

  /** Ends the record at the next bar; `onTake` gets what played once the music gets there. */
  stopRecording(clock: LaunchClock): void {
    if (!this.rec) return;
    if (!clock.playing) {
      this.rec = null;
      return;
    }
    this.rec.endU = Math.max(this.boundary('bar', clock), this.rec.startU);
  }

  /** What was launched so far in the record, without ending it (for tests and the status line). */
  peekTake(endU: number): PerformanceTake | null {
    return this.rec ? this.take(this.rec.startU, endU) : null;
  }

  private endRecording(endU: number): void {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    const take = this.take(rec.startU, Math.max(endU, rec.startU));
    if (take.entries.length) this.onTake?.(take);
  }

  private take(startU: number, endU: number): PerformanceTake {
    const entries: PerformanceEntry[] = [];
    for (const r of [...this.history, ...this.runs]) {
      const end = Math.min(r.endU ?? endU, endU);
      const start = Math.max(r.startU, startU);
      if (end - start < 1) continue;
      entries.push({
        trackId: r.trackId,
        sceneId: r.sceneId,
        content: r.content,
        loop: r.loop,
        passLength: r.passLength,
        startU: start,
        endU: end,
        phase: r.loop && r.passLength > 0 ? (start - r.startU) % r.passLength : Math.max(0, start - r.startU),
        ...(r.laneId ? { laneId: r.laneId } : {}),
        name: r.name,
        color: r.color,
      });
    }
    entries.sort((a, b) => a.startU - b.startU);
    return { startU, endU, entries };
  }

  // ---- internals ------------------------------------------------------------------------------

  private trimHistory(): void {
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
  }

  /** The slot a follow action hands over to. */
  private followTarget(run: LaunchRun, sceneOrder: readonly SceneId[]): { sceneId: SceneId; slot: LaunchSlot } | null {
    const p = this.project;
    const l = p.launcher;
    const track = l?.tracks[run.trackId];
    if (!l || !track || !run.follow) return null;
    const filled = sceneOrder.flatMap((sceneId) => {
      const slot = track.slots[sceneId];
      return slot && contentLength(p, slot.content) > 0 ? [{ sceneId, slot }] : [];
    });
    if (!filled.length) return null;
    if (run.follow.kind === 'next') {
      const from = sceneOrder.indexOf(run.sceneId);
      for (let i = 1; i <= sceneOrder.length; i++) {
        const sceneId = sceneOrder[(from + i) % sceneOrder.length] as SceneId;
        const hit = filled.find((f) => f.sceneId === sceneId);
        if (hit) return hit;
      }
      return null;
    }
    const others = filled.filter((f) => f.sceneId !== run.sceneId);
    const pool = others.length ? others : filled;
    const rnd = this.deps.random ?? Math.random;
    return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))] ?? null;
  }

  private unstop(run: LaunchRun): void {
    const natural = run.loop ? null : run.startU + run.passLength;
    const follow = run.follow?.kind === 'stop' ? run.startU + run.follow.bars * ticksPerBar(this.project.transport.timeSig) : null;
    const end = natural === null ? follow : follow === null ? natural : Math.min(natural, follow);
    const back: LaunchRun = { ...run, endU: end };
    delete back.stopU;
    this.set(this.runs.map((r) => (r === run ? back : r)));
  }

  private stopRun(run: LaunchRun, trackId: LaunchTrackId, clock: LaunchClock, q: LaunchQuantize): void {
    const at = this.boundary(q, clock);
    // Queued, not started: just forget it.
    if (run.startU > clock.earliestU) {
      this.set(this.runs.filter((r) => r !== run));
      return;
    }
    this.set(this.runs.filter((r) => !(r.trackId === trackId && r.startU > clock.earliestU)).map((r) => (r === run ? cut(r, at, true) : r)));
  }

  /** Makes the run of a slot start at `startU`, replacing what the track plays from there. Null when the slot has nothing to play. */
  private startRun(trackId: LaunchTrackId, sceneId: SceneId, slot: LaunchSlot, startU: number, clock: LaunchClock): number | null {
    const p = this.project;
    const track = p.launcher?.tracks[trackId];
    const pass = contentLength(p, slot.content);
    if (!track || pass <= 0) return null;
    const earliest = clock.earliestU;
    const loop = slotLoops(slot);
    const bar = ticksPerBar(p.transport.timeSig);
    let end: number | null = loop ? null : startU + pass;
    if (slot.follow?.kind === 'stop') end = Math.min(end ?? Infinity, startU + slot.follow.bars * bar);
    const run: LaunchRun = {
      id: `run_${++this.seq}`,
      trackId,
      sceneId,
      content: JSON.parse(JSON.stringify(slot.content)) as LaunchRun['content'],
      passLength: pass,
      loop,
      startU,
      endU: end,
      ...(track.laneId && p.playlist.lanes[track.laneId] ? { laneId: track.laneId } : {}),
      name: slotLabel(p, slot),
      color: slotColor(p, slot, track),
      ...(slot.follow ? { follow: { ...slot.follow } } : {}),
    };
    // Queued runs of the track are replaced; the one playing is cut where this one starts.
    const kept = this.runs
      .filter((r) => !(r.trackId === trackId && (r.startU > earliest || r.startU >= startU)))
      .map((r) => (r.trackId === trackId && (r.endU === null || r.endU > startU) ? cut(r, startU, false) : r));
    this.set([...kept, run]);
    return startU;
  }
}

/** A run ended (stopped) at `at`. */
function cut(r: LaunchRun, at: number, stop: boolean): LaunchRun {
  const endU = r.endU === null ? at : Math.min(r.endU, at);
  return { ...r, endU, ...(stop ? { stopU: endU } : {}) };
}
