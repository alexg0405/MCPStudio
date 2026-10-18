/**
 * The playback metronome and the count-in: clicks scheduled on the engine clock, like notes (a
 * transport observer: every planned segment gets its beats), on the monitor bus (realtime only:
 * exports never hear it). Cut back whenever the transport re-plans.
 */
import { PPQ, ticksPerBar, type TempoMap } from '@core/time/ppq';
import type { TimeSignature } from '@core/model/types';
import { timeInSegment, type Segment } from './sched/core';
import type { TransportObserver } from './sched/transport';

const CLICK_SECONDS = 0.03;

function clickBuffer(ctx: BaseAudioContext, freq: number, level: number): AudioBuffer {
  const n = Math.round(CLICK_SECONDS * ctx.sampleRate);
  const buf = new AudioBuffer({ length: n, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate;
    data[i] = level * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.006) * Math.min(1, i / 16);
  }
  return buf;
}

/** Clicks on every beat while the transport plays and `enabled` is on; it also clicks the count-in before a recording. */
export class Metronome implements TransportObserver {
  enabled = false;
  private scheduled: { time: number; src: AudioBufferSourceNode }[] = [];
  private accent: AudioBuffer | null = null;
  private beat: AudioBuffer | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly timeline: () => { tempo: TempoMap; timeSig: TimeSignature } | null,
    /** The mixer's delay compensation: music scheduled at t is heard at t + latency, so clicks wait too. */
    private readonly latency: () => number = () => 0,
  ) {}

  segment(seg: Segment): void {
    if (!this.enabled) return;
    const tl = this.timeline();
    if (!tl) return;
    const step = (PPQ * 4) / tl.timeSig.den;
    const bar = ticksPerBar(tl.timeSig);
    for (let t = Math.ceil(seg.tick0 / step - 1e-9) * step; t < seg.tick1 - 1e-9; t += step) {
      this.click(timeInSegment(seg, t, tl.tempo), Math.abs(t % bar) < 1e-6);
    }
  }

  reanchored(time: number): void {
    this.cancelFrom(time);
  }

  seeked(): void {
    this.cancelFrom(this.ctx.currentTime);
  }

  stopped(time: number): void {
    this.cancelFrom(time);
  }

  /** Clicks `bars` bars of count-in from `at`; returns how long it lasts (seconds). */
  countIn(at: number, bars: number, bpm: number, timeSig: TimeSignature): number {
    const beat = (60 / bpm) * (4 / timeSig.den);
    const beats = Math.max(0, Math.round(bars * timeSig.num));
    for (let i = 0; i < beats; i++) this.click(at + i * beat, i % timeSig.num === 0);
    return beats * beat;
  }

  dispose(): void {
    this.cancelFrom(0);
  }

  /** `time` is a scheduling time (like a note's); the click sounds when the music at that time is heard. */
  private click(time: number, accent: boolean): void {
    const at = time + this.latency();
    if (at < this.ctx.currentTime) return;
    this.accent ??= clickBuffer(this.ctx, 1760, 0.55);
    this.beat ??= clickBuffer(this.ctx, 1175, 0.4);
    const src = new AudioBufferSourceNode(this.ctx, { buffer: accent ? this.accent : this.beat });
    src.connect(this.out);
    src.start(at);
    src.onended = () => src.disconnect();
    this.scheduled.push({ time, src });
    // Forget clicks that have played.
    const now = this.ctx.currentTime;
    if (this.scheduled.length > 64) this.scheduled = this.scheduled.filter((c) => c.time >= now - 1);
  }

  private cancelFrom(time: number): void {
    const keep: typeof this.scheduled = [];
    for (const c of this.scheduled) {
      if (c.time >= time - 1e-9) {
        try {
          c.src.stop();
        } catch {
          /* already stopped */
        }
        c.src.disconnect();
      } else keep.push(c);
    }
    this.scheduled = keep;
  }
}
