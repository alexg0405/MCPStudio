/**
 * The decks' audio graph (built on first use, in the engine's AudioContext, or any context in tests):
 *
 *   per deck   player (worklet) → trim → EQ low shelf 100 Hz → mid bell 1 kHz → high shelf 10 kHz → low-pass →
 *              high-pass → meter ─┬→ cue send → cue bus
 *                                 └→ channel fader → crossfader side → mixer
 *   master     mixer → master volume → limiter → the engine's output (and the recorder, and the master meter)
 *
 * It only knows audio: tempo, sync, loops and cues are decided by `app/dj/decks.ts`, which sends the players
 * messages (`deck-id.ts`) and reads their shared state. A song's audio lives in SharedArrayBuffers (copied from
 * the decoded AudioBuffer a slice at a time), so the audio thread reads it directly.
 */
import {
  clampEq,
  clampTrim,
  crossfaderGainFor,
  dbToGain,
  EQ_BANDS,
  faderGain,
  filterCutoffs,
  FILTER_Q,
  type CrossfaderCurve,
  type CrossSide,
} from '@core/dj/decks-math';
import type { DeckHost } from '../api';
import { LIMITER_ID } from '../limiter-id';
import limiterUrl from '../limiter.worklet.ts?worker&url';
import { yieldToMain } from '../audio-buffers';
import { DECK_ID, DECK_STATE_SLOTS, type DeckEvent, type DeckMessage } from './deck-id';
import deckUrl from './deck.worklet.ts?worker&url';
import { newSnapshot, readDeckState, type DeckSnapshot } from './deck.kernel';
import { openTapCapture, type TapCapture } from './tap-capture';

export type DeckIndex = 0 | 1 | 2 | 3;
export const DECK_COUNT = 4;

export type EqBandName = 'low' | 'mid' | 'high';

/** A song's audio as the players read it. */
export interface DeckSongData {
  channels: SharedArrayBuffer[];
  frames: number;
  sampleRate: number;
}

/** Frames copied between two yields (~0.7 s at 48 kHz). */
const SLICE = 1 << 15;

/** Copies a decoded buffer into shared memory a slice at a time (a long song doesn't stall the page). */
export async function songDataOf(buffer: AudioBuffer): Promise<DeckSongData> {
  const channels: SharedArrayBuffer[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const sab = new SharedArrayBuffer(buffer.length * 4);
    const view = new Float32Array(sab);
    for (let i = 0; i < buffer.length; i += SLICE) {
      const n = Math.min(SLICE, buffer.length - i);
      // copyFromChannel writes into a (non-shared) view of the right length.
      const part = new Float32Array(n);
      buffer.copyFromChannel(part, c, i);
      view.set(part, i);
      if (i + SLICE < buffer.length) await yieldToMain();
    }
    channels.push(sab);
  }
  return { channels, frames: buffer.length, sampleRate: buffer.sampleRate };
}

