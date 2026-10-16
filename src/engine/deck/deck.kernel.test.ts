import { describe, expect, it } from 'vitest';
import { beatPhase, phaseDiff, syncPlan } from '@core/dj/decks-math';
import { autocorrelationPitch } from '../../../test/helpers/audio';
import { DECK_STATE_SLOTS, DS } from './deck-id';
import { DeckKernel, newSnapshot, readDeckState } from './deck.kernel';

const SR = 48000;
const Q = 128;

function deck(song: Float32Array, opts: { stereo?: boolean } = {}) {
  const k = new DeckKernel(SR);
  const buf = new SharedArrayBuffer(DECK_STATE_SLOTS * 8);
  const state = new Float64Array(buf);
  const seq = new Int32Array(buf, 0, 1);
  k.attachState(state, seq);
  k.setSong(opts.stereo ? [song, song.slice().reverse()] : [song], song.length);
  return { k, buf, state, seq };
}

/** Renders `frames` frames in render quanta; `frame0` is the context frame of the first. */
function render(k: DeckKernel, frames: number, frame0 = 0): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  const bl = new Float32Array(Q);
  const br = new Float32Array(Q);
  for (let o = 0; o < frames; o += Q) {
    const n = Math.min(Q, frames - o);
    k.process(bl, br, n, frame0 + o);
    l.set(bl.subarray(0, n), o);
    r.set(br.subarray(0, n), o);
  }
  return { l, r };
}

function noise(frames: number, seed = 1): Float32Array {
  const x = new Float32Array(frames);
  let s = seed;
  for (let i = 0; i < frames; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = (s / 0xffffffff - 0.5) * 0.8;
  }
  return x;
}

function sine(hz: number, seconds: number, level = 0.5): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = level * Math.sin((2 * Math.PI * hz * i) / SR);
  return x;
}

/** A click (3 ms decaying burst) on every beat from `first`. */
function clicks(bpm: number, first: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  const beat = (60 / bpm) * SR;
  for (let b = 0; first * SR + b * beat < x.length; b++) {
    const at = Math.round(first * SR + b * beat);
    for (let k = 0; k < 150 && at + k < x.length; k++) x[at + k] = (x[at + k] ?? 0) + 0.9 * Math.exp(-k / 30) * (k % 2 ? -1 : 1);
  }
  return x;
}

const maxAbs = (x: readonly number[]) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('deck kernel: playing', () => {
  it('plays a sample-exact copy at normal speed (after a 2 ms fade in)', () => {
    const song = noise(SR);
    const { k } = deck(song);
    k.play(true);
    const { l } = render(k, 20000);
    for (let i = 200; i < 20000; i++) expect(l[i]).toBe(song[i]);
    // The first 2 ms rise instead of clicking in.
    expect(Math.abs(l[0]!)).toBeLessThan(0.01);
  });

  it('holds position while paused and resumes where it was', () => {
    const song = noise(SR);
    const { k } = deck(song);
    k.play(true);
    render(k, 4800);
    k.play(false);
    render(k, 1000, 4800);
    const at = k.pos;
    const { l } = render(k, 1000, 5800);
    expect(k.pos).toBe(at);
    expect(maxAbs(Array.from(l))).toBe(0);
    expect(Math.round(at)).toBeGreaterThanOrEqual(4800);
    expect(Math.round(at)).toBeLessThan(4800 + 20);
  });

  it('follows the pitch like a turntable: +8 % is 8 % higher', () => {
    const song = sine(440, 4);
    const { k } = deck(song);
    k.setTempo(1.08, false);
    k.play(true);
    const { l } = render(k, SR * 2);
    const hz = autocorrelationPitch(l, SR, SR / 2, SR * 2 - 4000, 200, 900);
    expect(hz / 440).toBeGreaterThan(1.075);
    expect(hz / 440).toBeLessThan(1.085);
  });

  it('is stereo: left and right stay apart', () => {
    const song = noise(SR);
    const { k } = deck(song, { stereo: true });
    k.play(true);
    const { l, r } = render(k, 2000);
    expect(l[1000]).toBe(song[1000]);
    expect(r[1000]).toBe(song[SR - 1 - 1000]);
  });

  it('stops at the end of the song and says so', () => {
    const song = noise(5000);
    const { k } = deck(song);
    let ended = 0;
    k.onEnded = () => ended++;
    k.play(true);
    render(k, 20000);
    expect(ended).toBe(1);
    expect(k.playing).toBe(false);
  });
});

