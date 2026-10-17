/**
 * The SDK-owned processing loop, independent of AudioWorkletProcessor so it can be tested in Node.
 * Splits each block at event frames, isolates kernel exceptions, scrubs NaN/Infinity and never
 * assumes a 128-frame block.
 */
import {
  EV_ALL_OFF,
  EV_ALL_OFF_HARD,
  EV_CC,
  EV_NOTE_OFF,
  EV_NOTE_ON,
  EV_PARAM,
  EV_TRANSPORT,
  PITCH_PARAM,
  type FromProcessor,
  type ToProcessor,
} from '../protocol';
import { EventQueue } from './event-queue';
import { InstrumentKernel, type EffectKernel, type KernelTransport, type ParamBlock } from './kernel';

const MAX_BLOCK = 4096;

/** The kernel's view of the song transport: the latest anchor, extrapolated per frame. */
class TransportState implements KernelTransport {
  playing = false;
  bpm = 120;
  /** Context frame of the current block's first frame. */
  blockStart = 0;
  private anchorFrame = 0;
  private anchorBeat = 0;
  private beatsPerFrame = 0;

  constructor(private readonly sampleRate: number) {}

  beatAt(i: number): number {
    return this.playing ? this.anchorBeat + (this.blockStart + i - this.anchorFrame) * this.beatsPerFrame : this.anchorBeat;
  }

  set(frame: number, beat: number, playing: boolean, bpm: number): void {
    this.anchorFrame = frame;
    this.anchorBeat = beat;
    this.playing = playing;
    if (bpm > 0 && Number.isFinite(bpm)) this.bpm = bpm;
    this.beatsPerFrame = this.bpm / 60 / this.sampleRate;
  }
}

/** Below this (about −120 dBFS) a block counts as silent. */
const SILENT = 1e-6;
/**
 * Seconds of silence (no notes held, nothing coming out; for effects nothing going in either) after
 * which a kernel sleeps: it isn't called until an event or sound arrives. Idle instruments and
 * effects then cost next to nothing. Long enough for echoes that come back after a quiet gap.
 */
const SLEEP_SECONDS = 1;

export class KernelRunner {
  readonly queue = new EventQueue(1024);
  alive = true;
  faulted = false;
  /** Sleeping (see SLEEP_SECONDS): the kernel isn't called and the output stays silent. */
  asleep = false;
  private quietFrames = 0;
  /** Notes on minus notes off (a sleep heuristic: never sleep while a key is held). */
  private held = 0;
  private nanReported = false;
  private lastF0 = -Infinity;
  private readonly ev = { type: 0, frame: 0, id: 0, key: 0, vel: 0, pan: 0, fine: 0 };
  private readonly silence = new Silence();
  private readonly scSilence = new Silence();
  /** Reused channel lists for padded inputs (filled per block, cleared after it). */
  private readonly padMain: Float32Array[] = [];
  private readonly padSc: Float32Array[] = [];
  private readonly noPitch = new Float32Array(1);
  private readonly transport: TransportState;
  /** Params that arrive as EV_PARAM events (one value each), by event index. */
  private readonly messageValues: Float32Array[];
  /** What the kernel gets: the AudioParams' arrays and the event params' values, one object for good. */
  private readonly block: Record<string, Float32Array> = {};
  /**
   * Event params that glide to their new value (setTargetAtTime's curve, like the AudioParam they
   * stand in for): the per-sample glide coefficient (0 = the value just changes), the value the
   * glide is heading to and where it is, and the per-sample array the kernel reads while it moves.
   */
  private readonly names: string[];
  private readonly glide: Float64Array;
  private readonly goal: Float64Array;
  private readonly now: Float64Array;
  private readonly ramps: (Float32Array | null)[];
  private readonly moving: Uint8Array;
  private anyGlide = false;
  /** Frames of the current block the gliding arrays are filled for. */
  private filled = 0;
  private blockSize = 128;

  constructor(
    readonly kernel: InstrumentKernel | EffectKernel,
    private readonly post: (msg: FromProcessor) => void,
    /** The AudioParam names, then the event params with their starting (encoded) values (and glide time constants, seconds). */
    private readonly audioParamNames: readonly string[] = [],
    messageParams: readonly (readonly [name: string, value: number, glideSeconds?: number])[] = [],
  ) {
    this.transport = new TransportState(kernel.sampleRate);
    kernel.transport = this.transport;
    this.names = messageParams.map(([name]) => name);
    const count = messageParams.length;
    this.glide = new Float64Array(count);
    this.goal = new Float64Array(count);
    this.now = new Float64Array(count);
    this.ramps = new Array<Float32Array | null>(count).fill(null);
    this.moving = new Uint8Array(count);
    this.messageValues = messageParams.map(([name, value, tau], i) => {
      const v = new Float32Array([value]);
      this.block[name] = v;
      this.goal[i] = value;
      this.now[i] = value;
      if (tau && tau > 0) {
        this.glide[i] = 1 - Math.exp(-1 / (tau * kernel.sampleRate));
        this.anyGlide = true;
      }
      return v;
    });
  }

