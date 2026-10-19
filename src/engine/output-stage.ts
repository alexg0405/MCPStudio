import type { AudioTap } from '@agstudio/sdk';
import { isRealtimeContext } from './realtime-context';
import { DEFAULT_PREVIEW_VOLUME } from './sample-preview';
import { INACTIVE_TAP, TapImpl } from './tap';
import { LIMITER_ID } from './limiter-id';
import limiterUrl from './limiter.worklet.ts?worker&url';

/** Level of the monitor bus (metronome and count-in clicks), a linear gain. */
const MONITOR_BUS_GAIN = 0.9;

/** Seconds a replaced engine takes to fade out. */
const DISPOSE_FADE_SEC = 0.012;
/** Extra milliseconds waited after the fade, so the ramp has certainly finished. */
const DISPOSE_FADE_SLACK_MS = 3;

/**
 * Panic ducks the output over this long (seconds), holds it silent until PANIC_SILENT_UNTIL_SEC (long enough for
 * ringing tails to die), and is back at full level at PANIC_FULL_AT_SEC. All counted from the call.
 */
const PANIC_DUCK_SEC = 0.01;
const PANIC_SILENT_UNTIL_SEC = 0.6;
const PANIC_FULL_AT_SEC = 0.65;

/** The output visualizer's FFT size and smoothing (0 to 1). */
const OUTPUT_TAP_OPTIONS = { fftSize: 4096, smoothing: 0.8 };

/**
 * Everything after the master track: the buses that join it, the safety limiter and the speakers.
 *
 * `previewBus` (auditions) and the master insert feed `masterOut`; `monitorBus` (metronome and count-in clicks) joins
 * after the master insert, so exports never hear it. `masterOut` plays through the limiter once its worklet has
 * loaded, and straight to the destination before that.
 */
export class OutputStage {
  /** Post-master bus: master insert + previews → safety limiter → destination. */
  readonly masterOut: GainNode;
  /** Auditions (samples, notes, count-in clicks): the level the browser's preview slider sets. */
  readonly previewBus: GainNode;
  /** Metronome and count-in clicks: after the master track, before the limiter; never exported. */
  readonly monitorBus: GainNode;
  /** The master safety limiter, or null while its worklet loads, when it is left out, or when it failed to load. */
  limiter: AudioWorkletNode | null = null;
  private outputTapCache: TapImpl | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly offline: boolean,
  ) {
    this.masterOut = new GainNode(ctx);
    this.previewBus = new GainNode(ctx, { gain: DEFAULT_PREVIEW_VOLUME });
    this.monitorBus = new GainNode(ctx, { gain: MONITOR_BUS_GAIN });
    this.masterOut.connect(ctx.destination);
    this.previewBus.connect(this.masterOut);
    this.monitorBus.connect(this.masterOut);
  }

  /** Puts the master safety limiter between `masterOut` and the speakers once its worklet module has loaded. */
  async installSafetyLimiter(loadModule: (url: string) => Promise<void>): Promise<void> {
    try {
      await loadModule(limiterUrl);
      const node = new AudioWorkletNode(this.ctx, LIMITER_ID, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { kind: 'effect', state: undefined, seed: 1 },
      });
      this.masterOut.disconnect();
      this.masterOut.connect(node).connect(this.ctx.destination);
      this.limiter = node;
    } catch (err) {
      console.warn('[agstudio] safety limiter unavailable; master is unprotected', err);
    }
  }

  /** Panic: graph effects can't be flushed, so the output ducks while their tails ring out. */
  duckForPanic(): void {
    const now = this.ctx.currentTime;
    const gain = this.masterOut.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + PANIC_DUCK_SEC);
    gain.setValueAtTime(0, now + PANIC_SILENT_UNTIL_SEC);
    gain.linearRampToValueAtTime(1, now + PANIC_FULL_AT_SEC);
  }

  /** A running engine that is replaced (a new buffer size, a rebooted output) fades out first instead of clicking. */
  async fadeOutIfRunning(): Promise<void> {
    const ctx = this.ctx;
    if (this.offline || !isRealtimeContext(ctx) || ctx.state !== 'running') return;
    const gain = this.masterOut.gain;
    const now = ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + DISPOSE_FADE_SEC);
    // A hidden tab's timers are throttled: don't wait for them (the context is closed right after anyway).
    if (typeof document !== 'undefined' && document.hidden) return;
    await new Promise((resolve) => setTimeout(resolve, DISPOSE_FADE_SEC * 1000 + DISPOSE_FADE_SLACK_MS));
  }

  /** The output visualizer's view of the master bus (an inactive one for an offline engine). */
  outputTap(): AudioTap {
    if (this.offline) return INACTIVE_TAP;
    return (this.outputTapCache ??= new TapImpl(this.ctx, this.masterOut, OUTPUT_TAP_OPTIONS));
  }

  /** Tells the limiter's processor to go away and lets go of the visualizer tap. */
  dispose(): void {
    this.limiter?.port.postMessage({ t: 'dispose' });
    this.outputTapCache?.dispose();
  }
}
