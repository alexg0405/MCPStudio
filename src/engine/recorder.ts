/**
 * Records the microphone on the engine's own clock, so a performance lines up with a count-in, a
 * click and (optionally) the beat playing along. The worklet writes into shared memory; this side
 * schedules the clicks, stops after the requested bars and works out where bar 1 is in the audio.
 */
import recorderUrl from './recorder.worklet.ts?worker&url';
import { REC_MODE, REC_STATE, RECORDER_ID } from './recorder-id';

export interface RecordOptions {
  bpm: number;
  beatsPerBar: number;
  /** Clicks before bar 1. */
  countInBeats: number;
  /** Bars to record after the count-in (recording stops by itself). */
  bars: number;
  /** Keep clicking while recording (the count-in always clicks). */
  click: boolean;
  /** Seconds the input lags the sound (MediaTrackSettings.latency, when the browser reports it). */
  inputLatency: number;
  /** The whole round trip, when it was measured (Options › Audio input › Calibrate): used instead of the estimate. */
  roundTrip?: number;
}

export interface Recording {
  /** Mono samples from the moment recording started (count-in included). */
  samples: Float32Array;
  sampleRate: number;
  /** Where bar 1 beat 1 falls in `samples`, in seconds, compensated for output and input latency. */
  barOneSec: number;
}

export interface RecordingHandle {
  /** Context time of bar 1 (after the count-in). */
  readonly barOneTime: number;
  /** Context time recording stops by itself. */
  readonly endTime: number;
  /** Peak of roughly the last 50 ms, 0..1 (for a level meter). */
  level(): number;
  /** Seconds since bar 1; negative during the count-in. */
  position(): number;
  /** Resolves when the recording ends (by itself or via stop()); rejects when cancelled. */
  readonly done: Promise<Recording>;
  stop(): void;
  cancel(): void;
}

/** Tail after the last bar for hits that land late (latency, a slow last note), in seconds. */
const TAIL_SEC = 0.35;
/** The first click plays this long after the call (seconds), so every click is scheduled ahead. */
const FIRST_CLICK_DELAY_SEC = 0.15;
/** The most bars one recording may run. */
const MAX_BARS = 16;
/** The buffer is made a second longer than the recording needs, as slack for a late start. */
const BUFFER_SLACK_SEC = 1;
/** The recording ends this long (ms) after its end time, once the last frames have certainly arrived. */
const END_TIMER_SLACK_MS = 30;
/** The level meter reads this many seconds of the newest audio. */
const LEVEL_WINDOW_SEC = 0.05;
/** Bytes of a 32-bit float. */
const BYTES_PER_SAMPLE = 4;
/** Bytes of the shared state (two Int32 slots) and of the first-frame position (one Float64). */
const STATE_BYTES = 8;
const START_BYTES = 8;

/** Click pitches (Hz): a higher one on the first beat of a bar. */
const ACCENT_CLICK_HZ = 1760;
const BEAT_CLICK_HZ = 1175;
/** Click levels (0 to 1), its attack and its decay to near silence, and how long its oscillator runs (seconds). */
const ACCENT_CLICK_LEVEL = 0.35;
const BEAT_CLICK_LEVEL = 0.22;
const CLICK_ATTACK_SEC = 0.002;
const CLICK_DECAY_SEC = 0.05;
const CLICK_SILENCE = 0.0001;
const CLICK_LENGTH_SEC = 0.06;

/** True where shared memory exists (cross-origin isolation): the recorder worklet writes into shared memory. */
export function canRecord(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

/** One click of the count-in or the metronome: a short decaying sine. */
function scheduleClick(ctx: AudioContext, out: AudioNode, at: number, accent: boolean): AudioScheduledSourceNode {
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: accent ? ACCENT_CLICK_HZ : BEAT_CLICK_HZ });
  const gain = new GainNode(ctx, { gain: 0 });
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(accent ? ACCENT_CLICK_LEVEL : BEAT_CLICK_LEVEL, at + CLICK_ATTACK_SEC);
  gain.gain.exponentialRampToValueAtTime(CLICK_SILENCE, at + CLICK_DECAY_SEC);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + CLICK_LENGTH_SEC);
  osc.onended = () => gain.disconnect();
  return osc;
}

/** When a recording's clicks play, where bar 1 is and when it ends (context seconds), and how big the buffer must be. */
interface RecordingPlan {
  beatSec: number;
  countInBeats: number;
  bars: number;
  firstClickAt: number;
  barOneTime: number;
  endTime: number;
  bufferFrames: number;
}

function planRecording(ctx: AudioContext, opts: RecordOptions): RecordingPlan {
  const beatSec = 60 / opts.bpm;
  const countInBeats = Math.max(0, Math.round(opts.countInBeats));
  const bars = Math.max(1, Math.min(MAX_BARS, opts.bars));
  const firstClickAt = ctx.currentTime + FIRST_CLICK_DELAY_SEC;
  const barOneTime = firstClickAt + countInBeats * beatSec;
  const endTime = barOneTime + bars * opts.beatsPerBar * beatSec + TAIL_SEC;
  const bufferFrames = Math.ceil((endTime - ctx.currentTime + BUFFER_SLACK_SEC) * ctx.sampleRate);
  return { beatSec, countInBeats, bars, firstClickAt, barOneTime, endTime, bufferFrames };
}