describe('deck kernel: key lock', () => {
  it('keeps the pitch at +8 % tempo (within 1 %) and plays 8 % faster', () => {
    const song = sine(440, 10);
    const { k } = deck(song);
    k.setTempo(1.08, true);
    k.play(true);
    const { l } = render(k, SR * 4);
    const hz = autocorrelationPitch(l, SR, SR, SR * 4 - 4000, 200, 900);
    expect(Math.abs(hz / 440 - 1)).toBeLessThan(0.005);
    expect(k.pos / SR).toBeGreaterThan(4 * 1.08 - 0.05);
    expect(k.pos / SR).toBeLessThan(4 * 1.08 + 0.05);
  });

  it('keeps the pitch when slowed down 16 % too', () => {
    const song = sine(220, 10);
    const { k } = deck(song);
    k.setTempo(0.84, true);
    k.play(true);
    const { l } = render(k, SR * 3);
    const hz = autocorrelationPitch(l, SR, SR, SR * 3 - 4000, 100, 600);
    expect(Math.abs(hz / 220 - 1)).toBeLessThan(0.005);
  });

  it('at exactly 1× it passes the song through unchanged', () => {
    const song = noise(SR * 2);
    const { k } = deck(song);
    k.setTempo(1, true);
    k.play(true);
    const { l } = render(k, SR);
    let worst = 0;
    for (let i = 3000; i < SR - 3000; i++) worst = Math.max(worst, Math.abs(l[i]! - song[i]!));
    expect(worst).toBeLessThan(1e-5);
  });

  it('keeps clicks within a few milliseconds of where the tempo puts them', () => {
    const bpm = 120;
    const song = clicks(bpm, 0.5, 30);
    const { k } = deck(song);
    k.setTempo(1.06, true);
    k.play(true);
    const out = render(k, SR * 12).l;
    // Beat n of the song is heard at (0.5 + n × 0.5) / 1.06 s.
    let worst = 0;
    let seen = 0;
    for (let n = 2; n < 20; n++) {
      const t = (0.5 + n * 0.5) / 1.06;
      let best = 0;
      let at = 0;
      for (let i = Math.round((t - 0.05) * SR); i < Math.round((t + 0.05) * SR); i++)
        if (Math.abs(out[i]!) > best) {
          best = Math.abs(out[i]!);
          at = i;
        }
      if (best > 0.3) {
        seen++;
        worst = Math.max(worst, Math.abs(at / SR - t));
      }
    }
    expect(seen).toBeGreaterThanOrEqual(16);
    expect(worst).toBeLessThan(0.012);
  });

  it('does not click when switching key lock on and off', () => {
    const song = sine(300, 6);
    const { k } = deck(song);
    k.play(true);
    render(k, 4800);
    k.setTempo(1.04, true);
    const a = render(k, 9600, 4800).l;
    k.setTempo(1.04, false);
    const b = render(k, 9600, 14400).l;
    const worstStep = (x: Float32Array) => {
      let m = 0;
      for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
      return m;
    };
    // A 300 Hz sine of level 0.5 moves at most 0.5 × 2π × 300 / 48000 per frame (~0.02).
    expect(worstStep(a)).toBeLessThan(0.06);
    expect(worstStep(b)).toBeLessThan(0.06);
  });
});

