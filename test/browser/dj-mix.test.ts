/**
 * DJ auto-mix through the real engine (offline renders): three synthetic songs at different tempos
 * and keys with known beat grids, mixed by `makeMix` with a fake analyzer that knows those grids.
 * Checks that the beats of both songs line up across a transition (the tempo ramps in steps, the
 * clips are time-stretched) and that the bass swap keeps the lows from doubling.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { fakeAnalyzer, setTrackAnalyzer } from '@app/dj/analyzer';
import { makeMix, type MixSong } from '@app/dj/mix';
import { createTestServices } from '@app/testing';
import { tempoMapOf } from '@core/automation/tempo';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import type { Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { TestSamples } from '../helpers/audio';

const SR = 48000;
const BAR = 3840;

/** A song: a click and a 55 Hz kick on every beat, a held bass, a quiet tone; `f` s before the first downbeat. */
function synthSong(bpm: number, bars: number, f: number, root: number): Float32Array[] {
  const beat = 60 / bpm;
  const n = Math.round((f + bars * 4 * beat) * SR);
  const x = new Float32Array(n);
  const bassHz = 45 + root * 2;
  const toneHz = 440 * Math.pow(2, root / 12);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.12 * Math.sin(2 * Math.PI * bassHz * t) + 0.03 * Math.sin(2 * Math.PI * toneHz * t);
  }
  for (let k = 0; k < bars * 4; k++) {
    const at = Math.round((f + k * beat) * SR);
    for (let j = 0; j < 0.15 * SR && at + j < n; j++) {
      const t = j / SR;
      x[at + j]! += 0.35 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.05) + 0.4 * Math.sin(2 * Math.PI * 4000 * t) * Math.exp(-t / 0.0008);
    }
  }
  return [x, x.slice()];
}

/** Second-order Butterworth low-pass, run twice (24 dB/oct). */
function lowpass(x: Float32Array, hz: number): Float32Array {
  const w = Math.tan((Math.PI * hz) / SR);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + w / q + w * w);
  const b0 = w * w * norm;
  const b1 = 2 * b0;
  const a1 = 2 * (w * w - 1) * norm;
  const a2 = (1 - w / q + w * w) * norm;
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i]!;
      const o = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = o;
      out[i] = o;
    }
    y = out;
  }
  return y;
}

const rms = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, Math.min(x.length, b) - Math.max(0, a)));
};

/** The frame of the sharpest rise (the click) within ±30 ms of `at`, from a crude high-pass. */
function clickNear(x: Float32Array, at: number): { frame: number; level: number } {
  let best = -1;
  let level = 0;
  for (let i = Math.max(2, at - 0.03 * SR); i < Math.min(x.length, at + 0.03 * SR); i++) {
    const hp = Math.abs(x[i]! - 2 * x[i - 1]! + x[i - 2]!);
    if (hp > level) {
      level = hp;
      best = i;
    }
  }
  return { frame: best, level };
}

afterEach(() => setTrackAnalyzer(null));

describe('DJ auto-mix (rendered)', () => {
  it('lines up the beats across a transition and swaps the bass without doubling it', async () => {
    const samples = new TestSamples();
    const specs = [
      { name: 'Alpha', bpm: 124, f: 0, root: 9 },
      { name: 'Bravo', bpm: 127.2, f: 0.21, root: 4 },
      { name: 'Charlie', bpm: 125, f: 0.05, root: 11 },
    ];
    const byHash = new Map<string, TrackAnalysis>();
    const songs: MixSong[] = specs.map((sp) => {
      const ref = samples.add(synthSong(sp.bpm, 40, sp.f, sp.root), SR, sp.name);
      const hash = ref.source.kind === 'embedded' ? ref.source.hash : '';
      byHash.set(hash, fakeAnalysis({ bpm: sp.bpm, bars: 40, firstDownbeat: sp.f, key: { root: sp.root, mode: 'minor' }, mixOutBar: 24, hash, lufs: -12 }));
      return { ref, title: sp.name };
    });
    setTrackAnalyzer(fakeAnalyzer(byHash));
    const s = createTestServices();
    const { plan } = await makeMix(s, songs, { order: 'keep', energy: 'party', transition: 'auto', mixTempo: 'follow' });
    const project = s.doc.getState().project;
    const t = plan.transitions[0]!;
    expect(t.bars).toBe(16);
    expect(t.recipe).toBe('bass-swap');
    const tempo = tempoMapOf(project, 'song');
    expect(tempo.bpmAt(t.start - 1)).toBe(124);
    expect(tempo.bpmAt(t.start + t.length)).toBeCloseTo(127.2, 3);

    const from = t.start - 4 * BAR;
    const bars = 24;
    const render = async (p: Project) => {
      const r = await renderOffline(p, { plugins: s.plugins, samples: samples.provider, view: { mode: 'song', patternId: null, loop: null }, fromTick: from, bars, sampleRate: SR, tail: 0 });
      const start = Math.round((r.preRoll + r.latency) * SR);
      return r.buffer.getChannelData(0).subarray(start);
    };
    const muted = (deck: string) =>
      produce(project, (d) => {
        for (const ins of Object.values(d.mixer.inserts)) if (ins.name === deck) ins.muted = true;
      });
    const mix = await render(project);
    const onlyA = await render(muted('Deck B'));
    const onlyB = await render(muted('Deck A'));
    const frameAt = (tick: number) => Math.round((tempo.tickToSeconds(tick) - tempo.tickToSeconds(from)) * SR);

    // Beats: every beat of the overlap where both are audible, the clicks of both songs within 10 ms
    // of each other and of the mix's beat.
    let worst = 0;
    let checked = 0;
    for (let tick = t.start + 2 * BAR; tick < t.start + t.length - 2 * BAR; tick += 960) {
      const at = frameAt(tick);
      const a = clickNear(onlyA, at);
      const b = clickNear(onlyB, at);
      if (a.level < 0.02 || b.level < 0.02) continue;
      worst = Math.max(worst, Math.abs(a.frame - b.frame) / SR, Math.abs(a.frame - at) / SR, Math.abs(b.frame - at) / SR);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
    expect(worst).toBeLessThan(0.01);

    // Bass: the lows of the sum per bar never rise 3 dB over the songs alone (before and after).
    const low = lowpass(mix, 150);
    const lowB = lowpass(onlyB, 150);
    const barRms = (x: Float32Array, k: number) => rms(x, frameAt(from + k * BAR), frameAt(from + (k + 1) * BAR));
    const before = Math.max(barRms(low, 1), barRms(low, 2), barRms(low, 3));
    const after = Math.max(barRms(low, 21), barRms(low, 22));
    const ref = Math.max(before, after);
    const db = (v: number) => 20 * Math.log10(v / ref);
    const during: number[] = [];
    for (let k = 4; k < 20; k++) during.push(db(barRms(low, k)));
    expect(Math.max(...during)).toBeLessThan(3);
    // …and there is bass all the way through (no hole either).
    expect(Math.min(...during)).toBeGreaterThan(-7);
    // The incoming song's lows are cut until the swap (bar 8 of the transition).
    for (let k = 5; k < 11; k++) expect(20 * Math.log10(barRms(lowB, k) / after)).toBeLessThan(-15);
    expect(20 * Math.log10(barRms(lowB, 14) / after)).toBeGreaterThan(-4);
  }, 120_000);
});