  onMessage(msg: ToProcessor): void {
    // Events and sync barriers are not sound: a sleeping kernel stays asleep. Events are looked at as
    // they come due (a note wakes an instrument; transport anchors and param changes are applied
    // quietly): an offline render's barrier every chunk, or a loop's wrap anchor, would otherwise
    // keep every idle kernel awake. The rest reach the kernel's own code, which may start sound.
    if (msg.t !== 'ev' && msg.t !== 'sync' && msg.t !== 'dispose') this.wake();
    try {
      switch (msg.t) {
        case 'ev':
          this.queue.pushPacked(msg.data);
          break;
        case 'sync':
          this.post({ t: 'sync', id: msg.id });
          break;
        case 'state':
          this.kernel.setState?.(msg.state);
          break;
        case 'sample':
          this.kernel.onSample?.(msg.slot, msg.channels, msg.sampleRate);
          break;
        case 'user':
          this.kernel.onMessage?.(msg.msg);
          break;
        case 'reset':
          this.kernel.reset?.();
          break;
        case 'dispose':
          this.alive = false;
          break;
      }
    } catch (err) {
      this.fault(err);
    }
  }

  /**
   * One render quantum. `currentFrame` is the context frame at the start of this block.
   * Returns false once disposed (lets the node be garbage-collected).
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
    currentFrame: number,
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return this.alive;
    const n = (out[0] as Float32Array).length;
    // Chromium can report a stale currentFrame for one quantum while the main thread holds the graph lock.
    let f0 = currentFrame;
    if (f0 <= this.lastF0) f0 = this.lastF0 + n;
    this.lastF0 = f0;
    for (let c = 0; c < out.length; c++) (out[c] as Float32Array).fill(0);

    // The AudioParams' arrays change every block; the event params' arrays stay.
    const names = this.audioParamNames;
    let block: ParamBlock;
    if (this.messageValues.length === 0) block = params as unknown as ParamBlock;
    else {
      for (let i = 0; i < names.length; i++) {
        const name = names[i] as string;
        this.block[name] = params[name] as Float32Array;
      }
      block = this.block as unknown as ParamBlock;
    }
    this.transport.blockStart = f0;
    this.blockSize = n;
    this.filled = 0;
    let quietIn = true;
    if (this.kernel instanceof InstrumentKernel) {
      // Asleep, an instrument wakes for the next note or controller due in this block; the song's
      // transport anchors and param changes are applied without waking it.
      if (this.asleep) {
        while (this.queue.peekFrame() < f0 + n) {
          const type = this.queue.peekType();
          if ((type !== EV_TRANSPORT || this.kernel.wakeOnTransport) && type !== EV_PARAM) break;
          this.applyQuiet();
        }
        if (this.queue.peekFrame() >= f0 + n) return this.alive;
        this.wake();
      }
      this.kernel.pitch = params[PITCH_PARAM] ?? this.noPitch;
      this.runInstrument(this.kernel, out, n, f0, block);
      this.finishGlides(n);
    } else {
      // Effects get no notes; transport anchors due in this block apply at its start.
      this.applyTransport(f0 + n - 1);
      const input = inputs[0] ?? [];
      quietIn = peakOf(input, n) < SILENT && (inputs[1] === undefined || peakOf(inputs[1], n) < SILENT);
      // Asleep, an effect wakes when sound arrives.
      if (this.asleep) {
        if (quietIn) return this.alive;
        this.wake();
      }
      this.advanceGlides(n);
      this.runEffect(this.kernel, input, inputs[1], out, n, block);
      this.finishGlides(n);
    }

    const peak = this.scrub(out);
    if (this.held === 0 && quietIn && peak < SILENT && !this.faulted) {
      this.quietFrames += n;
      if (this.quietFrames >= SLEEP_SECONDS * this.kernel.sampleRate) this.asleep = true;
    } else this.quietFrames = 0;
    return this.alive;
  }

  private wake(): void {
    this.asleep = false;
    this.quietFrames = 0;
    // A glide that was cut short by sleeping lands at once (nothing was heard meanwhile).
    if (this.anyGlide)
      for (let i = 0; i < this.moving.length; i++)
        if (this.moving[i]) {
          this.now[i] = this.goal[i] as number;
          this.settle(i);
        }
  }

  /** Fills the gliding params' arrays up to frame `upTo` of the block (what kernels read below it). */
  private advanceGlides(upTo: number): void {
    if (!this.anyGlide || upTo <= this.filled) return;
    const n = this.blockSize;
    for (let i = 0; i < this.moving.length; i++) {
      if (!this.moving[i]) continue;
      let ramp = this.ramps[i] ?? null;
      if (!ramp || ramp.length !== n) {
        ramp = this.ramps[i] = new Float32Array(n);
        this.block[this.names[i] as string] = ramp;
        ramp.fill(this.now[i] as number);
      }
      const goal = this.goal[i] as number;
      const k = this.glide[i] as number;
      let v = this.now[i] as number;
      // The value at the frame, then the step towards the goal (setTargetAtTime: v0 at the event, then v0 → goal).
      for (let f = this.filled; f < upTo; f++) {
        ramp[f] = v;
        v += (goal - v) * k;
      }
      this.now[i] = v;
    }
    this.filled = upTo;
  }

