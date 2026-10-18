import { describe, expect, it } from 'vitest';
import { BeatMap, driftingBeats } from '@core/dj/beat-map';
import { syncPlan } from '@core/dj/decks-math';
import { DECK_STATE_SLOTS } from './deck-id';
import { newSnapshot, readDeckState } from './deck-snapshot';
import { DeckKernel } from './deck.kernel';

const SR = 48000;
const Q = 128;

/** A song with a click on each of `beats` (seconds). */
function clicksAt(beats: readonly number[], seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (const t of beats) {
    const at = Math.round(t * SR);
    for (let k = 0; k < 150 && at + k < x.length; k++) x[at + k] = (x[at + k] ?? 0) + 0.9 * Math.exp(-k / 30) * (k % 2 ? -1 : 1);
  }
  return x;
}

function steadyBeats(bpm: number, first: number, seconds: number): number[] {
  const out: number[] = [];
  for (let t = first; t < seconds; t += 60 / bpm) out.push(t);
  return out;
}

function deckOf(song: Float32Array) {
  const k = new DeckKernel(SR);
  const buf = new SharedArrayBuffer(DECK_STATE_SLOTS * 8);
  const state = new Float64Array(buf);
  const seq = new Int32Array(buf, 0, 1);
  k.attachState(state, seq);
  k.setSong([song], song.length);
  return { k, buf, state, seq };
}

const frames = (b: readonly number[]) => Float64Array.from(b, (t) => t * SR);

interface Song {
  beats: number[];
  /** The one-number tempo a fixed grid would be given (the average). */
  avgBpm: number;
}

const drifting = (bpm0: number, bpm1: number, seconds: number, first: number): Song => {
  const beats = driftingBeats(bpm0, bpm1, seconds, first);
  return { beats, avgBpm: ((beats.length - 1) * 60) / ((beats[beats.length - 1] as number) - (beats[0] as number)) };
};
const steady = (bpm: number, first: number, seconds: number): Song => ({ beats: steadyBeats(bpm, first, seconds), avgBpm: bpm });

/**
 * Plays `master` and a follower synced to it for `seconds`; returns the beat offset between them (ms, from the
 * published positions and the songs' true beats), one value per render quantum. `tracked` gives each deck the tracked
 * beats of its song when the song drifts (the new path); without it the follower and master only know a fixed grid.
 */
function run(master: Song, follower: Song, seconds: number, tracked: boolean, keyLock: boolean) {
  const len = (master.beats[master.beats.length - 1] as number) + 2;
  const m = deckOf(clicksAt(master.beats, len));
  const f = deckOf(clicksAt(follower.beats, (follower.beats[follower.beats.length - 1] as number) + 2));
  const mFirst = master.beats[0] as number;
  const fFirst = follower.beats[0] as number;
  const plan = syncPlan(master.avgBpm, follower.avgBpm);
  const mTrue = new BeatMap(frames(master.beats), mFirst * SR);
  const fTrue = new BeatMap(frames(follower.beats), fFirst * SR);
  const isDrift = (s: Song) => s.beats.length > 8 && Math.abs((s.beats[1] as number) - (s.beats[0] as number) - (s.beats[s.beats.length - 1] as number) + (s.beats[s.beats.length - 2] as number)) > 0.002;
  f.k.setSync({
    master: m.buf,
    ratio: master.avgBpm / (follower.avgBpm * plan.multiple),
    selfFirst: fFirst * SR,
    selfBeat: plan.beatSec * SR,
    masterFirst: mFirst * SR,
    masterBeat: (60 / master.avgBpm) * SR,
    ...(tracked && isDrift(follower) ? { selfBeats: frames(follower.beats) } : {}),
    ...(tracked && isDrift(master) ? { masterBeats: frames(master.beats) } : {}),
    selfMult: plan.multiple,
  });
  f.k.setTempo(1 + plan.pitch, keyLock);
  m.k.seek(mFirst * SR);
  f.k.seek((fFirst + 3) * SR);
  m.k.play(true);
  const bl = new Float32Array(Q);
  const br = new Float32Array(Q);
  m.k.process(bl, br, Q, 0);
  f.k.play(true);
  let cursor = Q;
  const ms = newSnapshot();
  const fs = newSnapshot();
  const errs: number[] = [];
  const blocks = Math.round((seconds * SR) / Q);
  for (let b = 0; b < blocks; b++) {
    const frame = cursor;
    cursor += Q;
    m.k.process(bl, br, Q, frame);
    f.k.process(bl, br, Q, frame);
    readDeckState(m.state, m.seq, ms);
    readDeckState(f.state, f.seq, fs);
    const mp = ms.pos + (frame - ms.frame) * ms.rate;
    const fp = fs.pos + (frame - fs.frame) * fs.rate;
    let d = fTrue.beatAt(fp) * plan.multiple - mTrue.beatAt(mp);
    d -= Math.round(d);
    // In ms: the beat the pair is playing at, in output time.
    const beatMs = (mTrue.lenAt(mp) / ms.rate / SR) * 1000;
    errs.push(d * beatMs);
  }
  return errs;
}

const worst = (errs: number[], skipSec = 3) => errs.slice(Math.round((skipSec * SR) / Q)).reduce((a, v) => Math.max(a, Math.abs(v)), 0);

describe('deck kernel: sync with drifting beat grids', () => {
  const secs = 185;
  const drift = drifting(120, 124, 190, 0.35);

  it('a song that drifts 120 → 124 BPM over 3 minutes follows a steady 124 BPM master within 5 ms (tracked beats), where a fixed grid slips', () => {
    const master = steady(124, 0.1, 200);
    const before = worst(run(master, drift, secs, false, false));
    const after = worst(run(master, drift, secs, true, false));
    console.log(`drifting follower: worst beat offset before ${before.toFixed(2)} ms, after ${after.toFixed(3)} ms`);
    expect(before).toBeGreaterThan(10);
    expect(after).toBeLessThan(5);
  }, 120_000);

  it('a drifting master with a steady follower: the follower tracks its tempo changes', () => {
    const follower = steady(122, 0.2, 200);
    const before = worst(run(drift, follower, secs, false, false));
    const after = worst(run(drift, follower, secs, true, false));
    console.log(`drifting master: worst beat offset before ${before.toFixed(2)} ms, after ${after.toFixed(3)} ms`);
    expect(before).toBeGreaterThan(10);
    expect(after).toBeLessThan(5);
  }, 120_000);

  it('two drifting songs (one speeding up, one slowing down) stay together, with key lock too', () => {
    const other = drifting(126, 121, 190, 0.5);
    const after = worst(run(drift, other, secs, true, true));
    console.log(`two drifting songs, key lock: worst beat offset ${after.toFixed(3)} ms`);
    expect(after).toBeLessThan(5);
  }, 120_000);
});
