/**
 * The SDK-owned processing loop, independent of AudioWorkletProcessor so it can be tested in Node.
 * Splits each block at event frames, isolates kernel exceptions, scrubs NaN/Infinity and never
 * assumes a 128-frame block.
 */
import {
  EV_ALL_OFF,
  EV_ALL_OFF_HARD,
  EV_NOTE_OFF,
  EV_NOTE_ON,
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
  private readonly ev = { type: 0, frame: 0, id: 0, key: 0, vel: 0, pan: 0 };
  private readonly silence: Float32Array[] = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];

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
    if (this.kernel instanceof InstrumentKernel) this.runInstrument(this.kernel, out, n, f0, block);
    else this.runEffect(this.kernel, inputs[0] ?? [], out, n, block);

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
        if (ev.type === EV_NOTE_ON) k.noteOn(ev.key, ev.vel, ev.id, ev.pan);
        else if (ev.type === EV_NOTE_OFF) k.noteOff(ev.id, ev.key);
        else if (ev.type === EV_ALL_OFF) k.allNotesOff(false);
        else if (ev.type === EV_ALL_OFF_HARD) k.allNotesOff(true);
      } catch (err) {
        this.fault(err);
      }
    }
  }

  private runEffect(k: EffectKernel, input: Float32Array[], out: Float32Array[], n: number, params: ParamBlock): void {
    const inp = input.length >= out.length ? input : this.padInput(input, out.length, n);
    if (this.faulted) {
      // A broken effect is bypassed rather than silencing the insert.
      for (let c = 0; c < out.length; c++) (out[c] as Float32Array).set((inp[c] as Float32Array).subarray(0, n));
      return;
    }
    try {
      k.process(inp, out, n, params);
    } catch (err) {
      this.fault(err);
      for (let c = 0; c < out.length; c++) (out[c] as Float32Array).set((inp[c] as Float32Array).subarray(0, n));
    }
  }

  /** An unconnected input arrives with zero channels; a mono one is duplicated. */
  private padInput(input: Float32Array[], channels: number, n: number): Float32Array[] {
    const padded: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const src = input[c] ?? input[0];
      if (src) padded.push(src);
      else {
        const z = (this.silence[c] ?? (this.silence[c] = new Float32Array(MAX_BLOCK))).subarray(0, n);
        z.fill(0);
        padded.push(z);
      }
    }
    return padded;
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