  /** The block is done: glides that arrived go back to a plain value; the others carry on next block. */
  private finishGlides(n: number): void {
    if (!this.anyGlide) return;
    this.advanceGlides(n);
    for (let i = 0; i < this.moving.length; i++) {
      if (!this.moving[i]) continue;
      const goal = this.goal[i] as number;
      const v = this.now[i] as number;
      if (Math.abs(goal - v) <= 1e-7 * Math.max(1, Math.abs(goal))) {
        this.now[i] = goal;
        this.settle(i);
      }
    }
  }

  /** Glide `i` is over: the kernel reads its single value again. */
  private settle(i: number): void {
    this.moving[i] = 0;
    const single = this.messageValues[i] as Float32Array;
    single[0] = this.now[i] as number;
    this.block[this.names[i] as string] = single;
    this.ramps[i] = null;
  }

  private runInstrument(k: InstrumentKernel, out: Float32Array[], n: number, f0: number, params: ParamBlock): void {
    let pos = 0;
    while (pos < n) {
      const next = this.queue.peekFrame();
      // Late events (frame already passed) land at the current position.
      const at = next < f0 + n ? Math.max(pos, Math.round(next - f0)) : n;
      if (at > pos && !this.faulted) {
        this.advanceGlides(at);
        try {
          k.render(out, pos, at, params);
        } catch (err) {
          this.fault(err);
        }
      }
      if (at >= n) break;
      this.applyDue(k, f0 + at);
      pos = at;
    }
    if (this.faulted) for (let c = 0; c < out.length; c++) (out[c] as Float32Array).fill(0);
  }

  private applyDue(k: InstrumentKernel, frame: number): void {
    const ev = this.ev;
    while (this.queue.peekFrame() <= frame && this.queue.shift(ev)) {
      if (this.faulted) continue;
      try {
        if (ev.type === EV_NOTE_ON) {
          this.held++;
          k.noteOn(ev.key, ev.vel, ev.id, ev.pan, ev.fine);
        } else if (ev.type === EV_NOTE_OFF) {
          if (this.held > 0) this.held--;
          k.noteOff(ev.id, ev.key, ev.vel);
        } else if (ev.type === EV_ALL_OFF || ev.type === EV_ALL_OFF_HARD) {
          this.held = 0;
          k.allNotesOff(ev.type === EV_ALL_OFF_HARD);
        }
        else if (ev.type === EV_CC) k.controlChange?.(ev.key, ev.vel);
        else if (ev.type === EV_PARAM) this.setParam();
        else if (ev.type === EV_TRANSPORT) this.setTransport();
      } catch (err) {
        this.fault(err);
      }
    }
  }

  /** Applies the one transport anchor or param change at the head of the queue (a sleeping instrument). */
  private applyQuiet(): void {
    const ev = this.ev;
    if (!this.queue.shift(ev)) return;
    if (ev.type === EV_PARAM) this.setParam();
    else if (!this.faulted) {
      try {
        this.setTransport();
      } catch (err) {
        this.fault(err);
      }
    }
  }

  /**
   * Applies the transport anchors and param changes queued up to `frame`, and the notes an effect follows (an
   * effect that doesn't implement the note methods drops them).
   */
  private applyTransport(frame: number): void {
    const ev = this.ev;
    const fx = this.kernel instanceof InstrumentKernel ? null : (this.kernel as EffectKernel);
    while (this.queue.peekFrame() <= frame && this.queue.shift(ev)) {
      if (ev.type === EV_PARAM) {
        this.setParam();
        continue;
      }
      if (fx && !this.faulted && (ev.type === EV_NOTE_ON || ev.type === EV_NOTE_OFF || ev.type === EV_ALL_OFF || ev.type === EV_ALL_OFF_HARD)) {
        try {
          if (ev.type === EV_NOTE_ON) fx.noteOn?.(ev.key, ev.vel, ev.id);
          else if (ev.type === EV_NOTE_OFF) fx.noteOff?.(ev.id, ev.key, ev.vel);
          else fx.allNotesOff?.(ev.type === EV_ALL_OFF_HARD);
        } catch (err) {
          this.fault(err);
        }
        continue;
      }
      if (ev.type !== EV_TRANSPORT || this.faulted) continue;
      try {
        this.setTransport();
      } catch (err) {
        this.fault(err);
      }
    }
  }