describe('deck kernel: loops', () => {
  it('a loop repeats the song’s samples exactly, with no gap or fade at the seam', () => {
    const song = noise(SR * 3);
    const { k } = deck(song);
    const start = 12345;
    const len = 20000;
    k.seek(start);
    k.play(true);
    render(k, 1000);
    k.setLoop(start, len);
    // Position after rendering 1000 frames: start + 1000.
    const startOut = 1000;
    const out = render(k, len * 5 + 321, 1000).l;
    // The loop was set at position start + 1000 (inside it): output continues song[start + 1000 + i] wrapped.
    for (let i = 0; i < out.length; i++) {
      const src = start + ((startOut + i) % len);
      expect(out[i]).toBe(song[src]);
    }
    expect(k.loopWraps).toBeGreaterThanOrEqual(5);
  });

  it('keeps the length of a fractional loop over many repeats', () => {
    const song = noise(SR * 10);
    const { k } = deck(song);
    const len = 12000.37;
    k.seek(5000);
    k.play(true);
    render(k, 500);
    k.setLoop(5000, len);
    const frames = Math.round(len * 200);
    render(k, frames, 500);
    // 200 loops of a fractional length: the position is where 200 × len puts it (to a frame), not drifted by rounding.
    const expected = 5000 + ((500 + frames) % len);
    expect(Math.abs(k.pos - expected)).toBeLessThan(2);
  });

  it('wraps a playhead that is past the new loop end', () => {
    const song = noise(SR * 3);
    const { k } = deck(song);
    k.seek(50000);
    k.play(true);
    render(k, 200);
    k.setLoop(10000, 8000);
    expect(k.pos).toBeGreaterThanOrEqual(10000);
    expect(k.pos).toBeLessThan(18000);
  });

  it('plays on after the loop is left', () => {
    const song = noise(SR * 3);
    const { k } = deck(song);
    k.seek(10000);
    k.play(true);
    render(k, 100);
    k.setLoop(10000, 8000);
    render(k, 30000, 100);
    k.clearLoop();
    const at = k.pos;
    render(k, 5000, 30100);
    expect(k.pos - at).toBeCloseTo(5000, 0);
  });

  it('a key-locked deck loops too: the heard material never passes the loop end by more than the stretch frame', () => {
    const song = clicks(120, 0, 20);
    const { k } = deck(song);
    k.setTempo(1.05, true);
    k.seek(2 * SR);
    k.play(true);
    render(k, 1000);
    k.setLoop(2 * SR, 2 * SR);
    render(k, SR * 10, 1000);
    expect(k.loopWraps).toBeGreaterThan(3);
    expect(k.pos).toBeGreaterThanOrEqual(2 * SR);
    expect(k.pos).toBeLessThan(4 * SR);
  });
});

describe('deck kernel: jumps, scratch and nudge', () => {
  it('a seek while playing never steps by more than a sine’s own slope would', () => {
    const song = sine(200, 10);
    const { k } = deck(song);
    k.play(true);
    render(k, 8000);
    k.seek(3.37 * SR);
    const out = render(k, 4000, 8000).l;
    let worst = 0;
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!));
    // Without the fade a jump to another phase of a 0.5 sine steps by up to ~1.
    expect(worst).toBeLessThan(0.12);
  });

  it('pausing fades instead of cutting', () => {
    const song = sine(200, 10);
    const { k } = deck(song);
    k.play(true);
    render(k, 8000);
    k.play(false);
    const out = render(k, 4000, 8000).l;
    let worst = 0;
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!));
    expect(worst).toBeLessThan(0.05);
    expect(out[3999]).toBe(0);
  });

  it('scratching follows the speed it is given, backwards too', () => {
    const song = noise(SR * 10);
    const { k } = deck(song);
    k.seek(5 * SR);
    k.play(true);
    render(k, 4800);
    k.setScratching(true);
    k.setScratchRate(0);
    render(k, 4800, 4800);
    const held = k.pos;
    render(k, 4800, 9600);
    expect(Math.abs(k.pos - held)).toBeLessThan(2);
    k.setScratchRate(-2);
    render(k, 4800, 14400);
    const back = k.pos;
    expect(held - back).toBeGreaterThan(2 * 4800 * 0.9);
    expect(held - back).toBeLessThan(2 * 4800 * 1.05);
    k.setScratching(false);
    render(k, 24000, 19200);
    expect(k.pos).toBeGreaterThan(back + 0.7 * 24000);
  });

  it('scratching a paused deck moves it and stops again after the platter is let go', () => {
    const song = noise(SR * 4);
    const { k } = deck(song);
    k.seek(SR);
    k.setScratching(true);
    k.setScratchRate(1);
    render(k, 9600);
    const moved = k.pos - SR;
    expect(moved).toBeGreaterThan(8000);
    k.setScratching(false);
    render(k, 2000, 9600);
    const at = k.pos;
    render(k, 2000, 11600);
    expect(k.pos).toBe(at);
  });

  it('a nudge bends the tempo for a moment and lets go by itself', () => {
    const song = noise(SR * 10);
    const { k } = deck(song);
    k.play(true);
    render(k, 4800);
    const before = k.pos;
    k.nudge(0.1);
    render(k, 4800, 4800);
    const gained = k.pos - before - 4800;
    expect(gained).toBeGreaterThan(200);
    render(k, 14400, 9600);
    const a = k.pos;
    render(k, 4800, 24000);
    expect(k.pos - a).toBeCloseTo(4800, 0);
  });
});

