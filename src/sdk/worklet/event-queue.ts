import { EV_ALL_OFF, EV_ALL_OFF_HARD, EV_NOTE_OFF, EV_NOTE_ON, EV_STRIDE, EV_TRANSPORT } from '../protocol';

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

  push(type: number, frame: number, id: number, key: number, vel: number, pan: number, fine = 0): void {
    if (type === EV_NOTE_OFF) {
      // Cancel a note that has not started yet.
      for (let k = 0; k < this.size; k++) {
        const j = this.index(k);
        if (this.types[j] === EV_NOTE_ON && this.ids[j] === id && frame <= (this.frames[j] as number)) {
          this.removeAt(k);
          return;
        }
      }
    } else if (type === EV_ALL_OFF || type === EV_ALL_OFF_HARD) {
      // Drop everything already queued at or after this frame.
      let k = 0;
      while (k < this.size) {
        if ((this.frames[this.index(k)] as number) >= frame) this.removeAt(k);
        else k++;
      }
    } else if (type === EV_TRANSPORT && pan === 1) {
      // A re-planned transport: the anchors queued from this frame on are stale.
      let k = 0;
      while (k < this.size) {
        const j = this.index(k);
        if (this.types[j] === EV_TRANSPORT && (this.frames[j] as number) >= frame) this.removeAt(k);
        else k++;
      }
    }
    if (this.size === this.frames.length) this.grow();
    // Insert after any events with the same frame (keeps arrival order).
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.frames[this.index(mid)] as number) <= frame) lo = mid + 1;
      else hi = mid;
    }
    for (let k = this.size; k > lo; k--) this.copy(this.index(k), this.index(k - 1));
    const j = this.index(lo);
    this.frames[j] = frame;
    this.types[j] = type;
    this.ids[j] = id;
    this.keys[j] = key;
    this.vels[j] = vel;
    this.pans[j] = pan;
    this.fines[j] = fine;
    this.size++;
  }

  /** Removes the earliest event; call peek* before. */
  shift(out: {
    type: number;
    frame: number;
    id: number;
    key: number;
    vel: number;
    pan: number;
    fine: number;
  }): boolean {
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
