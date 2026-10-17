import { describe, expect, it } from 'vitest';
import { beatPhase, phaseDiff, syncPlan } from '@core/dj/decks-math';
import { BLOCK_FRAMES, DECK_STATE_SLOTS } from './deck-id';
import { DeckKernel, newSnapshot, readDeckState } from './deck.kernel';

const SR = 48000;
const Q = 128;

function noise(frames: number, seed = 1): Float32Array {
  const x = new Float32Array(frames);
  let s = seed;
  for (let i = 0; i < frames; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = (s / 0xffffffff - 0.5) * 0.8;
  }
  return x;
}

/** A song held as a window: `slots` pool blocks, block b in slot `perm[b]` (a shuffle, so the mapping is exercised), loaded on demand. */
function windowed(song: Float32Array, opts: { slots?: number; resident?: (b: number) => boolean } = {}) {
  const blocks = Math.ceil(song.length / BLOCK_FRAMES);
  const slots = opts.slots ?? blocks;
  const poolL = new Float32Array(slots * BLOCK_FRAMES);
  const poolR = new Float32Array(slots * BLOCK_FRAMES);
  const table = new Int32Array(blocks).fill(-1);
  const perm = Array.from({ length: slots }, (_, i) => i).reverse();
  const k = new DeckKernel(SR);
  const buf = new SharedArrayBuffer(DECK_STATE_SLOTS * 8);
  const state = new Float64Array(buf);
  const seq = new Int32Array(buf, 0, 1);
  k.attachState(state, seq);
  k.setStream(poolL, poolR, table, song.length);
  const slotOf = new Map<number, number>();
  const load = (b: number) => {
    const slot = perm[slotOf.size % slots] as number;
    slotOf.set(b, slot);
    const part = song.subarray(b * BLOCK_FRAMES, (b + 1) * BLOCK_FRAMES);
    poolL.set(part, slot * BLOCK_FRAMES);
    poolR.set(part, slot * BLOCK_FRAMES);
    Atomics.store(table, b, slot);
  };
  const drop = (b: number) => Atomics.store(table, b, -1);
  for (let b = 0; b < blocks; b++) if (!opts.resident || opts.resident(b)) load(b);
  return { k, state, seq, load, drop, table, blocks };
}

function render(k: DeckKernel, frames: number, frame0 = 0): Float32Array {
  const l = new Float32Array(frames);
  const bl = new Float32Array(Q);
  const br = new Float32Array(Q);
  for (let o = 0; o < frames; o += Q) {
    const n = Math.min(Q, frames - o);
    k.process(bl, br, n, frame0 + o);
    l.set(bl.subarray(0, n), o);
  }
  return l;
}

function plainDeck(song: Float32Array) {
  const k = new DeckKernel(SR);
  k.setSong([song], song.length);
  return k;
}

const SONG = noise(BLOCK_FRAMES * 6 + 12345, 3);
/** A tone: smooth, so a click in the output shows as a step bigger than the tone's own (0.5 × 2π × 440 / 48000 = 0.029). */
const TONE = Float32Array.from({ length: BLOCK_FRAMES * 6 + 12345 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR));

