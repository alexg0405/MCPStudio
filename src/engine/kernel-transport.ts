/**
 * Keeps every worklet kernel's view of the song (`KernelTransport`: playing, bpm, beat position) in
 * step with the engine. A transport observer: it sends an anchor at each start, seek, re-plan, stop,
 * loop wrap and tempo change, never at the scheduler's own slices, so offline renders stay
 * bit-exact at any chunk size. Plugins created mid-song get the recent anchors replayed.
 */
import type { Tick } from '@core/model/types';
import { PPQ } from '@core/time/ppq';
import type { Segment } from './sched/core';
import type { TransportObserver } from './sched/transport';
import type { WorkletPortImpl } from './worklet-port';

interface Anchor {
  time: number;
  beat: number;
  playing: boolean;
  bpm: number;
  replan: boolean;
}

export interface KernelTransportDeps {
  readonly ports: ReadonlySet<WorkletPortImpl>;
  /** Tick and loop pass at a scheduling time (the stop position while stopped). */
  tickAt(time: number): { tick: number };
  /** The song's own tempo (what plugins get while stopped). */
  baseBpm(): number;
  now(): number;
}

const bpmOf = (spt: number) => 60 / (spt * PPQ);

export class KernelTransportFeed implements TransportObserver {
  private playing = false;
  private lastSpt = 0;
  /** Set by a start, seek or re-plan: the next segment's anchor supersedes the queued ones. */
  private replanNext = false;
  private holdBeat = 0;
  /** The latest anchors (replayed to plugins created mid-song). */
  private recent: Anchor[] = [];

  constructor(private readonly deps: KernelTransportDeps) {}

  started(_fromTick: Tick, _at: number): void {
    this.playing = true;
    this.lastSpt = 0;
    this.replanNext = true;
  }

  segment(seg: Segment, wrapped: boolean): void {
    if (!this.playing) return;
    if (this.replanNext || wrapped || seg.spt !== this.lastSpt) {
      this.send({ time: seg.time0, beat: seg.tick0 / PPQ, playing: true, bpm: bpmOf(seg.spt), replan: this.replanNext });
      this.replanNext = false;
    }
    this.lastSpt = seg.spt;
  }

  seeked(): void {
    this.lastSpt = 0;
    this.replanNext = true;
  }

  reanchored(time: number): void {
    if (!this.playing) return;
    // Re-planning restarts at `time`: what was sent for later no longer holds.
    this.lastSpt = 0;
    this.replanNext = true;
    this.recent = this.recent.filter((a) => a.time < time);
  }

  stopped(time: number): void {
    this.playing = false;
    this.holdBeat = this.deps.tickAt(time).tick / PPQ;
    this.send({ time, beat: this.holdBeat, playing: false, bpm: this.deps.baseBpm(), replan: true });
  }

  /** The song's tempo changed (while stopped, plugins still want it: synced delay times…). */
  tempoChanged(bpm: number, time: number): void {
    if (this.playing) return;
    this.send({ time, beat: this.holdBeat, playing: false, bpm, replan: true });
  }

  /** A plugin created now: tell it where the song is. */
  adopt(port: WorkletPortImpl): void {
    if (!this.playing || this.recent.length === 0) {
      port.transport(this.deps.now(), this.holdBeat, false, this.deps.baseBpm(), true);
      return;
    }
    for (const a of this.recent) port.transport(a.time, a.beat, a.playing, a.bpm, a.replan);
  }

  private send(a: Anchor): void {
    if (a.replan) this.recent = this.recent.filter((r) => r.time < a.time);
    this.recent.push(a);
    if (this.recent.length > 8) this.recent.shift();
    for (const port of this.deps.ports) port.transport(a.time, a.beat, a.playing, a.bpm, a.replan);
  }
}
