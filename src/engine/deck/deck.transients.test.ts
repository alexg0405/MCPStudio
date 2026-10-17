import { describe, expect, it } from 'vitest';
import { cpuNow, perfLimit, settle } from '../../../test/helpers/perf';
import { DECK_STATE_SLOTS } from './deck-id';
import { DeckKernel } from './deck.kernel';

const SR = 48000;
const Q = 128;

function deckOf(song: Float32Array[]) {
  const k = new DeckKernel(SR);
  const buf = new SharedArrayBuffer(DECK_STATE_SLOTS * 8);
  k.attachState(new Float64Array(buf), new Int32Array(buf, 0, 1));
  k.setSong(song, song[0]!.length);
  return k;
}

function render(k: DeckKernel, frames: number): Float32Array[] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  const bl = new Float32Array(Q);
  const br = new Float32Array(Q);
  for (let o = 0; o < frames; o += Q) {
    const n = Math.min(Q, frames - o);
    k.process(bl, br, n, o);
    l.set(bl.subarray(0, n), o);
    r.set(br.subarray(0, n), o);
  }
  return [l, r];
}

/** A click (3 ms decaying burst, peak `level`) every `spacing` s from `first`. */
function clickTrain(first: number, spacing: number, seconds: number, level = 0.9, bed = 0): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  // An optional bed under the clicks (a band-limited noise, like a pad or a hat roll), so the similarity search has something to grab.
  let s = 12345;
  let lp = 0;
  for (let i = 0; i < x.length && bed > 0; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    lp += 0.08 * ((s / 0xffffffff - 0.5) * 2 - lp);
    x[i] = bed * 4 * lp;
  }
  for (let t = first; t < seconds - 0.05; t += spacing) {
    const at = Math.round(t * SR);
    for (let k = 0; k < 150; k++) x[at + k] = (x[at + k] ?? 0) + level * Math.exp(-k / 30) * (k % 2 ? -1 : 1);
  }
  return x;
}

interface ClickReport {
  clicks: number;
  /** Clicks heard more than once (a second burst within ±60 ms of the expected time). */
  doubled: number;
  missing: number;
  worstDb: number;
  worstMs: number;
}

/** Looks for each click of `clickTrain` in the output: where it was expected, how loud, how many times. */
function clickReport(out: Float32Array, rate: number, first: number, spacing: number, inPeak: number, from: number, count: number): ClickReport {
  const rep: ClickReport = { clicks: 0, doubled: 0, missing: 0, worstDb: 0, worstMs: 0 };
  for (let n = from; n < from + count; n++) {
    const t = (first + n * spacing) / rate;
    const a = Math.round((t - 0.06) * SR);
    const b = Math.round((t + 0.06) * SR);
    let peak = 0;
    let at = 0;
    for (let i = a; i < b; i++)
      if (Math.abs(out[i]!) > peak) {
        peak = Math.abs(out[i]!);
        at = i;
      }
    // Bursts: runs above 20 % of the input peak, 1 ms apart or more, make separate events.
    let events = 0;
    let lastHigh = -1e9;
    for (let i = a; i < b; i++) {
      if (Math.abs(out[i]!) > 0.2 * inPeak) {
        if (i - lastHigh > 0.001 * SR) events++;
        lastHigh = i;
      }
    }
    rep.clicks++;
    if (events > 1) rep.doubled++;
    if (events === 0) rep.missing++;
    rep.worstDb = Math.max(rep.worstDb, Math.abs(20 * Math.log10((peak + 1e-9) / inPeak)));
    rep.worstMs = Math.max(rep.worstMs, Math.abs(at / SR - t) * 1000);
  }
  return rep;
}