describe('deck kernel: a song in a window of blocks', () => {
  it('plays exactly what the same song held whole plays: turntable, key lock, loops, seeks', () => {
    for (const keyLock of [false, true]) {
      for (const rate of [1, 1.07]) {
        const a = plainDeck(SONG);
        const b = windowed(SONG).k;
        for (const k of [a, b]) {
          k.setTempo(rate, keyLock);
          k.seek(BLOCK_FRAMES - 3000);
          k.play(true);
        }
        const run = (k: DeckKernel) => {
          const parts: Float32Array[] = [];
          parts.push(render(k, 9000));
          k.setLoop(BLOCK_FRAMES * 2 - 5000, 20000);
          parts.push(render(k, 60000, 9000));
          k.clearLoop();
          k.seek(BLOCK_FRAMES * 4 + 777);
          parts.push(render(k, 30000, 69000));
          return parts;
        };
        const pa = run(a);
        const pb = run(b);
        pa.forEach((x, i) => expect(Buffer.from(x.buffer).equals(Buffer.from((pb[i] as Float32Array).buffer))).toBe(true));
      }
    }
  });

  it('reads across block seams without a seam: a sine through the pool at 1.013× is as smooth as the sine', () => {
    const sine = new Float32Array(BLOCK_FRAMES * 3);
    for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const { k } = windowed(sine);
    k.setTempo(1.013, false);
    k.seek(BLOCK_FRAMES - 4000);
    k.play(true);
    const out = render(k, 9000);
    let worst = 0;
    for (let i = 300; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!));
    // A 1 kHz sine of 0.5 moves at most 0.5 × 2π × 1000 / 48000 = 0.065 per frame (×1.013).
    expect(worst).toBeLessThan(0.07);
  });

  it('fades out and waits when the audio ahead is not there, and fades back in where it left off when it arrives', () => {
    const present = (b: number) => b !== 2;
    const w = windowed(TONE, { resident: present });
    const { k } = w;
    k.seek(BLOCK_FRAMES * 2 - 90000);
    k.play(true);
    // Play until the playhead is about to reach the missing block: the deck stalls 0.3 s early, never in the middle of a sample.
    let frame = 0;
    const out: number[] = [];
    const quantum = () => {
      const l = new Float32Array(Q);
      k.process(l, new Float32Array(Q), Q, frame);
      frame += Q;
      out.push(...l);
    };
    while (!k.isStalled && frame < SR * 10) quantum();
    expect(k.isStalled).toBe(true);
    const stalledAt = k.pos;
    // It stopped well before the missing block, and the 2 ms fade left the sound at silence.
    expect(stalledAt).toBeLessThan(BLOCK_FRAMES * 2 - 0.2 * SR);
    for (let i = 0; i < 20; i++) quantum();
    const tailEnd = out.slice(-Q * 18);
    expect(Math.max(...tailEnd.map(Math.abs))).toBe(0);
    // It held still, silent, and says so.
    expect(k.pos).toBe(stalledAt);
    const snap = newSnapshot();
    readDeckState(w.state, w.seq, snap);
    expect(snap.stalled).toBe(true);
    expect(snap.rate).toBe(0);
    // The audio arrives: it picks up at the same spot (a fade in), not skipping what it missed.
    w.load(2);
    const at = out.length;
    for (let i = 0; i < 40; i++) quantum();
    expect(k.isStalled).toBe(false);
    const resumed = out.slice(at);
    const first = resumed.findIndex((v) => v !== 0);
    expect(first).toBeGreaterThanOrEqual(0);
    // Nothing is louder than the song (no click), and it comes in smoothly over 2 ms.
    const step = (a: number[]) => a.reduce((m, v, i) => (i === 0 ? m : Math.max(m, Math.abs(v - (a[i - 1] as number)))), 0);
    expect(step(resumed.slice(first, first + 96))).toBeLessThan(0.04);
    // Sample-exact continuation after the fade: the position where it stopped.
    const settleAt = first + 200;
    expect(Math.abs(resumed[settleAt]! - TONE[Math.round(stalledAt) + settleAt]!)).toBeLessThan(1e-6);
  });

  it('a seek outside the window waits for its blocks, fades in there, and the sound before it fades out', () => {
    const present = (b: number) => b < 2;
    const w = windowed(TONE, { resident: present });
    const { k } = w;
    k.seek(1000);
    k.play(true);
    let frame = 0;
    const out: number[] = [];
    const quantum = () => {
      const l = new Float32Array(Q);
      k.process(l, new Float32Array(Q), Q, frame);
      frame += Q;
      out.push(...l);
    };
    for (let i = 0; i < 100; i++) quantum();
    const before = out.length;
    k.seek(BLOCK_FRAMES * 4 + 5000);
    for (let i = 0; i < 100; i++) quantum();
    // The old sound was faded out over a couple of ms, then silence while the new blocks are not there.
    const gap = out.slice(before);
    const quiet = gap.slice(Math.round(0.004 * SR));
    expect(Math.max(...quiet.map(Math.abs))).toBe(0);
    const stepOut = gap.slice(0, 120).reduce((m, v, i) => (i === 0 ? m : Math.max(m, Math.abs(v - (gap[i - 1] as number)))), 0);
    expect(stepOut).toBeLessThan(0.04);
    expect(k.isStalled).toBe(true);
    w.load(4);
    w.load(5);
    for (let i = 0; i < 50; i++) quantum();
    expect(k.isStalled).toBe(false);
    const after = out.slice(before + gap.length);
    // Playing again from the target: the song's samples (after the fade in), not from the old place.
    const target = BLOCK_FRAMES * 4 + 5000;
    const startAt = after.findIndex((v) => v !== 0);
    expect(startAt).toBeGreaterThanOrEqual(0);
    const idx = startAt + 300;
    expect(after[idx]).toBeCloseTo(TONE[target + idx]!, 5);
  });

  it('a loop reads past its end from its start through the pool, and a missing loop block stalls instead of garbling', () => {
    const w = windowed(SONG);
    const { k } = w;
    const start = BLOCK_FRAMES - 4000;
    const len = BLOCK_FRAMES + 8000;
    k.seek(start);
    k.play(true);
    render(k, 500);
    k.setLoop(start, len);
    const out = render(k, len * 2 + 1000, 500);
    for (let i = 0; i < out.length; i += 997) expect(out[i]).toBe(SONG[start + ((500 + i) % len)]);
    // Now the second block of the loop goes away: the deck stops before it, silently.
    w.drop(1);
    let stalled = false;
    for (let o = 0; o < len * 2 && !stalled; o += Q) {
      render(k, Q, 100000 + o);
      stalled = k.isStalled;
    }
    expect(stalled).toBe(true);
  });
});

