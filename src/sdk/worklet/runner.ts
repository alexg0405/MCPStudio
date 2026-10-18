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
import { copyInto, peakOf, Silence } from './block-buffers';
import { EventQueue, type QueuedEvent } from './event-queue';
import { InstrumentKernel, type EffectKernel, type ParamBlock } from './kernel';
import { MessageParams, type MessageParamInit } from './message-params';
import { TransportState } from './transport-state';

/** Below this (about -120 dBFS) a block counts as silent. */
const SILENT = 1e-6;
/**
 * Seconds of silence (no notes held, nothing coming out; for effects nothing going in either) after
 * which a kernel sleeps: it isn't called until an event or sound arrives. Idle instruments and
 * effects then cost next to nothing. Long enough for echoes that come back after a quiet gap.
 */
const SLEEP_SECONDS = 1;
/** Capacity the event queue starts with (it grows if a burst exceeds it). */
const EVENT_QUEUE_CAPACITY = 1024;

/** Runs one kernel for the processor: queued events, glides of event params, sleep when idle, and the NaN and exception guards. */
export class KernelRunner {
  readonly queue = new EventQueue(EVENT_QUEUE_CAPACITY);
  alive = true;
  faulted = false;
  /** Sleeping (see SLEEP_SECONDS): the kernel isn't called and the output stays silent. */
  asleep = false;
  private quietFrames = 0;
  /** Notes on minus notes off (a sleep heuristic: never sleep while a key is held). */
  private held = 0;
  private nanReported = false;
  private lastBlockStartFrame = -Infinity;
  private readonly ev: QueuedEvent = { type: 0, frame: 0, id: 0, key: 0, vel: 0, pan: 0, fine: 0 };
  private readonly silence = new Silence();
  private readonly scSilence = new Silence();
  /** Reused channel lists for padded inputs (filled per block, cleared after it). */
  private readonly padMain: Float32Array[] = [];
  private readonly padSc: Float32Array[] = [];
  private readonly noPitch = new Float32Array(1);
  private readonly transport: TransportState;
  /** Params that arrive as EV_PARAM events (one value each), by event index. */
  private readonly messageParams: MessageParams;

  constructor(
    readonly kernel: InstrumentKernel | EffectKernel,
    private readonly post: (msg: FromProcessor) => void,
    /** The AudioParam names, then the event params with their starting (encoded) values (and glide time constants, seconds). */
    private readonly audioParamNames: readonly string[] = [],
    messageParams: readonly MessageParamInit[] = [],
  ) {
    this.transport = new TransportState(kernel.sampleRate);
    kernel.transport = this.transport;
    this.messageParams = new MessageParams(messageParams, kernel.sampleRate);
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
    const blockStartFrame = this.blockStartFrame(currentFrame, n);
    for (let c = 0; c < out.length; c++) (out[c] as Float32Array).fill(0);

    const block = this.messageParams.blockWith(this.audioParamNames, params);
    this.transport.blockStart = blockStartFrame;
    this.messageParams.beginBlock(n);
    if (this.kernel instanceof InstrumentKernel) this.processInstrument(this.kernel, out, n, blockStartFrame, params, block);
    else this.processEffect(this.kernel, inputs, out, n, blockStartFrame, block);
    return this.alive;
  }

  /** The context frame of this block's first frame; Chromium can report a stale one for a quantum while the main thread holds the graph lock. */
  private blockStartFrame(currentFrame: number, n: number): number {
    let frame = currentFrame;
    if (frame <= this.lastBlockStartFrame) frame = this.lastBlockStartFrame + n;
    this.lastBlockStartFrame = frame;
    return frame;
  }

  private processInstrument(
    k: InstrumentKernel,
    out: Float32Array[],
    n: number,
    blockStartFrame: number,
    params: Record<string, Float32Array>,
    block: ParamBlock,
  ): void {
    if (this.asleep && !this.wakeForDueEvent(k, n, blockStartFrame)) return;
    k.pitch = params[PITCH_PARAM] ?? this.noPitch;
    this.runInstrument(k, out, n, blockStartFrame, block);
    this.messageParams.finishBlock(n);
    this.afterBlock(out, n, true);
  }

