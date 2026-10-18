import { disconnectFrom } from './audio-graph';
import { METER_FRAMES, peakOf, type MeterScratch } from './meter-peak';

/** Meters are taken out of the graph once nobody has read them for this long (ms): a closed mixer costs nothing. */
const METER_IDLE_MS = 2500;

/**
 * The peak meters of one insert: a channel splitter and two analysers on its post-fader tap. They only exist while
 * someone reads them (the mixer's meters, every frame): the first read connects them and reads 0, and they go away
 * again after METER_IDLE_MS. Offline renders have none.
 */
export class InsertMeters {
  private splitter: ChannelSplitterNode | null = null;
  private analysers: readonly AnalyserNode[] = [];
  private lastReadMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    /** The node the meters listen to. */
    private readonly source: AudioNode,
    private readonly offline: boolean,
  ) {}

  /** True while the analysers are in the graph (diagnostics and tests). */
  get active(): boolean {
    return this.splitter !== null;
  }

  /** Writes the left/right peak of the last METER_FRAMES frames into out[at], out[at + 1]. */
  readPeaks(scratch: MeterScratch, out: Float32Array, at: number): void {
    if (!this.offline) this.touch();
    for (let channel = 0; channel < 2; channel++) {
      const analyser = this.analysers[channel];
      let peak = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(scratch.samples);
        peak = peakOf(scratch);
      }
      if (at + channel < out.length) out[at + channel] = peak;
    }
  }

  /** Takes the analysers out of the graph. */
  drop(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.splitter) disconnectFrom(this.source, this.splitter);
    this.splitter?.disconnect();
    for (const analyser of this.analysers) analyser.disconnect();
    this.splitter = null;
    this.analysers = [];
  }

  /** A read happened: note the time, and put the analysers in the graph if they are not. */
  private touch(): void {
    this.lastReadMs = performance.now();
    if (this.splitter) return;
    const splitter = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
    const analysers = [0, 1].map(() => new AnalyserNode(this.ctx, { fftSize: METER_FRAMES, smoothingTimeConstant: 0 }));
    this.source.connect(splitter);
    analysers.forEach((analyser, channel) => splitter.connect(analyser, channel));
    this.splitter = splitter;
    this.analysers = analysers;
    this.idleTimer = setTimeout(() => this.dropWhenIdle(), METER_IDLE_MS);
  }

  private dropWhenIdle(): void {
    this.idleTimer = null;
    const idleMs = performance.now() - this.lastReadMs;
    if (idleMs < METER_IDLE_MS) this.idleTimer = setTimeout(() => this.dropWhenIdle(), METER_IDLE_MS - idleMs);
    else this.drop();
  }
}