  /** The event in `this.ev` sets an event param: index in `key`, encoded value in `vel`. */
  private setParam(): void {
    const i = this.ev.key;
    const v = this.messageValues[i];
    if (!v) return;
    if ((this.glide[i] as number) > 0) {
      // Glides head for the new value from where they are, starting at the frames not yet filled.
      this.goal[i] = this.ev.vel;
      this.moving[i] = 1;
    } else v[0] = this.ev.vel;
  }

  /** The event in `this.ev` is a transport anchor (see EV_TRANSPORT for the packing). */
  private setTransport(): void {
    const ev = this.ev;
    this.transport.set(ev.frame, ev.id, ev.key === 1, ev.vel);
    this.kernel.transportChanged?.();
  }

  private runEffect(
    k: EffectKernel,
    input: Float32Array[],
    sidechain: Float32Array[] | undefined,
    out: Float32Array[],
    n: number,
    params: ParamBlock,
  ): void {
    const inp = input.length >= out.length ? input : this.padInput(input, out.length, n, this.silence, this.padMain);
    // A second input exists only for sidechain effects; idle or unconnected, it arrives with zero
    // channels (the host feeds it the chosen track, or the effect's own input when none is chosen).
    const sc =
      sidechain === undefined
        ? undefined
        : sidechain.length >= out.length
          ? sidechain
          : this.padInput(sidechain, out.length, n, this.scSilence, this.padSc);
    if (this.faulted) {
      // A broken effect is bypassed rather than silencing the insert.
      for (let c = 0; c < out.length; c++) copyInto(out[c] as Float32Array, inp[c] as Float32Array, n);
    } else {
      try {
        k.process(inp, out, n, params, sc);
      } catch (err) {
        this.fault(err);
        for (let c = 0; c < out.length; c++) copyInto(out[c] as Float32Array, inp[c] as Float32Array, n);
      }
    }
    // Never keep the browser's input arrays past this call.
    this.padMain.length = 0;
    this.padSc.length = 0;
  }

  /**
   * An unconnected (or idle) input arrives with zero channels: pad with silence; a mono one is
   * duplicated. Allocation-free after the first block of a given size.
   */
  private padInput(
    input: Float32Array[],
    channels: number,
    n: number,
    silence: Silence,
    into: Float32Array[],
  ): Float32Array[] {
    for (let c = 0; c < channels; c++) {
      const src = input[c] ?? input[0];
      into[c] = src ?? silence.get(c, n);
    }
    return into;
  }

  /** Silences a block with NaN or ±Infinity in it (and resets the kernel); returns the block's peak. */
  private scrub(out: Float32Array[]): number {
    let peak = 0;
    for (let c = 0; c < out.length; c++) {
      const ch = out[c] as Float32Array;
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i] as number;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        if (x - x !== 0) {
          // NaN or ±Infinity: silence the block and reset the kernel's state.
          for (let d = 0; d < out.length; d++) (out[d] as Float32Array).fill(0);
          try {
            this.kernel.reset?.();
          } catch {
            /* ignore */
          }
          if (!this.nanReported) {
            this.nanReported = true;
            this.post({ t: 'nan' });
          }
          return 0;
        }
      }
    }
    return peak;
  }

  private fault(err: unknown): void {
    if (this.faulted) return;
    this.faulted = true;
    this.post({ t: 'fault', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}

/** Largest |sample| over the first n frames of the channels (an unconnected input has none: 0). */
function peakOf(channels: readonly Float32Array[], n: number): number {
  let peak = 0;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c] as Float32Array;
    const end = Math.min(n, ch.length);
    for (let i = 0; i < end; i++) {
      const x = ch[i] as number;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Copies n frames (the source may be longer than the block). */
function copyInto(dst: Float32Array, src: Float32Array, n: number): void {
  if (src.length === n) dst.set(src);
  else for (let i = 0; i < n; i++) dst[i] = src[i] as number;
}

/** Zeroed per-channel buffers of the current block size (views are rebuilt only when it changes). */
class Silence {
  private readonly buffers: Float32Array[] = [];
  private readonly views: Float32Array[] = [];

  get(channel: number, n: number): Float32Array {
    let view = this.views[channel];
    if (!view || view.length !== n) {
      let buf = this.buffers[channel];
      if (!buf || buf.length < n) buf = this.buffers[channel] = new Float32Array(Math.max(MAX_BLOCK, n));
      view = this.views[channel] = buf.subarray(0, n);
    }
    // A kernel may have written into it last block.
    view.fill(0);
    return view;
  }
}
