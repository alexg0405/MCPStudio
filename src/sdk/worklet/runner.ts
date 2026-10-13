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
  PITCH_PARAM,
  type FromProcessor,
  type ToProcessor,
} from '../protocol';
import { EventQueue } from './event-queue';
import { InstrumentKernel, type EffectKernel, type ParamBlock } from './kernel';

const MAX_BLOCK = 4096;

export class KernelRunner {
  readonly queue = new EventQueue(1024);
  alive = true;
  faulted = false;
  private nanReported = false;
  private lastF0 = -Infinity;
  private readonly ev = { type: 0, frame: 0, id: 0, key: 0, vel: 0, pan: 0, fine: 0 };
  private readonly silence = new Silence();
  private readonly scSilence = new Silence();
  /** Reused channel lists for padded inputs (filled per block, cleared after it). */
  private readonly padMain: Float32Array[] = [];
  private readonly padSc: Float32Array[] = [];
  private readonly noPitch = new Float32Array(1);

  constructor(
    readonly kernel: InstrumentKernel | EffectKernel,
    private readonly post: (msg: FromProcessor) => void,
  ) {}

  onMessage(msg: ToProcessor): void {
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

    const block = params as unknown as ParamBlock;
    if (this.kernel instanceof InstrumentKernel) {
      this.kernel.pitch = params[PITCH_PARAM] ?? this.noPitch;
      this.runInstrument(this.kernel, out, n, f0, block);
    } else this.runEffect(this.kernel, inputs[0] ?? [], inputs[1], out, n, block);

    this.scrub(out);
    return this.alive;
  }

  private runInstrument(k: InstrumentKernel, out: Float32Array[], n: number, f0: number, params: ParamBlock): void {
    let pos = 0;
    while (pos < n) {
      const next = this.queue.peekFrame();
      // Late events (frame already passed) land at the current position.
      const at = next < f0 + n ? Math.max(pos, Math.round(next - f0)) : n;
      if (at > pos && !this.faulted) {
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
        if (ev.type === EV_NOTE_ON) k.noteOn(ev.key, ev.vel, ev.id, ev.pan, ev.fine);
        else if (ev.type === EV_NOTE_OFF) k.noteOff(ev.id, ev.key, ev.vel);
        else if (ev.type === EV_ALL_OFF) k.allNotesOff(false);
        else if (ev.type === EV_ALL_OFF_HARD) k.allNotesOff(true);
        else if (ev.type === EV_CC) k.controlChange?.(ev.key, ev.vel);
      } catch (err) {
        this.fault(err);
      }
    }
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

  private scrub(out: Float32Array[]): void {
    for (let c = 0; c < out.length; c++) {
      const ch = out[c] as Float32Array;
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i] as number;
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
          return;
        }
      }
    }
  }

  private fault(err: unknown): void {
    if (this.faulted) return;
    this.faulted = true;
    this.post({ t: 'fault', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
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