  /**
   * A sleeping instrument wakes for the next note or controller due in this block; the song's
   * transport anchors and param changes are applied without waking it. Returns true when it woke.
   */
  private wakeForDueEvent(k: InstrumentKernel, n: number, blockStartFrame: number): boolean {
    const blockEnd = blockStartFrame + n;
    while (this.queue.peekFrame() < blockEnd) {
      const type = this.queue.peekType();
      if ((type !== EV_TRANSPORT || k.wakeOnTransport) && type !== EV_PARAM) break;
      this.applyQuiet();
    }
    if (this.queue.peekFrame() >= blockEnd) return false;
    this.wake();
    return true;
  }

  private processEffect(
    k: EffectKernel,
    inputs: Float32Array[][],
    out: Float32Array[],
    n: number,
    blockStartFrame: number,
    block: ParamBlock,
  ): void {
    // Effects get no notes in the middle of a block; the events due in this block apply at its start.
    this.applyEffectEvents(k, blockStartFrame + n - 1);
    const input = inputs[0] ?? [];
    const sidechainOrSecondInput = inputs[1];
    const isInputQuiet =
      peakOf(input, n) < SILENT && (sidechainOrSecondInput === undefined || peakOf(sidechainOrSecondInput, n) < SILENT);
    // Asleep, an effect wakes when sound arrives.
    if (this.asleep) {
      if (isInputQuiet) return;
      this.wake();
    }
    this.messageParams.advance(n);
    this.runEffect(k, input, sidechainOrSecondInput, out, n, block);
    this.messageParams.finishBlock(n);
    this.afterBlock(out, n, isInputQuiet);
  }

  /** Scrubs the output and counts the quiet frames that put a kernel to sleep. */
  private afterBlock(out: Float32Array[], n: number, isInputQuiet: boolean): void {
    const peak = this.scrub(out);
    if (this.held === 0 && isInputQuiet && peak < SILENT && !this.faulted) {
      this.quietFrames += n;
      if (this.quietFrames >= SLEEP_SECONDS * this.kernel.sampleRate) this.asleep = true;
    } else this.quietFrames = 0;
  }

  private wake(): void {
    this.asleep = false;
    this.quietFrames = 0;
    this.messageParams.landGlides();
  }

  private runInstrument(k: InstrumentKernel, out: Float32Array[], n: number, blockStartFrame: number, params: ParamBlock): void {
    let position = 0;
    while (position < n) {
      const nextEventFrame = this.queue.peekFrame();
      // Late events (frame already passed) land at the current position.
      const eventPosition = nextEventFrame < blockStartFrame + n ? Math.max(position, Math.round(nextEventFrame - blockStartFrame)) : n;
      if (eventPosition > position && !this.faulted) {
        this.messageParams.advance(eventPosition);
        try {
          k.render(out, position, eventPosition, params);
        } catch (err) {
          this.fault(err);
        }
      }
      if (eventPosition >= n) break;
      this.applyDue(k, blockStartFrame + eventPosition);
      position = eventPosition;
    }
    if (this.faulted) for (let c = 0; c < out.length; c++) (out[c] as Float32Array).fill(0);
  }

  /** Applies the instrument's events due at or before `frame`. */
  private applyDue(k: InstrumentKernel, frame: number): void {
    const ev = this.ev;
    while (this.queue.peekFrame() <= frame && this.queue.shift(ev)) {
      if (this.faulted) continue;
      try {
        this.applyInstrumentEvent(k, ev);
      } catch (err) {
        this.fault(err);
      }
    }
  }

  private applyInstrumentEvent(k: InstrumentKernel, ev: QueuedEvent): void {
    switch (ev.type) {
      case EV_NOTE_ON:
        this.held++;
        k.noteOn(ev.key, ev.vel, ev.id, ev.pan, ev.fine);
        break;
      case EV_NOTE_OFF:
        if (this.held > 0) this.held--;
        k.noteOff(ev.id, ev.key, ev.vel);
        break;
      case EV_ALL_OFF:
      case EV_ALL_OFF_HARD:
        this.held = 0;
        k.allNotesOff(ev.type === EV_ALL_OFF_HARD);
        break;
      case EV_CC:
        k.controlChange?.(ev.key, ev.vel);
        break;
      case EV_PARAM:
        this.messageParams.set(ev.key, ev.vel);
        break;
      case EV_TRANSPORT:
        this.setTransport(ev);
        break;
    }
  }

