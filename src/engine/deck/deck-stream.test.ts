import { describe, expect, it } from 'vitest';
import { BLOCK_FRAMES } from './deck-id';
import type { DeckSource } from './deck-source';
import { DeckStream } from './deck-stream';

const SR = 48000;

/** A song whose sample at frame i is (i mod 997) / 997 + the block number as a tag: any block read from it can be checked. */
function fakeSource(frames: number, opts: { delayMs?: number; immediate?: boolean; stereo?: boolean } = {}): DeckSource & { reads: number[]; disposed: boolean } {
  const reads: number[] = [];
  const value = (i: number) => (i % 997) / 997;
  const fill = (start: number, n: number, l: Float32Array, r: Float32Array) => {
    for (let k = 0; k < n; k++) {
      const i = start + k;
      const v = i >= 0 && i < frames ? value(i) : 0;
      l[k] = v;
      r[k] = v * 0.5;
    }
  };
  const src = {
    frames,
    sampleRate: SR,
    channels: (opts.stereo === false ? 1 : 2) as 1 | 2,
    nativeFrames: frames,
    nativeRate: SR,
    immediate: opts.immediate ?? false,
    reads,
    disposed: false,
    async read(start: number, n: number, l: Float32Array, r: Float32Array) {
      reads.push(start / BLOCK_FRAMES);
      if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
      fill(start, n, l, r);
    },
    async readNative(start: number, n: number, l: Float32Array, r: Float32Array) {
      fill(start, n, l, r);
    },
    dispose() {
      src.disposed = true;
    },
  };
  if (opts.immediate) Object.assign(src, { readSync: (s: number, n: number, l: Float32Array, r: Float32Array) => (reads.push(s / BLOCK_FRAMES), fill(s, n, l, r)) });
  return src as DeckSource & { reads: number[]; disposed: boolean };
}

const BLOCKS_2H = Math.ceil((2 * 3600 * SR) / BLOCK_FRAMES);

