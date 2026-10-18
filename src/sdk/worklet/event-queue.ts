import { EV_ALL_OFF, EV_ALL_OFF_HARD, EV_NOTE_OFF, EV_NOTE_ON, EV_STRIDE, EV_TRANSPORT } from '../protocol';

/** One event as `shift` hands it out (see protocol.ts for what the fields mean per event type). */
export interface QueuedEvent {
  type: number;
  frame: number;
  id: number;
  key: number;
  vel: number;
  pan: number;
  fine: number;
}

/**
 * Frame-sorted note event queue for the audio thread. Storage is preallocated (it only grows if a
 * burst exceeds capacity). Implements the SDK's cancellation rule: a noteOff timed at or before its
 * pending noteOn cancels the note entirely.
 */
export class EventQueue {
  private frames: Float64Array;
  private types: Int32Array;
  private ids: Float64Array;
  private keys: Float32Array;
  private vels: Float32Array;
  private pans: Float32Array;
  private fines: Float32Array;
  private head = 0;
  private size = 0;

  constructor(capacity = 1024) {
    this.frames = new Float64Array(capacity);
    this.types = new Int32Array(capacity);
    this.ids = new Float64Array(capacity);
    this.keys = new Float32Array(capacity);
    this.vels = new Float32Array(capacity);
    this.pans = new Float32Array(capacity);
    this.fines = new Float32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  /** Frame of the earliest event, or +Infinity when empty. */
  peekFrame(): number {
    return this.size > 0 ? (this.frames[this.head] as number) : Infinity;
  }

  /** Type of the earliest event (EV_*), or 0 when empty. */
  peekType(): number {
    return this.size > 0 ? (this.types[this.head] as number) : 0;
  }

  /** Adds packed events (see protocol.ts). */
  pushPacked(data: Float64Array): void {
    for (let i = 0; i + EV_STRIDE <= data.length; i += EV_STRIDE) {
      this.push(
        data[i] as number,
        data[i + 1] as number,
        data[i + 2] as number,
        data[i + 3] as number,
        data[i + 4] as number,
        data[i + 5] as number,
        data[i + 6] as number,
      );
    }
  }

  /**
   * Adds one event. A note off at or before its pending note on cancels the note; an all-notes-off
   * drops everything queued at or after its frame; a re-planned transport anchor (`pan` 1) drops the
   * stale anchors. The event then goes in after any with the same frame.
   */
  push(type: number, frame: number, id: number, key: number, vel: number, pan: number, fine = 0): void {
    if (type === EV_NOTE_OFF) {
      if (this.cancelPendingNoteOn(id, frame)) return;
    } else if (type === EV_ALL_OFF || type === EV_ALL_OFF_HARD) {
      this.dropFrom(frame, null);
    } else if (type === EV_TRANSPORT && pan === 1) {
      this.dropFrom(frame, EV_TRANSPORT);
    }
    if (this.size === this.frames.length) this.grow();
    const slot = this.index(this.insertionPoint(frame));
    this.frames[slot] = frame;
    this.types[slot] = type;
    this.ids[slot] = id;
    this.keys[slot] = key;
    this.vels[slot] = vel;
    this.pans[slot] = pan;
    this.fines[slot] = fine;
    this.size++;
  }

  /** Removes the note on of note `id` if it starts at or after `offFrame`; true when it was found. */
  private cancelPendingNoteOn(id: number, offFrame: number): boolean {
    for (let k = 0; k < this.size; k++) {
      const j = this.index(k);
      if (this.types[j] === EV_NOTE_ON && this.ids[j] === id && offFrame <= (this.frames[j] as number)) {
        this.removeAt(k);
        return true;
      }
    }
    return false;
  }

  /** Removes the events at or after `frame`: all of them, or only those of type `onlyType`. */
  private dropFrom(frame: number, onlyType: number | null): void {
    let k = 0;
    while (k < this.size) {
      const j = this.index(k);
      const isStale = (this.frames[j] as number) >= frame && (onlyType === null || this.types[j] === onlyType);
      if (isStale) this.removeAt(k);
      else k++;
    }
  }

  /**
   * Makes room at the queue position for an event of `frame`, after any events with the same frame
   * (which keeps arrival order); returns that position.
   */
  private insertionPoint(frame: number): number {
    let low = 0;
    let high = this.size;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.frames[this.index(middle)] as number) <= frame) low = middle + 1;
      else high = middle;
    }
    for (let k = this.size; k > low; k--) this.copy(this.index(k), this.index(k - 1));
    return low;
  }

  /** Removes the earliest event; call peek* before. */
  shift(out: QueuedEvent): boolean {
    if (this.size === 0) return false;
    const j = this.head;
    out.type = this.types[j] as number;
    out.frame = this.frames[j] as number;
    out.id = this.ids[j] as number;
    out.key = this.keys[j] as number;
    out.vel = this.vels[j] as number;
    out.pan = this.pans[j] as number;
    out.fine = this.fines[j] as number;
    this.head = (this.head + 1) % this.frames.length;
    this.size--;
    return true;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  private index(k: number): number {
    return (this.head + k) % this.frames.length;
  }

  private copy(to: number, from: number): void {
    this.frames[to] = this.frames[from] as number;
    this.types[to] = this.types[from] as number;
    this.ids[to] = this.ids[from] as number;
    this.keys[to] = this.keys[from] as number;
    this.vels[to] = this.vels[from] as number;
    this.pans[to] = this.pans[from] as number;
    this.fines[to] = this.fines[from] as number;
  }

  private removeAt(k: number): void {
    for (let m = k; m < this.size - 1; m++) this.copy(this.index(m), this.index(m + 1));
    this.size--;
  }

  private grow(): void {
    const n = this.frames.length * 2;
    const order = Array.from({ length: this.size }, (_, k) => this.index(k));
    const remap = <T extends Float64Array | Int32Array | Float32Array>(src: T, make: (n: number) => T): T => {
      const dst = make(n);
      order.forEach((j, k) => (dst[k] = src[j] as number));
      return dst;
    };
    this.frames = remap(this.frames, (m) => new Float64Array(m));
    this.types = remap(this.types, (m) => new Int32Array(m));
    this.ids = remap(this.ids, (m) => new Float64Array(m));
    this.keys = remap(this.keys, (m) => new Float32Array(m));
    this.vels = remap(this.vels, (m) => new Float32Array(m));
    this.pans = remap(this.pans, (m) => new Float32Array(m));
    this.fines = remap(this.fines, (m) => new Float32Array(m));
    this.head = 0;
  }
}