/** Two decks whose clicks are 124 and 128 BPM; the second follows the first. */
function syncedPair(order: 'master-first' | 'follower-first', keyLock: boolean) {
  const secs = 340;
  const m = deck(clicks(124, 0.1, secs));
  const f = deck(clicks(128, 0.35, secs));
  const plan = syncPlan(124, 128);
  const mGrid = { bpm: 124, firstDownbeat: 0.1 };
  const fGrid = { bpm: 128, firstDownbeat: 0.35 };
  f.k.setSync({
    master: m.buf,
    ratio: (124 * 1) / (128 * plan.multiple),
    selfFirst: fGrid.firstDownbeat * SR,
    selfBeat: plan.beatSec * SR,
    masterFirst: mGrid.firstDownbeat * SR,
    masterBeat: (60 / 124) * SR,
  });
  f.k.setTempo(1 + plan.pitch, keyLock);
  m.k.seek(10 * SR);
  f.k.seek(20.2 * SR);
  m.k.play(true);
  const bl = new Float32Array(Q);
  const br = new Float32Array(Q);
  // The master has been playing for a moment when the follower starts: it lands on the master's beat by itself.
  m.k.process(bl, br, Q, 0);
  f.k.play(true);
  let cursor = Q;
  const ms = newSnapshot();
  const fs = newSnapshot();
  const errorsMs: number[] = [];
  const run = (seconds: number) => {
    const blocks = Math.round((seconds * SR) / Q);
    for (let b = 0; b < blocks; b++) {
      const frame = cursor;
      cursor += Q;
      if (order === 'master-first') {
        m.k.process(bl, br, Q, frame);
        f.k.process(bl, br, Q, frame);
      } else {
        f.k.process(bl, br, Q, frame);
        m.k.process(bl, br, Q, frame);
      }
      // The phase error from the published positions, both brought to this quantum's first frame.
      readDeckState(m.state, m.seq, ms);
      readDeckState(f.state, f.seq, fs);
      const mp = ms.pos + (frame - ms.frame) * ms.rate;
      const fp = fs.pos + (frame - fs.frame) * fs.rate;
      const err = phaseDiff(beatPhase(fp / SR, fGrid.firstDownbeat, plan.beatSec), beatPhase(mp / SR, mGrid.firstDownbeat, 60 / 124));
      errorsMs.push(err * (60 / 124) * 1000);
    }
  };
  return { m, f, run, errorsMs };
}