/** A drum loop: kick on every beat, snare on 2 and 4, hats on the 8ths, a bass line under it, at `bpm`. */
function drumLoop(bpm: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  const beat = (60 / bpm) * SR;
  let s = 99;
  const noise = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0xffffffff - 0.5) * 2;
  };
  for (let i = 0; i < x.length; i++) x[i] = 0.15 * Math.sin((2 * Math.PI * 55 * i) / SR) * (0.6 + 0.4 * Math.sin((2 * Math.PI * i) / (beat * 4)));
  const add = (at: number, len: number, f: (k: number) => number) => {
    for (let k = 0; k < len && at + k < x.length; k++) x[at + k] = (x[at + k] ?? 0) + f(k);
  };
  for (let b = 0; b * beat < x.length; b++) {
    const at = Math.round(b * beat);
    // Kick: a falling sine with a click on top.
    add(at, 6000, (k) => 0.7 * Math.exp(-k / 1500) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-k / 400)) * (k / SR)) + (k < 60 ? 0.3 * (k % 2 ? -1 : 1) : 0));
    if (b % 2 === 1) add(at, 9000, (k) => 0.5 * Math.exp(-k / 2200) * noise());
    for (const off of [0, 0.5]) add(Math.round(at + off * beat), 1200, (k) => 0.18 * Math.exp(-k / 250) * noise());
  }
  return x;
}

describe('deck kernel: key lock cost', () => {
  it('attack handling costs less than 1.5× plain key lock (60 s of a drum loop, stereo)', { tags: ['perf'], timeout: 120_000 }, async () => {
    const x = drumLoop(124, 70);
    const run = (on: boolean) => {
      const k = deckOf([x, x.slice()]);
      k.transientsOn = on;
      k.setTempo(1.08, true);
      k.play(true);
      render(k, SR);
      const t0 = cpuNow();
      render(k, 10 * SR);
      return cpuNow() - t0;
    };
    const ratio = await settle(
      () => {
        const plain = Math.min(run(false), run(false));
        const on = Math.min(run(true), run(true));
        console.log(`key lock per 10 s: plain ${plain.toFixed(1)} ms, with attacks ${on.toFixed(1)} ms (${((on / 10000) * 100).toFixed(2)} % of a core)`);
        return on / plain;
      },
      (r) => r < perfLimit(1.3, 1.5),
    );
    expect(ratio).toBeLessThan(perfLimit(1.5, 2));
  });
});

/**
 * How well the output holds a hit of the input: the first 25 ms of the hit are looked for in the output around where the
 * tempo puts it (±4 ms) by normalized correlation. Returns the best correlation (1 = an exact copy, once) and the shift.
 */
function holdsHit(out: Float32Array, inp: Float32Array, at: number, rate: number): { corr: number; shiftMs: number } {
  const len = Math.round(0.025 * SR);
  const from = at - Math.round(0.002 * SR);
  let ei = 1e-12;
  for (let i = 0; i < len; i++) ei += inp[from + i]! ** 2;
  const expected = Math.round(at / rate);
  let best = -1;
  let shift = 0;
  const reach = Math.round(0.004 * SR);
  for (let d = -reach; d <= reach; d++) {
    const o = expected - Math.round(0.002 * SR) + d;
    let xy = 0;
    let eo = 1e-12;
    for (let i = 0; i < len; i++) {
      xy += inp[from + i]! * out[o + i]!;
      eo += out[o + i]! ** 2;
    }
    const c = xy / Math.sqrt(ei * eo);
    if (c > best) {
      best = c;
      shift = d;
    }
  }
  return { corr: best, shiftMs: (shift / SR) * 1000 };
}

