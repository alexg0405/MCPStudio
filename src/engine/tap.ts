/**
 * Visualization taps (`host.tap()`): AnalyserNodes listening to a plugin's node, read by its editor
 * on the frame loop. One TapImpl per tapped node; the engine reports it to the app (which hands the
 * editor a stable view of it) and disposes it with the plugin instance.
 */
import type { AudioTap, PluginTap, TapOptions } from '@agstudio/sdk';

const DEFAULT_FFT = 4096;
const DEFAULT_SMOOTHING = 0.75;
/**
 * getFloatFrequencyData() reads |X[k]| / fftSize after a Blackman window: a full-scale sine comes
 * out at 20·log10(0.42 / 2) ≈ −13.6 dB. Adding this back makes it read 0 dBFS.
 */
export const SPECTRUM_OFFSET_DB = -20 * Math.log10(0.42 / 2);

function fftSizeOf(requested: number | undefined): number {
  const n = Math.round(requested ?? DEFAULT_FFT);
  let size = 32;
  while (size < n && size < 32768) size *= 2;
  return size;
}

/** A tap that ignores everything (offline renders, hosts without editors). */
export const NO_TAP: PluginTap = { publish: () => {} };

/** An AudioTap with nothing to show (offline engines, tests). */
export const INACTIVE_TAP: AudioTap = {
  active: false,
  sampleRate: 0,
  fftSize: 0,
  spectrum: () => false,
  waveform: () => false,
  reading: () => undefined,
};

/** An analyser on an audio node, read on the frame loop for spectrum and waveform (the plugin editors' and the visualizer's view). */
export class TapImpl implements AudioTap, PluginTap {
  readonly sampleRate: number;
  readonly fftSize: number;
  private readonly mix: AnalyserNode;
  /** Per-channel analysers, made the first time the editor asks for a waveform. */
  private channels: { splitter: ChannelSplitterNode; analysers: AnalyserNode[] } | null = null;
  private readonly scratch: Float32Array<ArrayBuffer>;
  private readonly values = new Map<string, number>();
  private live = true;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly node: AudioNode,
    opts: TapOptions = {},
  ) {
    this.sampleRate = ctx.sampleRate;
    this.fftSize = fftSizeOf(opts.fftSize);
    const smoothing = Math.min(0.99, Math.max(0, opts.smoothing ?? DEFAULT_SMOOTHING));
    this.mix = new AnalyserNode(ctx, { fftSize: this.fftSize, smoothingTimeConstant: smoothing });
    this.scratch = new Float32Array(this.fftSize);
    node.connect(this.mix);
  }

  get active(): boolean {
    return this.live;
  }

  publish(readings: Readonly<Record<string, number>>): void {
    if (!this.live) return;
    for (const key in readings) {
      const v = readings[key];
      if (typeof v === 'number') this.values.set(key, v);
    }
  }

  spectrum(out: Float32Array<ArrayBuffer>): boolean {
    if (!this.live) return false;
    this.mix.getFloatFrequencyData(out);
    const n = Math.min(out.length, this.fftSize / 2);
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) + SPECTRUM_OFFSET_DB;
    return true;
  }

  waveform(out: Float32Array<ArrayBuffer>, channel: 0 | 1 = 0): boolean {
    if (!this.live) return false;
    const analyser = this.channelAnalysers()[channel] ?? this.mix;
    // The analyser hands out its whole window (oldest first): keep its newest `out.length` frames.
    analyser.getFloatTimeDomainData(this.scratch);
    const n = Math.min(out.length, this.fftSize);
    out.set(this.scratch.subarray(this.fftSize - n), 0);
    return true;
  }

  reading(name: string): number | undefined {
    return this.values.get(name);
  }

  dispose(): void {
    if (!this.live) return;
    this.live = false;
    try {
      this.node.disconnect(this.mix);
    } catch {
      /* the plugin already disconnected its node */
    }
    if (this.channels) {
      try {
        this.node.disconnect(this.channels.splitter);
      } catch {
        /* already disconnected */
      }
      this.channels.splitter.disconnect();
    }
    this.values.clear();
  }

  private channelAnalysers(): AnalyserNode[] {
    if (!this.channels) {
      const splitter = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
      const analysers = [0, 1].map(
        () => new AnalyserNode(this.ctx, { fftSize: this.fftSize, smoothingTimeConstant: 0 }),
      );
      this.node.connect(splitter);
      analysers.forEach((a, i) => splitter.connect(a, i));
      this.channels = { splitter, analysers };
    }
    return this.channels.analysers;
  }
}
