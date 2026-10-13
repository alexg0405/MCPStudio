import recorderUrl from './recorder.worklet.ts?worker&url';
import { REC_MODE, REC_STATE, RECORDER_ID } from './recorder-id';

/**
 * Records the microphone on the engine's own clock, so a performance lines up with a count-in, a
 * click and (optionally) the beat playing along. The worklet writes into shared memory; this side
 * schedules the clicks, stops after the requested bars and works out where bar 1 is in the audio.
 */

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

/** Tail after the last bar for hits that land late (latency, a slow last note). */
const TAIL = 0.35;

export function canRecord(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

function scheduleClick(ctx: AudioContext, out: AudioNode, at: number, accent: boolean): AudioScheduledSourceNode {
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: accent ? 1760 : 1175 });
  const gain = new GainNode(ctx, { gain: 0 });
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + 0.06);
  osc.onended = () => gain.disconnect();
  return osc;
}

export async function startRecording(
  ctx: AudioContext,
  loadModule: (url: string) => Promise<void>,
  stream: MediaStream,
  opts: RecordOptions,
  clickOut: AudioNode,
): Promise<RecordingHandle> {
  if (!canRecord()) throw new Error('Recording needs cross-origin isolation (run AGstudio from its own dev server).');
  await loadModule(recorderUrl);
  const sr = ctx.sampleRate;
  const beat = 60 / opts.bpm;
  const countIn = Math.max(0, Math.round(opts.countInBeats));
  const bars = Math.max(1, Math.min(16, opts.bars));
  const t0 = ctx.currentTime + 0.15;
  const barOneTime = t0 + countIn * beat;
  const endTime = barOneTime + bars * opts.beatsPerBar * beat + TAIL;
  const frames = Math.ceil((endTime - ctx.currentTime + 1) * sr);

  const data = new SharedArrayBuffer(frames * 4);
  const state = new SharedArrayBuffer(8);
  const start = new SharedArrayBuffer(8);
  const samples = new Float32Array(data);
  const st = new Int32Array(state);
  const source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
  const node = new AudioWorkletNode(ctx, RECORDER_ID, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { data, state, start },
  });
  // Silent path to the destination keeps the recorder pulled by the render graph.
  const sink = new GainNode(ctx, { gain: 0 });
  source.connect(node).connect(sink).connect(ctx.destination);

  const clicks: AudioScheduledSourceNode[] = [];
  const totalClicks = countIn + (opts.click ? bars * opts.beatsPerBar : 0);
  for (let i = 0; i < totalClicks; i++) {
    const beatInBar = (i - countIn + opts.beatsPerBar * 64) % opts.beatsPerBar;
    clicks.push(scheduleClick(ctx, clickOut, t0 + i * beat, beatInBar === 0));
  }
  Atomics.store(st, REC_STATE.mode, REC_MODE.recording);

  let settle!: (r: Recording) => void;
  let fail!: (e: unknown) => void;
  const done = new Promise<Recording>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let finished = false;
  const teardown = () => {
    finished = true;
    clearTimeout(timer);
    Atomics.store(st, REC_STATE.mode, REC_MODE.done);
    for (const c of clicks) {
      try {
        c.stop();
      } catch {
        /* already ended */
      }
    }
    source.disconnect();
    node.disconnect();
    sink.disconnect();
  };
  const finish = () => {
    if (finished) return;
    teardown();
    const written = Atomics.load(st, REC_STATE.written);
    const firstFrame = new Float64Array(start)[0] ?? 0;
    // A click sent at time T is heard after the output latency; the answer reaches the recorder
    // after the input latency on top.
    const latency = (ctx.outputLatency || ctx.baseLatency || 0) + Math.max(0, opts.inputLatency);
    settle({
      samples: samples.slice(0, written),
      sampleRate: sr,
      barOneSec: barOneTime + latency - firstFrame / sr,
    });
  };
  const timer = setTimeout(finish, Math.max(0, (endTime - ctx.currentTime) * 1000 + 30));

  return {
    barOneTime,
    endTime,
    level() {
      const w = Atomics.load(st, REC_STATE.written);
      let peak = 0;
      for (let i = Math.max(0, w - Math.round(0.05 * sr)); i < w; i++)
        peak = Math.max(peak, Math.abs(samples[i] as number));
      return peak;
    },
    position: () => ctx.currentTime - barOneTime,
    done,
    stop: finish,
    cancel() {
      if (finished) return;
      teardown();
      fail(new DOMException('Recording cancelled.', 'AbortError'));
    },
  };
}