describe('deck kernel: sync with a master that waits for audio', () => {
  /** A click (3 ms burst) on every beat from `first`. */
  const clicks = (bpm: number, first: number, seconds: number) => {
    const x = new Float32Array(Math.round(seconds * SR));
    const beat = (60 / bpm) * SR;
    for (let b = 0; first * SR + b * beat < x.length; b++) {
      const at = Math.round(first * SR + b * beat);
      for (let k = 0; k < 150 && at + k < x.length; k++) x[at + k] = 0.9 * Math.exp(-k / 30) * (k % 2 ? -1 : 1);
    }
    return x;
  };

  it('the follower lands on the master’s beat again when the master has its audio back', () => {
    const master = windowed(clicks(124, 0.1, 40), { resident: (b) => b !== 25 });
    const follower = new DeckKernel(SR);
    const fSong = clicks(128, 0.35, 40);
    const fb = new SharedArrayBuffer(DECK_STATE_SLOTS * 8);
    follower.attachState(new Float64Array(fb), new Int32Array(fb, 0, 1));
    follower.setSong([fSong], fSong.length);
    const plan = syncPlan(124, 128);
    follower.setSync({
      master: master.state.buffer as SharedArrayBuffer,
      ratio: 124 / (128 * plan.multiple),
      selfFirst: 0.35 * SR,
      selfBeat: plan.beatSec * SR,
      masterFirst: 0.1 * SR,
      masterBeat: (60 / 124) * SR,
    });
    follower.setTempo(1 + plan.pitch, false);
    master.k.seek(10 * SR);
    follower.seek(12.3 * SR);
    master.k.play(true);
    const bl = new Float32Array(Q);
    const br = new Float32Array(Q);
    master.k.process(bl, br, Q, 0);
    follower.play(true);
    let frame = Q;
    const step = () => {
      master.k.process(bl, br, Q, frame);
      follower.process(bl, br, Q, frame);
      frame += Q;
    };
    // The master reaches block 25 (frame 1.64 M ≈ 34 s: it is at 10 s, so play 24 s) and waits.
    while (!master.k.isStalled && frame < 40 * SR) step();
    expect(master.k.isStalled).toBe(true);
    const mAt = master.k.pos;
    // The follower keeps playing on its own for half a second, then the master's audio arrives.
    for (let i = 0; i < Math.round(0.5 * SR / Q); i++) step();
    expect(master.k.pos).toBe(mAt);
    master.load(25);
    for (let i = 0; i < Math.round(3 * SR / Q); i++) step();
    expect(master.k.isStalled).toBe(false);
    // Both on the same beat again: the follower was moved to the master's beat, not left half a second out.
    const ms = newSnapshot();
    const fs = newSnapshot();
    readDeckState(master.state, master.seq, ms);
    readDeckState(new Float64Array(fb), new Int32Array(fb, 0, 1), fs);
    const mp = ms.pos + (frame - Q - ms.frame) * ms.rate;
    const fp = fs.pos + (frame - Q - fs.frame) * fs.rate;
    const err = phaseDiff(beatPhase(fp / SR, 0.35, plan.beatSec), beatPhase(mp / SR, 0.1, 60 / 124));
    expect(Math.abs(err * (60 / 124) * 1000)).toBeLessThan(2);
  });
});
