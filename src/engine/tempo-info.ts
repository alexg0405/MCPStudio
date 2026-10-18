import type { TransportInfo } from '@agstudio/sdk';
import { PPQ } from '@core/time/ppq';
import type { Segment } from './sched/core';
import type { TransportObserver } from './sched/transport';

/** Tempos are rounded to this many steps per BPM (six decimals), so float noise from tick math never shows as a tempo change. */
const BPM_PRECISION = 1e6;

/** A BPM rounded the way plugins are told tempos (see BPM_PRECISION). */
export function roundBpm(bpm: number): number {
  return Math.round(bpm * BPM_PRECISION) / BPM_PRECISION;
}

/** The tempo (BPM) a planned segment of `secondsPerTick` plays at. */
export function bpmFromSecondsPerTick(secondsPerTick: number): number {
  return roundBpm(60 / (secondsPerTick * PPQ));
}

/** Reads the clock of the audio context the tempo is told against. */
interface ContextClock {
  readonly currentTime: number;
}

/**
 * Tempo as plugins see it: the tempo now, the tempo at a scheduled time (from the transport's
 * planned segments, so tempo automation is followed), and change notifications with the time the
 * new tempo starts at.
 */
export class TempoInfo implements TransportInfo {
  readonly ppq = PPQ;
  /** Set once the transport exists: seconds per tick at a context time, from its planned segments. */
  secondsPerTickAt: ((time: number) => number) | null = null;
  private readonly tempoListeners = new Set<(bpm: number, time: number) => void>();

  constructor(
    public bpm: number,
    private readonly clock: ContextClock,
  ) {}

  tempoAt(time: number): number {
    const secondsPerTick = this.secondsPerTickAt?.(time);
    return secondsPerTick ? bpmFromSecondsPerTick(secondsPerTick) : this.bpm;
  }

  onTempo(callback: (bpm: number, time: number) => void): () => void {
    this.tempoListeners.add(callback);
    return () => this.tempoListeners.delete(callback);
  }

  /** Sets the tempo and tells the listeners when it takes effect (default: now). Does nothing when it is the same. */
  setBpm(bpm: number, time = this.clock.currentTime): void {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    for (const listener of this.tempoListeners) listener(bpm, time);
  }
}

/**
 * Tells tempo-synced plugins when the tempo of the planned segments changes (tempo automation), and returns them to
 * the project's tempo when playback stops.
 */
export class TempoReporter implements TransportObserver {
  /** Seconds per tick of the last segment, or 0 before the first one of a run. */
  private lastSecondsPerTick = 0;

  constructor(
    private readonly info: TempoInfo,
    /** The project's own tempo, or null while no project is loaded. */
    private readonly projectBpm: () => number | null,
  ) {}

  started(): void {
    this.lastSecondsPerTick = 0;
  }

  segment(segment: Segment): void {
    if (segment.spt === this.lastSecondsPerTick) return;
    // The first segment of a run is the tempo the plugins already have.
    if (this.lastSecondsPerTick !== 0) this.info.setBpm(bpmFromSecondsPerTick(segment.spt), segment.time0);
    this.lastSecondsPerTick = segment.spt;
  }

  stopped(time: number): void {
    const bpm = this.projectBpm();
    if (bpm !== null) this.info.setBpm(bpm, time);
  }
}