export class DeckChannel {
  readonly node: AudioWorkletNode;
  private readonly trim: GainNode;
  private readonly eq: Record<EqBandName, BiquadFilterNode>;
  private readonly lowpass: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  readonly meter: AnalyserNode;
  private readonly cueSend: GainNode;
  private readonly fader: GainNode;
  private readonly xf: GainNode;
  readonly stateBuffer: SharedArrayBuffer;
  private readonly state: Float64Array;
  private readonly seq: Int32Array;
  private readonly snap = newSnapshot();
  private readonly meterBuf = new Float32Array(1024);
  /** Called when the song plays to its end. */
  onEnded: (() => void) | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    mixerIn: AudioNode,
    cueBus: AudioNode,
  ) {
    this.stateBuffer = new SharedArrayBuffer(DECK_STATE_SLOTS * 8);
    this.state = new Float64Array(this.stateBuffer);
    this.seq = new Int32Array(this.stateBuffer, 0, 1);
    this.node = new AudioWorkletNode(ctx, DECK_ID, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { state: this.stateBuffer },
    });
    this.node.port.onmessage = (e: MessageEvent<DeckEvent>) => {
      if (e.data.t === 'ended') this.onEnded?.();
      else if (e.data.t === 'pong') this.pings.get(e.data.id)?.();
    };
    this.trim = new GainNode(ctx);
    const band = (b: EqBandName) =>
      new BiquadFilterNode(ctx, { type: EQ_BANDS[b].type, frequency: EQ_BANDS[b].hz, Q: EQ_BANDS[b].q, gain: 0 });
    this.eq = { low: band('low'), mid: band('mid'), high: band('high') };
    // The biquad's Q for low-pass and high-pass is in dB: a Butterworth response has no peak.
    const qDb = 20 * Math.log10(FILTER_Q);
    this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: filterCutoffs(0, ctx.sampleRate).lowpassHz, Q: qDb });
    this.highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: qDb });
    this.meter = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    this.cueSend = new GainNode(ctx, { gain: 0 });
    this.fader = new GainNode(ctx, { gain: faderGain(1) });
    this.xf = new GainNode(ctx, { gain: 1 });
    this.node
      .connect(this.trim)
      .connect(this.eq.low)
      .connect(this.eq.mid)
      .connect(this.eq.high)
      .connect(this.lowpass)
      .connect(this.highpass);
    this.highpass.connect(this.meter);
    this.highpass.connect(this.cueSend).connect(cueBus);
    this.highpass.connect(this.fader).connect(this.xf).connect(mixerIn);
  }

  send(msg: DeckMessage): void {
    this.node.port.postMessage(msg);
  }

  private readonly pings = new Map<number, () => void>();
  private pingSeq = 0;

  /** Resolves once the player has handled every message sent so far. */
  settled(): Promise<void> {
    const id = ++this.pingSeq;
    return new Promise((resolve) => {
      this.pings.set(id, () => {
        this.pings.delete(id);
        resolve();
      });
      this.send({ t: 'ping', id });
    });
  }

  private glide(p: AudioParam, v: number): void {
    p.setTargetAtTime(v, this.ctx.currentTime, 0.008);
  }

  setTrim(db: number): void {
    this.glide(this.trim.gain, dbToGain(clampTrim(db)));
  }

  setEq(band: EqBandName, db: number): void {
    this.glide(this.eq[band].gain, clampEq(db));
  }

  setFilter(v: number): void {
    const c = filterCutoffs(v, this.ctx.sampleRate);
    this.glide(this.lowpass.frequency, c.lowpassHz);
    this.glide(this.highpass.frequency, c.highpassHz);
  }

  setFader(v: number): void {
    this.glide(this.fader.gain, faderGain(v));
  }

  setCueListen(on: boolean): void {
    this.glide(this.cueSend.gain, on ? 1 : 0);
  }

  setCrossfade(side: CrossSide, x: number, curve: CrossfaderCurve): void {
    this.glide(this.xf.gain, crossfaderGainFor(side, x, curve));
  }

  /** Peak of the last ~21 ms after the filter (before the fader), 0…1+. */
  level(): number {
    this.meter.getFloatTimeDomainData(this.meterBuf as Float32Array<ArrayBuffer>);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i] as number);
      if (v > peak) peak = v;
    }
    return peak;
  }

  /** The player's published state (a snapshot owned by the channel: copy what you keep). */
  snapshot(): DeckSnapshot {
    readDeckState(this.state, this.seq, this.snap);
    return this.snap;
  }

  dispose(): void {
    try {
      this.send({ t: 'dispose' });
    } catch {
      /* the port is gone */
    }
    this.node.port.onmessage = null;
    for (const n of [this.node, this.trim, this.eq.low, this.eq.mid, this.eq.high, this.lowpass, this.highpass, this.meter, this.cueSend, this.fader, this.xf]) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}

export class DeckGraph {
  readonly ctx: BaseAudioContext;
  readonly channels: readonly DeckChannel[];
  private readonly mixer: GainNode;
  private readonly master: GainNode;
  private readonly limiter: AudioWorkletNode;
  private readonly cueBus: GainNode;
  private readonly splitter: ChannelSplitterNode;
  private readonly meterL: AnalyserNode;
  private readonly meterR: AnalyserNode;
  private readonly meterBuf = new Float32Array(1024);
  private cueDest: MediaStreamAudioDestinationNode | null = null;
  private cueEl: HTMLAudioElement | null = null;
  private disposed = false;