describe('deck kernel: sync', () => {
  for (const order of ['master-first', 'follower-first'] as const) {
    for (const keyLock of [false, true]) {
      it(`holds beat phase within 2 ms over 5 minutes (${order}, key lock ${keyLock ? 'on' : 'off'})`, () => {
        const p = syncedPair(order, keyLock);
        p.run(300);
        const settled = p.errorsMs.slice(Math.round((2 * SR) / Q));
        const worst = maxAbs(settled);
        expect(worst).toBeLessThan(2);
        // And in the long run it is not drifting: the last minute is as tight as the first.
        const last = p.errorsMs.slice(-Math.round((60 * SR) / Q));
        expect(maxAbs(last)).toBeLessThan(0.5);
      }, 60_000);
    }
  }

  it('follows the master when its tempo changes, and pulls a phase error in', () => {
    const p = syncedPair('master-first', false);
    p.run(5);
    // The master speeds up 3 %: the follower follows.
    p.m.k.setTempo(1.03, false);
    p.run(10);
    // A stray 40 ms phase error is closed by the follower's own correction.
    p.f.k.seek(p.f.k.pos + 0.04 * SR);
    p.errorsMs.length = 0;
    p.run(30);
    const early = Math.abs(p.errorsMs[Math.round(SR / Q) * 1]!);
    expect(early).toBeGreaterThan(5);
    const late = p.errorsMs.slice(-Math.round(SR / Q));
    expect(maxAbs(late)).toBeLessThan(2);
    // And it is locked to the master's new tempo.
    const ms = newSnapshot();
    const fs = newSnapshot();
    readDeckState(p.m.state, p.m.seq, ms);
    readDeckState(p.f.state, p.f.seq, fs);
    expect(fs.tempoRate * (128 / 124)).toBeCloseTo(ms.tempoRate, 2);
    expect(fs.syncLocked).toBe(true);
  }, 60_000);

  it('a follower started in the same quantum as its master still lands on the beat', () => {
    const m = deck(clicks(124, 0.1, 60));
    const f = deck(clicks(128, 0.35, 60));
    const plan = syncPlan(124, 128);
    f.k.setSync({
      master: m.buf,
      ratio: 124 / (128 * plan.multiple),
      selfFirst: 0.35 * SR,
      selfBeat: plan.beatSec * SR,
      masterFirst: 0.1 * SR,
      masterBeat: (60 / 124) * SR,
    });
    f.k.setTempo(1 + plan.pitch, false);
    m.k.seek(7 * SR);
    f.k.seek(13.17 * SR);
    m.k.play(true);
    f.k.play(true);
    const bl = new Float32Array(Q);
    const br = new Float32Array(Q);
    // The follower's node is rendered first: it finds the master not published yet and waits for it.
    for (let b = 0; b < 400; b++) {
      f.k.process(bl, br, Q, b * Q);
      m.k.process(bl, br, Q, b * Q);
    }
    const ms = newSnapshot();
    const fs = newSnapshot();
    readDeckState(m.state, m.seq, ms);
    readDeckState(f.state, f.seq, fs);
    const err = phaseDiff(
      beatPhase(fs.pos / SR, 0.35, plan.beatSec),
      beatPhase((ms.pos + (fs.frame - ms.frame) * ms.rate) / SR, 0.1, 60 / 124),
    );
    expect(Math.abs(err * (60 / 124) * 1000)).toBeLessThan(1);
  });

  it('does not lock to a master that is not playing', () => {
    const p = syncedPair('master-first', false);
    p.m.k.play(false);
    p.errorsMs.length = 0;
    p.run(1);
    const fs = newSnapshot();
    readDeckState(p.f.state, p.f.seq, fs);
    expect(fs.syncLocked).toBe(false);
  });
});

describe('deck kernel: state', () => {
  it('publishes the position and speed under a sequence lock', () => {
    const song = noise(SR * 2);
    const { k, state, seq } = deck(song);
    k.play(true);
    render(k, 1280);
    const snap = newSnapshot();
    readDeckState(state, seq, snap);
    expect(snap.playing).toBe(true);
    expect(snap.rate).toBeCloseTo(1, 6);
    expect(snap.pos).toBeGreaterThan(1100);
    expect(snap.pos).toBeLessThanOrEqual(1280);
    expect(Atomics.load(seq, 0) % 2).toBe(0);
    expect(state[DS.frame]).toBe(1152);
  });
});
