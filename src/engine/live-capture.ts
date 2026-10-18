import type { InsertId, Tick } from '@core/model/types';
import { openAudioInput, type AudioInput } from './audio-input';
import { LIMITER_LOOKAHEAD_SEC } from './limiter-id';
import { isRealtimeContext } from './realtime-context';
import { startRecording, type RecordOptions, type RecordingHandle } from './recorder';

/** What recording and live inputs need from the engine. */
export interface LiveCaptureHost {
  readonly ctx: BaseAudioContext;
  /** The bus whose level the count-in and metronome clicks share with auditions (see Engine.previewBus). */
  readonly previewBus: AudioNode;
  /** Starts the context if the browser's autoplay policy left it suspended. */
  resume(): Promise<void>;
  loadModule(url: string): Promise<void>;
  /** Where a track connects (monitoring a live input through a mixer track). */
  insertInput(id: InsertId): AudioNode;
  /** Stops playback (recording starts from a standstill). */
  stop(): void;
  /** Whether a project is loaded (without one there is nothing to play along with). */
  hasProject(): boolean;
  /** The song's tempo (BPM) at a tick, which a count-in must click at. */
  songBpmAt(tick: Tick): number;
  /** Starts the project playing from `fromTick` so that it is heard from context time `at`. */
  startPlayAlong(fromTick: Tick, at: number): void;
}

/** Options of `LiveCapture.record` beyond the recorder's own. */
export interface RecordAlongOptions extends RecordOptions {
  /** Play the project along while recording (from `fromTick`, default 0). */
  playAlong: boolean;
  fromTick?: Tick;
}

/** Recording a microphone on the engine's clock, and live inputs (level meter, monitoring, captures). Realtime engines only. */
export class LiveCapture {
  /** Live inputs opened and not yet closed (they are closed with the engine). */
  private readonly inputs = new Set<AudioInput>();

  constructor(private readonly host: LiveCaptureHost) {}

  /** Records `stream` for the requested bars (count-in first), optionally with the project playing along. */
  async record(stream: MediaStream, opts: RecordAlongOptions): Promise<RecordingHandle> {
    const ctx = this.realtimeContext();
    await this.host.resume();
    this.host.stop();
    // Count in at the tempo where playback starts (tempo automation can change it later).
    const fromTick = opts.fromTick ?? 0;
    const bpm = this.host.hasProject() ? this.host.songBpmAt(fromTick) : opts.bpm;
    const handle = await startRecording(
      ctx,
      (url) => this.host.loadModule(url),
      stream,
      { ...opts, bpm: opts.playAlong ? bpm : opts.bpm },
      this.host.previewBus,
    );
    if (opts.playAlong && this.host.hasProject()) {
      this.host.startPlayAlong(fromTick, handle.barOneTime);
      handle.done.then(
        () => this.host.stop(),
        () => this.host.stop(),
      );
    }
    return handle;
  }

  /** Opens a live input on the engine's clock; it is closed with the engine if nobody closes it first. */
  async openInput(
    stream: MediaStream,
    opts: { channels: 1 | 2; label?: string; latency?: number },
  ): Promise<AudioInput> {
    const ctx = this.realtimeContext();
    await this.host.resume();
    const input = await openAudioInput(
      ctx,
      {
        loadModule: (url) => this.host.loadModule(url),
        insertInput: (id) => this.host.insertInput(id),
        // Output latency plus the master limiter's look-ahead (music and clicks pass through it).
        outputLatency: () => {
          const limiterFrames = Math.round(LIMITER_LOOKAHEAD_SEC * ctx.sampleRate);
          return ctx.baseLatency + (ctx.outputLatency || 0) + limiterFrames / ctx.sampleRate;
        },
      },
      stream,
      opts,
    );
    const closeInput = input.close.bind(input);
    input.close = () => {
      this.inputs.delete(input);
      closeInput();
    };
    this.inputs.add(input);
    return input;
  }

  /** Closes every input still open. */
  closeAll(): void {
    for (const input of [...this.inputs]) input.close();
  }

  private realtimeContext(): AudioContext {
    const ctx = this.host.ctx;
    if (!isRealtimeContext(ctx)) throw new Error('Recording needs the realtime engine.');
    return ctx;
  }
}
