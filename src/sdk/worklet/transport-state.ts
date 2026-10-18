import type { KernelTransport } from './kernel';

const SECONDS_PER_MINUTE = 60;

/** The kernel's view of the song transport: the latest anchor, extrapolated per frame. */
export class TransportState implements KernelTransport {
  playing = false;
  bpm = 120;
  /** Context frame of the current block's first frame. */
  blockStart = 0;
  private anchorFrame = 0;
  private anchorBeat = 0;
  private beatsPerFrame = 0;

  constructor(private readonly sampleRate: number) {}

  /** The song position in beats at frame `i` of the current block (it holds while stopped). */
  beatAt(i: number): number {
    if (!this.playing) return this.anchorBeat;
    return this.anchorBeat + (this.blockStart + i - this.anchorFrame) * this.beatsPerFrame;
  }

  /** A new anchor: at context frame `frame` the song is at `beat`, playing or stopped, at `bpm` (ignored when not a positive number). */
  set(frame: number, beat: number, playing: boolean, bpm: number): void {
    this.anchorFrame = frame;
    this.anchorBeat = beat;
    this.playing = playing;
    if (bpm > 0 && Number.isFinite(bpm)) this.bpm = bpm;
    this.beatsPerFrame = this.bpm / SECONDS_PER_MINUTE / this.sampleRate;
  }
}