/**
 * A recording in progress: the worklet writes the microphone into shared memory from `start` to the end time; this
 * object schedules the clicks, ends the recording and works out where bar 1 is in the audio.
 */
class MicRecording implements RecordingHandle {
  readonly barOneTime: number;
  readonly endTime: number;
  readonly done: Promise<Recording>;
  private readonly samples: Float32Array;
  private readonly state: Int32Array;
  private readonly firstFrame: Float64Array;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  private readonly sink: GainNode;
  private readonly clicks: AudioScheduledSourceNode[] = [];
  private readonly timer: ReturnType<typeof setTimeout>;
  private settle!: (recording: Recording) => void;
  private fail!: (reason: unknown) => void;
  private finished = false;

  constructor(
    private readonly ctx: AudioContext,
    stream: MediaStream,
    private readonly opts: RecordOptions,
    plan: RecordingPlan,
    clickOut: AudioNode,
  ) {
    this.barOneTime = plan.barOneTime;
    this.endTime = plan.endTime;
    const data = new SharedArrayBuffer(plan.bufferFrames * BYTES_PER_SAMPLE);
    const state = new SharedArrayBuffer(STATE_BYTES);
    const start = new SharedArrayBuffer(START_BYTES);
    this.samples = new Float32Array(data);
    this.state = new Int32Array(state);
    this.firstFrame = new Float64Array(start);
    this.source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
    this.node = new AudioWorkletNode(ctx, RECORDER_ID, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { data, state, start },
    });
    // Silent path to the destination keeps the recorder pulled by the render graph.
    this.sink = new GainNode(ctx, { gain: 0 });
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
    this.scheduleClicks(plan, clickOut);
    Atomics.store(this.state, REC_STATE.mode, REC_MODE.recording);
    this.done = new Promise<Recording>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    this.timer = setTimeout(() => this.stop(), Math.max(0, (plan.endTime - ctx.currentTime) * 1000 + END_TIMER_SLACK_MS));
  }

  private scheduleClicks(plan: RecordingPlan, clickOut: AudioNode): void {
    const { beatsPerBar, click } = this.opts;
    const totalClicks = plan.countInBeats + (click ? plan.bars * beatsPerBar : 0);
    for (let i = 0; i < totalClicks; i++) {
      // The count-in beats come before bar 1: a multiple of the bar length keeps the remainder positive.
      const beatInBar = (i - plan.countInBeats + beatsPerBar * 64) % beatsPerBar;
      this.clicks.push(scheduleClick(this.ctx, clickOut, plan.firstClickAt + i * plan.beatSec, beatInBar === 0));
    }
  }

  /** Peak of roughly the last 50 ms, 0..1 (for a level meter). */
  level(): number {
    const written = Atomics.load(this.state, REC_STATE.written);
    let peak = 0;
    const from = Math.max(0, written - Math.round(LEVEL_WINDOW_SEC * this.ctx.sampleRate));
    for (let i = from; i < written; i++) peak = Math.max(peak, Math.abs(this.samples[i] as number));
    return peak;
  }

  /** Seconds since bar 1; negative during the count-in. */
  position(): number {
    return this.ctx.currentTime - this.barOneTime;
  }

  /** Ends the recording now (or at its end time, when the timer calls it). */
  stop(): void {
    if (this.finished) return;
    this.teardown();
    const written = Atomics.load(this.state, REC_STATE.written);
    const firstFrame = this.firstFrame[0] ?? 0;
    // A click sent at time T is heard after the output latency; the answer reaches the recorder
    // after the input latency on top.
    const { ctx, opts } = this;
    const latency = opts.roundTrip ?? (ctx.outputLatency || ctx.baseLatency || 0) + Math.max(0, opts.inputLatency);
    this.settle({
      samples: this.samples.slice(0, written),
      sampleRate: ctx.sampleRate,
      barOneSec: this.barOneTime + latency - firstFrame / ctx.sampleRate,
    });
  }

  cancel(): void {
    if (this.finished) return;
    this.teardown();
    this.fail(new DOMException('Recording cancelled.', 'AbortError'));
  }

  private teardown(): void {
    this.finished = true;
    clearTimeout(this.timer);
    Atomics.store(this.state, REC_STATE.mode, REC_MODE.done);
    for (const click of this.clicks) {
      try {
        click.stop();
      } catch {
        /* already ended */
      }
    }
    this.source.disconnect();
    this.node.disconnect();
    this.sink.disconnect();
  }
}

/**
 * Starts recording `stream` on the context's clock: clicks for the count-in (and the bars, with `opts.click`), then
 * the recording of `opts.bars` bars. Rejects where shared memory is not available.
 */
export async function startRecording(
  ctx: AudioContext,
  loadModule: (url: string) => Promise<void>,
  stream: MediaStream,
  opts: RecordOptions,
  clickOut: AudioNode,
): Promise<RecordingHandle> {
  if (!canRecord()) throw new Error('Recording needs cross-origin isolation (run AGstudio from its own dev server).');
  await loadModule(recorderUrl);
  return new MicRecording(ctx, stream, opts, planRecording(ctx, opts), clickOut);
}