describe('DeckStream', () => {
  it('holds a window of a 2-hour song in a fixed pool: about 80 MB, however long the song', () => {
    const s = new DeckStream(fakeSource(2 * 3600 * SR));
    expect(s.blocks).toBe(BLOCKS_2H);
    // 150-odd slots of 2 channels × 65536 frames × 4 bytes, plus a table of 5300 entries.
    expect(s.bytes / 1e6).toBeLessThan(85);
    expect(s.slots).toBeLessThan(160);
    const five = new DeckStream(fakeSource(5 * 60 * SR));
    expect(five.slots).toBe(s.slots);
    // A short song is held whole, no bigger than it is.
    const short = new DeckStream(fakeSource(30 * SR));
    expect(short.slots).toBe(Math.ceil((30 * SR) / BLOCK_FRAMES));
    // A mono song shares one array for both channels.
    const mono = new DeckStream(fakeSource(10 * 60 * SR, { stereo: false }));
    expect(mono.poolR).toBe(mono.poolL);
    expect(mono.bytes / 1e6).toBeLessThan(45);
  });

  it('loads what is about to be heard first, then the window ahead and behind, and then goes quiet', async () => {
    const src = fakeSource(2 * 3600 * SR);
    const s = new DeckStream(src);
    const mid = 2000;
    s.moveTo(mid * BLOCK_FRAMES + 100);
    await s.whenResident(mid * BLOCK_FRAMES, (mid + 4) * BLOCK_FRAMES);
    expect(src.reads.slice(0, 4)).toEqual([mid, mid + 1, mid + 2, mid + 3]);
    // Wait for the rest of the window.
    await new Promise((r) => setTimeout(r, 200));
    const n = src.reads.length;
    expect(s.covers((mid - 20) * BLOCK_FRAMES, (mid + 60) * BLOCK_FRAMES)).toBe(true);
    expect(s.isResident(mid - 40)).toBe(false);
    expect(s.isResident(mid + 100)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(src.reads.length).toBe(n);
    // The audio in the pool is the song's: a frame read through the table.
    const table = new Int32Array(s.table);
    const pool = new Float32Array(s.poolL);
    const frame = mid * BLOCK_FRAMES + 12345;
    expect(pool[table[mid]! * BLOCK_FRAMES + 12345]).toBeCloseTo((frame % 997) / 997, 6);
    const poolR = new Float32Array(s.poolR);
    expect(poolR[table[mid]! * BLOCK_FRAMES + 12345]).toBeCloseTo(((frame % 997) / 997) * 0.5, 6);
    s.dispose();
    expect(src.disposed).toBe(true);
  });

  it('follows the playhead: the window moves on and the blocks it left are given up, never more than the pool', async () => {
    const src = fakeSource(2 * 3600 * SR, { immediate: true });
    const s = new DeckStream(src);
    s.moveTo(0);
    await new Promise((r) => setTimeout(r, 100));
    let frame = 0;
    // Play 10 minutes at the speed of the real thing, told where the player is five times a second.
    for (let t = 0; t < 600; t += 0.2) {
      frame = Math.round(t * SR);
      s.update(frame, 1);
      if (t % 20 < 0.2) await new Promise((r) => setTimeout(r, 30));
      // The block under the playhead and the next few seconds are always there.
      if (t > 1) expect(s.covers(frame, frame + 3 * SR)).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 100));
    const st = s.stats();
    expect(st.resident).toBeLessThanOrEqual(st.slots);
    expect(st.evicted).toBeGreaterThan(100);
    expect(s.isResident(0)).toBe(false);
    expect(s.covers(frame - 25 * SR, frame + 80 * SR)).toBe(true);
  });

  it('keeps the places it may jump to loaded, however far the playhead goes', async () => {
    const s = new DeckStream(fakeSource(2 * 3600 * SR, { immediate: true }));
    const cue = 3000 * SR;
    const hot = 5000 * SR;
    s.moveTo(0);
    s.setPins([
      { startFrame: cue, endFrame: cue + 2.8 * SR },
      { startFrame: hot, endFrame: hot + 2.8 * SR },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    for (let t = 0; t < 400; t += 0.5) {
      s.update(Math.round(t * SR), 1);
      if (t % 25 === 0) await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(s.covers(cue, cue + 2.8 * SR)).toBe(true);
    expect(s.covers(hot - 0.05 * SR, hot + 2.8 * SR)).toBe(true);
    // Jumping to a pinned place needs no wait; clearing the pins lets them go.
    s.setPins([]);
    for (let t = 400; t < 800; t += 0.5) {
      s.update(Math.round(t * SR), 1);
      if (t % 25 === 0) await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(s.covers(cue, cue + 2.8 * SR)).toBe(false);
  });

  it('a jump far away from a source that is not in memory waits for its first blocks only', async () => {
    const src = fakeSource(2 * 3600 * SR, { delayMs: 5 });
    const s = new DeckStream(src);
    s.moveTo(0);
    await s.whenResident(0, 3 * SR);
    const t0 = Date.now();
    const target = 5400 * SR;
    s.moveTo(target);
    await s.whenResident(target - 0.1 * SR, target + 2 * SR);
    // Two or three blocks at 5 ms each, not the window.
    expect(Date.now() - t0).toBeLessThan(400);
    expect(src.reads.slice(-3)[0]).toBeGreaterThanOrEqual(Math.floor(target / BLOCK_FRAMES) - 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.covers(target, target + 80 * SR)).toBe(true);
    s.dispose();
  });

  it('rejects waiters when it is disposed, and survives a source that fails', async () => {
    const src = fakeSource(60 * SR, { delayMs: 20 });
    const s = new DeckStream(src);
    const w = s.whenResident(0, 10 * SR);
    s.dispose();
    await expect(w).rejects.toThrow();
    let calls = 0;
    const bad = fakeSource(60 * SR);
    const real = bad.read.bind(bad);
    bad.read = async (...a) => {
      if (calls++ === 0) throw new Error('boom');
      return real(...a);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const s2 = new DeckStream(bad);
      s2.moveTo(0);
      await s2.whenResident(BLOCK_FRAMES, 2 * BLOCK_FRAMES);
      expect(s2.isResident(1)).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
