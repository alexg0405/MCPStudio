/**
 * A deck's song as a window of blocks in shared memory, kept filled around the play position. The song is cut into blocks
 * of 2^16 frames (`BLOCK_BITS`); a pool of slots holds the blocks around the play position (half a minute behind, a
 * minute and a half ahead) and the places the deck may jump to (the cue point, the hot cues, the loop: pinned), and
 * the player (`deck.kernel.ts`) finds a block through a table in the same shared memory. Memory is the pool, whatever
 * the song's length: ~80 MB at 48 kHz stereo for a 5-minute song or a 2-hour one.
 *
 * This runs on the main thread: it decides what is wanted (`core/dj/deck-window.ts`, most urgent first), reads it from
 * the `DeckSource` (a copy out of a decoded buffer, or a decode of a few seconds of a file) and puts it in a slot; the
 * table entry is set after the audio is written and cleared before a slot is reused, so the player never reads a block
 * that is being overwritten (it only reads near the play position, which is never evicted). A jump outside the
 * window makes the player wait, silent, until `moveTo`'s blocks arrive; a jump to somewhere pinned needs no wait.
 */
import { blockRange, planWindow, poolSlots, URGENT_AHEAD, type BlockPins } from '@core/dj/deck-window';
import { yieldToMain } from '../audio-buffers';
import { BLOCK_BITS, BLOCK_FRAMES } from './deck-id';
import type { DeckSource } from './deck-source';

/** How much of a song a window holds around the play position, and how many slots are kept for pinned places. */
export interface DeckStreamOptions {
  behindSec?: number;
  aheadSec?: number;
  /** Slots reserved for pinned places (cue points, hot cues, a loop). */
  pinSlots?: number;
  /** The most seconds one pinned place keeps (a loop longer than this is kept from its start). */
  maxPinSec?: number;
  /** Called whenever a block has been loaded (tests, progress). */
  onLoad?: (block: number) => void;
}

/** Frames are pinned for this long before their start too, so a cue that sits a little before its beat is whole. */
const PIN_LEAD_SEC = 0.1;

/** A place in the song (frames) the window keeps loaded. */
export interface PinnedPlace {
  startFrame: number;
  endFrame: number;
}