  /** Applies the one transport anchor or param change at the head of the queue (a sleeping instrument). */
  private applyQuiet(): void {
    const ev = this.ev;
    if (!this.queue.shift(ev)) return;
    if (ev.type === EV_PARAM) this.messageParams.set(ev.key, ev.vel);
    else if (!this.faulted) {
      try {
        this.setTransport(ev);
      } catch (err) {
        this.fault(err);
      }
    }
  }

  /**
   * Applies the transport anchors and param changes queued up to `frame`, and the notes an effect follows (an
   * effect that doesn't implement the note methods drops them).
   */
  private applyEffectEvents(fx: EffectKernel, frame: number): void {
    const ev = this.ev;
    while (this.queue.peekFrame() <= frame && this.queue.shift(ev)) {
      if (ev.type === EV_PARAM) {
        this.messageParams.set(ev.key, ev.vel);
        continue;
      }
      if (this.faulted) continue;
      try {
        this.applyEffectEvent(fx, ev);
      } catch (err) {
        this.fault(err);
      }
    }
  }

  private applyEffectEvent(fx: EffectKernel, ev: QueuedEvent): void {
    switch (ev.type) {
      case EV_NOTE_ON:
        fx.noteOn?.(ev.key, ev.vel, ev.id);
        break;
      case EV_NOTE_OFF:
        fx.noteOff?.(ev.id, ev.key, ev.vel);
        break;
      case EV_ALL_OFF:
      case EV_ALL_OFF_HARD:
        fx.allNotesOff?.(ev.type === EV_ALL_OFF_HARD);
        break;
      case EV_TRANSPORT:
        this.setTransport(ev);
        break;
    }
  }

  /** `ev` is a transport anchor (see EV_TRANSPORT for the packing). */
  private setTransport(ev: QueuedEvent): void {
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
    const sc = this.sidechainFor(sidechain, out.length, n);
    if (this.faulted) {
      // A broken effect is bypassed rather than silencing the insert.
      this.bypass(out, inp, n);
    } else {
      try {
        k.process(inp, out, n, params, sc);
      } catch (err) {
        this.fault(err);
        this.bypass(out, inp, n);
      }
    }
    // Never keep the browser's input arrays past this call.
    this.padMain.length = 0;
    this.padSc.length = 0;
  }

  /** The sidechain input with as many channels as the output (undefined when the effect has none). */
  private sidechainFor(sidechain: Float32Array[] | undefined, channels: number, n: number): Float32Array[] | undefined {
    if (sidechain === undefined) return undefined;
    if (sidechain.length >= channels) return sidechain;
    return this.padInput(sidechain, channels, n, this.scSilence, this.padSc);
  }

  private bypass(out: Float32Array[], input: Float32Array[], n: number): void {
    for (let c = 0; c < out.length; c++) copyInto(out[c] as Float32Array, input[c] as Float32Array, n);
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
      const source = input[c] ?? input[0];
      into[c] = source ?? silence.get(c, n);
    }
    return into;
  }

  /** Silences a block with NaN or ±Infinity in it (and resets the kernel); returns the block's peak. */
  private scrub(out: Float32Array[]): number {
    let peak = 0;
    for (let c = 0; c < out.length; c++) {
      const channel = out[c] as Float32Array;
      for (let i = 0; i < channel.length; i++) {
        const x = channel[i] as number;
        const magnitude = x < 0 ? -x : x;
        if (magnitude > peak) peak = magnitude;
        // x - x is 0 for every finite number and NaN for NaN and the infinities.
        if (x - x !== 0) {
          this.silenceAfterBadSample(out);
          return 0;
        }
      }
    }
    return peak;
  }

  /** A NaN or infinity came out: silence the block, reset the kernel's state and report it once. */
  private silenceAfterBadSample(out: Float32Array[]): void {
    for (let c = 0; c < out.length; c++) (out[c] as Float32Array).fill(0);
    try {
      this.kernel.reset?.();
    } catch {
      /* ignore */
    }
    if (!this.nanReported) {
      this.nanReported = true;
      this.post({ t: 'nan' });
    }
  }

  private fault(err: unknown): void {
    if (this.faulted) return;
    this.faulted = true;
    this.post({ t: 'fault', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}