describe('deck kernel: key lock under a tone', () => {
  for (const rate of [0.85, 1.2]) {
    it(`a held tone stays smooth around the hits at ${rate}× (no step beyond the tone's own, the pitch holds)`, () => {
      const x = new Float32Array(30 * SR);
      let seed = 5;
      for (let i = 0; i < x.length; i++) x[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / SR);
      for (let t = 0.5; t < 29; t += 0.5)
        for (let k = 0; k < 2400; k++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          x[Math.round(t * SR) + k] = x[Math.round(t * SR) + k]! + 0.8 * Math.exp(-k / 500) * (seed / 0xffffffff - 0.5) * 2;
        }
      const steps = (on: boolean) => {
        const k = deckOf([x, x.slice()]);
        k.transientsOn = on;
        k.setTempo(rate, true);
        k.play(true);
        const o = render(k, Math.round(20 * SR))[0]!;
        // Look outside the clicks themselves (each lasts a few ms, at expected time ± 12 ms).
        let worst = 0;
        for (let i = SR; i < o.length - 100; i++) {
          const t = i / SR;
          const phase = ((t * rate - 0.5) / 0.5) % 1;
          const near = phase < 0.2 || phase > 0.96;
          if (near) continue;
          worst = Math.max(worst, Math.abs(o[i + 1]! - o[i]!));
        }
        return worst;
      };
      const tone = 0.15 * 2 * Math.PI * (220 / SR);
      const before = steps(false);
      const after = steps(true);
      console.log(`tone ${rate}× worst step (tone's own ${tone.toFixed(4)}): before ${before.toFixed(4)} after ${after.toFixed(4)}`);
      expect(after).toBeLessThan(tone * 1.5);
    });
  }
});

describe('deck kernel: key lock on a drum loop', () => {
  for (const rate of [0.9, 1.1, 1.3]) {
    it(`kicks and snares come out once, whole and on time at ${rate}× (hats may be softened)`, () => {
      const bpm = 124;
      const x = drumLoop(bpm, 60);
      const beat = (60 / bpm) * SR;
      const out = (on: boolean) => {
        const k = deckOf([x, x.slice()]);
        k.transientsOn = on;
        k.setTempo(rate, true);
        k.play(true);
        return render(k, Math.round(40 * SR))[0]!;
      };
      const stat = (o: Float32Array) => {
        let worstCorr = 1;
        let worstMs = 0;
        let n = 0;
        for (let b = 4; b < 60; b++) {
          const at = Math.round(b * beat);
          if (at / rate > 38 * SR) break;
          const h = holdsHit(o, x, at, rate);
          worstCorr = Math.min(worstCorr, h.corr);
          worstMs = Math.max(worstMs, Math.abs(h.shiftMs));
          n++;
        }
        return { n, worstCorr: Math.round(worstCorr * 1000) / 1000, worstMs: Math.round(worstMs * 100) / 100 };
      };
      const before = stat(out(false));
      const after = stat(out(true));
      console.log(`drums ${rate}× before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      expect(after.worstCorr).toBeGreaterThan(0.97);
      expect(after.worstMs).toBeLessThan(2);
    });
  }
});

describe('deck kernel: key lock keeps hits whole', () => {
  for (const [rate, bed] of [
    [0.85, 0],
    [1.2, 0],
    [0.85, 0.04],
    [1.2, 0.04],
  ] as const) {
    it(`clicks every 0.5 s at ${rate}×${bed ? ' over a noise bed' : ''}: one per click, within 1 dB and 2 ms`, () => {
      const x = clickTrain(0.5, 0.5, 40, 0.9, bed);
      const plain = deckOf([x, x.slice()]);
      plain.transientsOn = false;
      plain.setTempo(rate, true);
      plain.play(true);
      const before = clickReport(render(plain, Math.round(30 * SR))[0]!, rate, 0.5, 0.5, 0.9, 2, 40);
      console.log(`rate ${rate} bed ${bed} before`, JSON.stringify(before));
      const k = deckOf([x, x.slice()]);
      k.setTempo(rate, true);
      k.play(true);
      const out = render(k, Math.round(30 * SR));
      const rep = clickReport(out[0]!, rate, 0.5, 0.5, 0.9, 2, 40);
      console.log(`rate ${rate} bed ${bed} after`, JSON.stringify(rep));
      expect(rep.doubled).toBe(0);
      expect(rep.missing).toBe(0);
      expect(rep.worstDb).toBeLessThan(1);
      expect(rep.worstMs).toBeLessThan(2);
    });
  }
});