/** A deck's song as a window of blocks in shared memory, kept filled around the play position (see the file comment). */
export class DeckStream {
  readonly frames: number;
  readonly sampleRate: number;
  readonly blocks: number;
  readonly slots: number;
  readonly poolL: SharedArrayBuffer;
  readonly poolR: SharedArrayBuffer;
  readonly table: SharedArrayBuffer;
  private readonly tableView: Int32Array;
  private readonly viewL: Float32Array;
  private readonly viewR: Float32Array;
  private readonly stereo: boolean;
  private readonly slotBlock: Int32Array;
  private readonly free: number[] = [];
  private readonly behind: number;
  private readonly ahead: number;
  private readonly pinSlots: number;
  private readonly tmpL = new Float32Array(BLOCK_FRAMES);
  private readonly tmpR = new Float32Array(BLOCK_FRAMES);
  private playBlock = 0;
  private audioBlock = 0;
  private direction: 1 | -1 = 1;
  private pins: BlockPins[] = [];
  private plan: number[] = [];
  private planSet = new Set<number>();
  private pumping = false;
  private disposed = false;
  private loaded = 0;
  private evicted = 0;
  private readonly failedAt = new Map<number, number>();
  private readonly waiters: { first: number; last: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  private readonly onLoad: ((block: number) => void) | undefined;
  private readonly maxPinFrames: number;

  constructor(
    readonly source: DeckSource,
    opts: DeckStreamOptions = {},
  ) {
    this.frames = source.frames;
    this.sampleRate = source.sampleRate;
    this.blocks = Math.max(1, Math.ceil(source.frames / BLOCK_FRAMES));
    const size = poolSlots({
      sampleRate: source.sampleRate,
      blockFrames: BLOCK_FRAMES,
      behindSec: opts.behindSec ?? 30,
      aheadSec: opts.aheadSec ?? 90,
      pinSlots: opts.pinSlots ?? 57,
    });
    this.behind = size.behind;
    this.ahead = size.ahead;
    this.pinSlots = opts.pinSlots ?? 57;
    this.maxPinFrames = Math.round((opts.maxPinSec ?? 45) * source.sampleRate);
    // A song that fits is held whole; a longer one gets the window.
    this.slots = Math.min(this.blocks, size.slots);
    this.stereo = source.channels === 2;
    this.poolL = new SharedArrayBuffer(this.slots * BLOCK_FRAMES * 4);
    this.poolR = this.stereo ? new SharedArrayBuffer(this.slots * BLOCK_FRAMES * 4) : this.poolL;
    this.table = new SharedArrayBuffer(this.blocks * 4);
    this.viewL = new Float32Array(this.poolL);
    this.viewR = this.stereo ? new Float32Array(this.poolR) : this.viewL;
    this.tableView = new Int32Array(this.table).fill(-1);
    this.slotBlock = new Int32Array(this.slots).fill(-1);
    for (let s = this.slots - 1; s >= 0; s--) this.free.push(s);
    this.onLoad = opts.onLoad;
    this.replan();
  }

  /** Bytes of shared memory the pool and table hold. */
  get bytes(): number {
    return this.poolL.byteLength + (this.stereo ? this.poolR.byteLength : 0) + this.table.byteLength;
  }

  /** Blocks in the window now, and how many were ever loaded or evicted. */
  stats(): { resident: number; loaded: number; evicted: number; slots: number } {
    return { resident: this.slots - this.free.length, loaded: this.loaded, evicted: this.evicted, slots: this.slots };
  }

  isResident(block: number): boolean {
    return block >= 0 && block < this.blocks && Atomics.load(this.tableView, block) >= 0;
  }

  /** Every block under frames [from, to) is in the window. */
  covers(from: number, to: number): boolean {
    const r = blockRange(Math.max(0, from), Math.min(this.frames, to), BLOCK_FRAMES, this.blocks);
    if (!r) return true;
    for (let b = r.first; b <= r.last; b++) if (!this.isResident(b)) return false;
    return true;
  }

  /** The playhead was put at `frame` (a seek, a cue, a jump): load what is around it first. */
  moveTo(frame: number): void {
    if (this.disposed) return;
    this.setPlay(frame, 1, true);
    // A source in memory fills the blocks about to be heard before the jump is made, so it needs no wait at all.
    if (this.source.readSync) {
      for (let i = 0; i < Math.min(this.plan.length, URGENT_AHEAD + 2); i++) {
        const b = this.plan[i] as number;
        if (!this.isResident(b)) this.loadSync(b);
      }
    }
    void this.pump();
  }

  /** Where the player is now (published by the audio thread) and which way it is heading: keeps the window with it. */
  update(frame: number, rate = 1): void {
    if (this.disposed) return;
    this.setPlay(frame, rate < 0 ? -1 : 1, false);
  }

  /** The places the deck may jump to: kept loaded (cue points, hot cues, the loop). Replaces the pins; nearest are kept if they don't all fit. */
  setPins(places: readonly PinnedPlace[]): void {
    const lead = Math.round(PIN_LEAD_SEC * this.sampleRate);
    const ranges: BlockPins[] = [];
    for (const p of places) {
      const end = Math.min(p.endFrame, p.startFrame + this.maxPinFrames);
      const r = blockRange(p.startFrame - lead, Math.max(end, p.startFrame + 1), BLOCK_FRAMES, this.blocks);
      if (r) ranges.push(r);
    }
    this.pins = ranges;
    this.replan();
    void this.pump();
  }

  /** Resolves when every block under frames [from, to) is in the window (rejects if the stream is disposed first). */
  whenResident(from: number, to: number): Promise<void> {
    const r = blockRange(Math.max(0, from), Math.min(this.frames, to), BLOCK_FRAMES, this.blocks);
    if (!r || this.covers(from, to)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.push({ first: r.first, last: r.last, resolve, reject });
      void this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.waiters.splice(0)) w.reject(new Error('The deck’s song was closed.'));
    this.source.dispose();
  }

  // ---- Internals ----

  private setPlay(frame: number, dir: 1 | -1, jumped: boolean): void {
    const b = Math.max(0, Math.min(this.blocks - 1, frame >>> BLOCK_BITS));
    const moved = b !== this.playBlock || dir !== this.direction;
    if (!jumped) this.audioBlock = b;
    this.playBlock = b;
    this.direction = dir;
    if (moved || jumped) {
      this.replan();
      void this.pump();
    }
  }

  private replan(): void {
    // The pool keeps a few slots free of plan so a block can always be loaded.
    this.plan = planWindow({
      blocks: this.blocks,
      playBlock: this.playBlock,
      direction: this.direction,
      behind: this.behind,
      ahead: this.ahead,
      pins: this.pins,
      capacity: Math.max(1, this.slots - 1),
    });
    this.planSet = new Set(this.plan);
  }

  /** A slot for block `b`: a free one, or the one of the farthest block that is not wanted (and not at the audio position). */
  private takeSlot(): number {
    const s = this.free.pop();
    if (s !== undefined) return s;
    let victim = -1;
    let far = -1;
    for (let slot = 0; slot < this.slots; slot++) {
      const vb = this.slotBlock[slot] as number;
      if (vb < 0 || this.planSet.has(vb)) continue;
      // The block the player is on, and its neighbours, are never taken.
      if (Math.abs(vb - this.audioBlock) <= 3 || Math.abs(vb - this.playBlock) <= 3) continue;
      const d = Math.abs(vb - this.playBlock);
      if (d > far) {
        far = d;
        victim = slot;
      }
    }
    if (victim < 0) return -1;
    // Out of the table first, then the slot is free to overwrite.
    Atomics.store(this.tableView, this.slotBlock[victim] as number, -1);
    this.slotBlock[victim] = -1;
    this.evicted++;
    return victim;
  }

  private commit(b: number): void {
    if (this.isResident(b)) return;
    const slot = this.takeSlot();
    if (slot < 0) return;
    this.viewL.set(this.tmpL, slot * BLOCK_FRAMES);
    if (this.stereo) this.viewR.set(this.tmpR, slot * BLOCK_FRAMES);
    this.slotBlock[slot] = b;
    Atomics.store(this.tableView, b, slot);
    this.loaded++;
    this.onLoad?.(b);
    this.wake();
  }

  private loadSync(b: number): void {
    (this.source.readSync as NonNullable<DeckSource['readSync']>)(b * BLOCK_FRAMES, BLOCK_FRAMES, this.tmpL, this.tmpR);
    this.commit(b);
  }

  private wake(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i] as (typeof this.waiters)[number];
      let all = true;
      for (let b = w.first; b <= w.last && all; b++) all = this.isResident(b);
      if (all) {
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  private nextWanted(): number {
    const now = Date.now();
    for (const b of this.plan) {
      if (this.isResident(b)) continue;
      const bad = this.failedAt.get(b);
      if (bad !== undefined && now - bad < 2000) continue;
      return b;
    }
    return -1;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    let sinceYield = 0;
    try {
      for (;;) {
        if (this.disposed) return;
        const b = this.nextWanted();
        if (b < 0) return;
        try {
          if (this.source.readSync) this.loadSync(b);
          else {
            await this.source.read(b * BLOCK_FRAMES, BLOCK_FRAMES, this.tmpL, this.tmpR);
            if (this.disposed) return;
            // What is wanted may have changed while it was read: still keep it if a slot is free or can be taken.
            this.commit(b);
          }
          this.failedAt.delete(b);
        } catch (e) {
          console.warn('Couldn’t read a stretch of the song', e);
          this.failedAt.set(b, Date.now());
          await yieldToMain();
        }
        // Don't hold the page while a window of in-memory blocks is copied.
        if (this.source.readSync && ++sinceYield >= 6) {
          sinceYield = 0;
          await yieldToMain();
        }
        if (!this.isResident(b) && !this.failedAt.has(b)) {
          // No slot could be had (everything left is wanted): stop instead of spinning.
          this.failedAt.set(b, Date.now());
        }
      }
    } finally {
      this.pumping = false;
      // A change that came in while the last block was loading.
      if (!this.disposed && this.nextWanted() >= 0) {
        setTimeout(() => void this.pump(), 50);
      }
    }
  }
}