  private constructor(
    readonly host: DeckHost,
    limiter: AudioWorkletNode,
  ) {
    const ctx = host.ctx;
    this.ctx = ctx;
    this.limiter = limiter;
    this.mixer = new GainNode(ctx);
    this.master = new GainNode(ctx, { gain: 1 });
    this.cueBus = new GainNode(ctx, { gain: 1 });
    this.mixer.connect(this.master).connect(limiter).connect(host.output);
    this.splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.meterL = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    this.meterR = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    limiter.connect(this.splitter);
    this.splitter.connect(this.meterL, 0);
    this.splitter.connect(this.meterR, 1);
    this.channels = Array.from({ length: DECK_COUNT }, () => new DeckChannel(ctx, this.mixer, this.cueBus));
  }

  /** Loads the worklets and builds the graph; the decks are silent until a song plays. */
  static async create(host: DeckHost): Promise<DeckGraph> {
    await Promise.all([host.loadModule(deckUrl), host.loadModule(limiterUrl)]);
    const limiter = new AudioWorkletNode(host.ctx, LIMITER_ID, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { kind: 'effect', state: undefined, seed: 1 },
    });
    return new DeckGraph(host, limiter);
  }

  /** Resolves once every player has handled all messages sent so far (offline renders and tests need it). */
  async settled(): Promise<void> {
    await Promise.all(this.channels.map((c) => c.settled()));
  }

  channel(i: number): DeckChannel {
    return this.channels[i] as DeckChannel;
  }

  setMasterVolume(v: number): void {
    this.master.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, 0.008);
  }

  /** The context frame being heard now (what the speakers play): for positions that must match the sound. */
  heardFrame(): number {
    return this.host.heardTime() * this.ctx.sampleRate;
  }

  /** Peak levels of the four decks into out[0…3] and of the master (L, R) into out[4], out[5]. */
  readLevels(out: Float32Array): void {
    for (let i = 0; i < DECK_COUNT; i++) out[i] = this.channel(i).level();
    const peak = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(this.meterBuf as Float32Array<ArrayBuffer>);
      let m = 0;
      for (let i = 0; i < this.meterBuf.length; i++) {
        const v = Math.abs(this.meterBuf[i] as number);
        if (v > m) m = v;
      }
      return m;
    };
    out[4] = peak(this.meterL);
    out[5] = peak(this.meterR);
  }

  /** Records the master (what is heard, after the limiter) in stereo; chunks arrive as they are drained. */
  async openCapture(onChunk: (channels: [Float32Array, Float32Array]) => void): Promise<TapCapture> {
    if (!(this.ctx instanceof AudioContext)) throw new Error('Recording needs a realtime audio engine.');
    return openTapCapture(this.ctx, (u) => this.host.loadModule(u), this.limiter, onChunk);
  }

  /**
   * Plays the cue bus (the decks whose cue button is on, before their faders) through another output, for
   * headphones: `deviceId` from enumerateDevices, '' for none. Resolves false where the browser can't.
   */
  async setCueOutput(deviceId: string): Promise<boolean> {
    if (!(this.ctx instanceof AudioContext)) return false;
    if (this.cueEl) {
      this.cueEl.pause();
      this.cueEl.srcObject = null;
      this.cueEl = null;
    }
    if (this.cueDest) {
      this.cueBus.disconnect(this.cueDest);
      this.cueDest = null;
    }
    if (!deviceId) return true;
    const el = new Audio() as HTMLAudioElement & { setSinkId?(id: string): Promise<void> };
    if (typeof el.setSinkId !== 'function') return false;
    try {
      const dest = new MediaStreamAudioDestinationNode(this.ctx);
      await el.setSinkId(deviceId);
      el.srcObject = dest.stream;
      await el.play();
      this.cueBus.connect(dest);
      this.cueDest = dest;
      this.cueEl = el;
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.setCueOutput('');
    for (const c of this.channels) c.dispose();
    this.limiter.port.postMessage({ t: 'dispose' });
    for (const n of [this.mixer, this.master, this.limiter, this.cueBus, this.splitter, this.meterL, this.meterR]) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}
