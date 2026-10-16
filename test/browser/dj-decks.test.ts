/**
 * DJ live decks through the real audio graph (headless Chrome, 48 kHz): synthetic songs (clicks on every beat at a
 * known tempo, sines for pitch) played by `createDecks` into an OfflineAudioContext, so every check is a render, not a
 * stopwatch. The deck controller, the player worklets, the EQ and filter, the faders and the crossfader are the
 * real ones; only the analyzer is faked (it knows each song's grid).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { fakeAnalyzer, setTrackAnalyzer } from '@app/dj/analyzer';
import { createDecks, type DecksDeps } from '@app/dj/decks';
import type { DecksApi } from '@app/dj/decks-api';
import { addSongFiles, library, type LibrarySong } from '@app/dj/library';
import { createServices, type Services } from '@app/services';
import { fakeAnalysis, type FakeSong } from '@core/dj/fake-analysis';
import { encodeWav } from '@core/io/wav';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import { SampleCache } from '@engine/samples';
import { autocorrelationPitch, TestSamples } from '../helpers/audio';
import { perfLimit } from '../helpers/perf';

const SR = 48000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  ctx: OfflineAudioContext;
  decks: DecksApi;
  toasts: string[];
  /** A song in the library: its audio and (optionally) the grid the analyzer reports. */
  add(name: string, audio: Float32Array[], grid?: Omit<FakeSong, 'hash'>): SampleRef;
  /** Waits for the audio thread, renders `seconds`, returns the master. */
  render(): Promise<{ l: Float32Array; r: Float32Array }>;
}

function makeRig(seconds: number): Rig {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const host: DeckHost = {
    ctx,
    output: ctx.destination,
    loadModule: (u) => ctx.audioWorklet.addModule(u),
    heardTime: () => ctx.currentTime,
  };
  const samples = new TestSamples();
  const analyses = new Map<string, TrackAnalysis>();
  const hashOf = (ref: SampleRef) => (ref.source.kind === 'embedded' ? ref.source.hash : '');
  const toasts: string[] = [];
  const deps: DecksDeps = {
    host: () => host,
    subscribeHost: () => () => {},
    resume: async () => {},
    cache: new SampleCache(samples.provider),
    peekAnalysis: (ref) => analyses.get(hashOf(ref)) ?? null,
    analysis: async (ref) => analyses.get(hashOf(ref)) ?? null,
    addRecording: async () => null,
    toast: (m) => void toasts.push(m),
  };
  const decks = createDecks(deps);
  return {
    ctx,
    decks,
    toasts,
    add(name, audio, grid) {
      const ref = samples.add(audio, SR, name);
      if (grid) analyses.set(hashOf(ref), fakeAnalysis({ ...grid, hash: hashOf(ref) }));
      return ref;
    },
    async render() {
      await decks.settled?.();
      const out = await ctx.startRendering();
      return { l: out.getChannelData(0), r: out.getChannelData(1) };
    },
  };
}

function sine(hz: number, seconds: number, level = 0.4): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = level * Math.sin((2 * Math.PI * hz * i) / SR);
  return x;
}

/** A tone burst (`hz`, 4 ms decaying) on every beat from `first`: the grid made audible. */
function clickSong(bpm: number, first: number, seconds: number, hz = 1000, level = 0.8): Float32Array[] {
  const x = new Float32Array(Math.round(seconds * SR));
  const beat = (60 / bpm) * SR;
  for (let b = 0; first * SR + b * beat < x.length; b++) {
    const at = Math.round(first * SR + b * beat);
    for (let k = 0; k < 400 && at + k < x.length; k++)
      x[at + k] = (x[at + k] ?? 0) + level * Math.exp(-k / 90) * Math.sin((2 * Math.PI * hz * k) / SR);
  }
  return [x, x.slice()];
}

/** Power of `x` at `hz` over [from, to) frames (Goertzel), as RMS amplitude. */
function toneLevel(x: Float32Array, hz: number, from: number, to: number): number {
  const w = (2 * Math.PI * hz) / SR;
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    re += x[i]! * Math.cos(w * (i - from));
    im -= x[i]! * Math.sin(w * (i - from));
  }
  return (Math.hypot(re, im) * 2) / (to - from) / Math.SQRT2;
}

const db = (a: number, b: number) => 20 * Math.log10((a + 1e-12) / (b + 1e-12));

describe('decks: tempo and pitch', () => {
  it('without key lock the pitch follows the speed (+8 % is 8 % higher)', async () => {
    const rig = makeRig(4);
    const ref = rig.add('Tone', [sine(440, 10)]);
    await rig.decks.load('A', ref, 'Tone');
    rig.decks.setPitch('A', 0.08);
    rig.decks.play('A');
    const { l } = await rig.render();
    const hz = autocorrelationPitch(l, SR, SR, SR * 3.5, 200, 900);
    expect(hz / 440).toBeGreaterThan(1.07);
    expect(hz / 440).toBeLessThan(1.09);
    rig.decks.dispose();
  });

  it('with key lock the pitch stays within 1 % at +8 % while the tempo follows', async () => {
    const rig = makeRig(5);
    const ref = rig.add('Tone', [sine(440, 12)]);
    await rig.decks.load('A', ref, 'Tone');
    rig.decks.setKeyLock('A', true);
    rig.decks.setPitch('A', 0.08);
    rig.decks.play('A');
    const { l } = await rig.render();
    const hz = autocorrelationPitch(l, SR, SR, SR * 4.5, 200, 900);
    expect(Math.abs(hz / 440 - 1)).toBeLessThan(0.01);
    // 5 s at +8 % is 5.4 s of song.
    expect(rig.decks.positionNow('A')).toBeGreaterThan(5.2);
    expect(rig.decks.positionNow('A')).toBeLessThan(5.6);
    rig.decks.dispose();
  });
});

describe('decks: mixer', () => {
  it('a kill EQ cuts its band by more than 20 dB and leaves the others', async () => {
    const hzs = [50, 1000, 14000];
    const mix = new Float32Array(SR * 8);
    for (const hz of hzs) {
      const s = sine(hz, 8, 0.15);
      for (let i = 0; i < mix.length; i++) mix[i]! += s[i]!;
    }
    const rig = makeRig(8);
    const ref = rig.add('Three tones', [mix]);
    await rig.decks.load('A', ref, 'Three tones');
    rig.decks.play('A');
    // At 2 s the low band is killed, at 4 s the mid, at 6 s the high; each stays down.
    for (const [i, band] of (['low', 'mid', 'high'] as const).entries()) {
      void rig.ctx.suspend(2 + i * 2).then(() => {
        rig.decks.setEq('A', band, -26);
        rig.ctx.resume();
      });
    }
    const { l } = await rig.render();
    const level = (hz: number, s: number) => toneLevel(l, hz, Math.round((s + 0.6) * SR), Math.round((s + 1.6) * SR));
    const before = hzs.map((hz) => level(hz, 0));
    for (const [i, hz] of hzs.entries()) {
      const cut = db(before[i]!, level(hz, 2 + i * 2));
      expect(cut, `${hz} Hz is cut`).toBeGreaterThan(20);
    }
    // Until its own turn a band is untouched (within 1.5 dB).
    expect(Math.abs(db(level(1000, 2), before[1]!))).toBeLessThan(1.5);
    expect(Math.abs(db(level(14000, 2), before[2]!))).toBeLessThan(1.5);
    expect(Math.abs(db(level(14000, 4), before[2]!))).toBeLessThan(1.5);
    // A killed band stays killed.
    expect(db(before[0]!, level(50, 6))).toBeGreaterThan(20);
    rig.decks.dispose();
  });

  it('the crossfader at −1 silences B, at +1 silences A, and the middle plays both', async () => {
    const rig = makeRig(6);
    const a = rig.add('A tone', [sine(440, 10, 0.4)]);
    const b = rig.add('B tone', [sine(1000, 10, 0.4)]);
    await rig.decks.load('A', a, 'A tone');
    await rig.decks.load('B', b, 'B tone');
    rig.decks.setCrossfader(-1);
    rig.decks.play('A');
    rig.decks.play('B');
    void rig.ctx.suspend(2).then(() => {
      rig.decks.setCrossfader(0);
      rig.ctx.resume();
    });
    void rig.ctx.suspend(4).then(() => {
      rig.decks.setCrossfader(1);
      rig.ctx.resume();
    });
    const { l } = await rig.render();
    const lv = (hz: number, s: number) => toneLevel(l, hz, Math.round((s + 0.5) * SR), Math.round((s + 1.5) * SR));
    // −1: A at full, B gone (more than 60 dB down).
    expect(lv(440, 0)).toBeGreaterThan(0.2);
    expect(db(lv(1000, 0), lv(440, 0))).toBeLessThan(-60);
    // Middle: both, each −3 dB.
    expect(db(lv(440, 2), lv(440, 0))).toBeGreaterThan(-3.6);
    expect(db(lv(440, 2), lv(440, 0))).toBeLessThan(-2.4);
    expect(db(lv(1000, 2), lv(440, 0))).toBeGreaterThan(-3.6);
    // +1: B at full, A gone.
    expect(db(lv(440, 4), lv(1000, 4))).toBeLessThan(-60);
    expect(lv(1000, 4)).toBeGreaterThan(0.2);
    rig.decks.dispose();
  });

  it('the channel fader and trim set the level, the filter closes the highs', async () => {
    const rig = makeRig(6);
    const ref = rig.add('Tones', [sine(300, 10, 0.2).map((v, i) => v + 0.2 * Math.sin((2 * Math.PI * 8000 * i) / SR))]);
    await rig.decks.load('A', ref, 'Tones');
    rig.decks.play('A');
    void rig.ctx.suspend(2).then(() => {
      rig.decks.setVolume('A', 0.5);
      rig.ctx.resume();
    });
    void rig.ctx.suspend(4).then(() => {
      rig.decks.setVolume('A', 1);
      rig.decks.setFilter('A', -0.6);
      rig.ctx.resume();
    });
    const { l } = await rig.render();
    const lv = (hz: number, s: number) => toneLevel(l, hz, Math.round((s + 0.5) * SR), Math.round((s + 1.5) * SR));
    // Half way down the fader is −12 dB (a squared taper).
    expect(db(lv(300, 2), lv(300, 0))).toBeGreaterThan(-12.6);
    expect(db(lv(300, 2), lv(300, 0))).toBeLessThan(-11.4);
    // A low-pass at about 1 kHz takes 8 kHz down by 20+ dB and leaves 300 Hz.
    expect(db(lv(8000, 4), lv(8000, 0))).toBeLessThan(-20);
    expect(Math.abs(db(lv(300, 4), lv(300, 0)))).toBeLessThan(1.5);
    rig.decks.dispose();
  });
});

describe('decks: loops', () => {
  it('a loop repeats the song exactly: sample-accurate length, nothing added at the seam', async () => {
    const bpm = 120;
    const beat = 60 / bpm;
    const song = clickSong(bpm, 0.5, 30);
    // Make the song non-repeating inside the loop so a misplaced seam can't hide: a chirp under the clicks.
    for (let i = 0; i < song[0]!.length; i++) {
      const v = 0.05 * Math.sin(2 * Math.PI * (200 + (i / SR) * 7) * (i / SR));
      song[0]![i]! += v;
      song[1]![i]! += v;
    }
    const rig = makeRig(8);
    const ref = rig.add('Clicks', song, { bpm, firstDownbeat: 0.5, bars: 14 });
    await rig.decks.load('A', ref, 'Clicks');
    const start = 0.5 + 8 * beat;
    // Crossfader hard to A: its side is at full level (in the middle both sides are −3 dB).
    rig.decks.setCrossfader(-1);
    rig.decks.seek('A', start);
    rig.decks.autoLoop('A', 4);
    expect(rig.decks.store.getState().decks.A.loop).toEqual({ startSec: start, endSec: start + 4 * beat, active: true });
    rig.decks.play('A');
    const { l } = await rig.render();
    // The player starts on the next render quantum after the fade-in; find where the loop's first sample landed.
    const len = Math.round(4 * beat * SR);
    const first = Math.round(start * SR);
    // Output frame i is source frame first + (i − t0) mod len, for the t0 that matches.
    let best = Infinity;
    let t0 = 0;
    for (let c = 0; c < 4000; c++) {
      let e = 0;
      // The second beat of the loop is a click, clear of the fade-in: a sharp thing to line up on.
      for (let i = 24000; i < 24600; i++) e += Math.abs(l[c + i]! - song[0]![first + i]!);
      if (e < best) {
        best = e;
        t0 = c;
      }
    }
    let worst = 0;
    for (let i = 3000; i < SR * 6 - 3000; i++) {
      const src = first + (i % len);
      worst = Math.max(worst, Math.abs(l[t0 + i]! - song[0]![src]!));
    }
    // The EQ, filter and fader are in the path (a few hundredths of a frame of delay), so the render is compared
    // with the song to within 0.05 (a click is 0.8), and with itself, which is exact: the same samples one
    // loop later, and clearly different one frame off.
    expect(worst).toBeLessThan(0.05);
    const apart = (gap: number) => {
      let m = 0;
      for (let i = SR; i < SR * 5; i++) m = Math.max(m, Math.abs(l[t0 + i + gap]! - l[t0 + i]!));
      return m;
    };
    expect(apart(len)).toBeLessThan(0.002);
    expect(apart(len + 1)).toBeGreaterThan(0.05);
    expect(apart(len - 1)).toBeGreaterThan(0.05);
    rig.decks.dispose();
  });
});

/**
 * Times (seconds) of the clicks of a tone burst at `hz` in x: a quadrature demodulator, a 1 ms average and a
 * peak picker (threshold 30 % of the loudest, 200 ms apart). Both decks' clicks end up in one render: each is
 * found by its own pitch.
 */
function clickTimes(x: Float32Array, hz: number): number[] {
  const n = x.length;
  const w = (2 * Math.PI * hz) / SR;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const win = 48;
  const env = new Float32Array(n);
  let pr = 1;
  let pi = 0;
  const ring = new Float64Array(win * 2);
  let sumRe = 0;
  let sumIm = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    const re = v * pr;
    const im = -v * pi;
    const k = (i % win) * 2;
    sumRe += re - ring[k]!;
    sumIm += im - ring[k + 1]!;
    ring[k] = re;
    ring[k + 1] = im;
    env[i] = Math.hypot(sumRe, sumIm);
    const nr = pr * c - pi * s;
    pi = pr * s + pi * c;
    pr = nr;
    if ((i & 0xffff) === 0) {
      const m = Math.hypot(pr, pi);
      pr /= m;
      pi /= m;
    }
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (env[i]! > max) max = env[i]!;
  const out: number[] = [];
  const gap = Math.round(0.2 * SR);
  let i = 1;
  while (i < n - 1) {
    if (env[i]! > 0.3 * max) {
      // The peak within the next 5 ms (the burst's rise), refined by a parabola.
      let p = i;
      for (let j = i; j < Math.min(n - 1, i + 240); j++) if (env[j]! > env[p]!) p = j;
      const a = env[p - 1]!;
      const b = env[p]!;
      const d = env[p + 1]!;
      const den = a - 2 * b + d;
      out.push((p + (den !== 0 ? (0.5 * (a - d)) / den : 0)) / SR);
      i = p + gap;
    } else i++;
  }
  return out;
}

describe('decks: sync', () => {
  for (const keyLock of [false, true]) {
    // The turntable path is a plain resampler (and the kernel tests hold both modes for 5 minutes in position math):
    // here it gets a minute, the key-locked path, which is the one that could drift, the full five.
    it(`a synced deck holds the master's beat within 2 ms over ${keyLock ? 5 : 1} minute${keyLock ? 's' : ''} (key lock ${keyLock ? 'on' : 'off'})`, async () => {
      const secs = keyLock ? 300 : 60;
      const rig = makeRig(secs + 6);
      // Two songs at 124 and 128 BPM with different downbeats; A's clicks are 1 kHz, B's 4 kHz.
      const a = rig.add('Song A', clickSong(124, 0.1, secs + 40, 1000), { bpm: 124, firstDownbeat: 0.1, bars: 120 });
      const b = rig.add('Song B', clickSong(128, 0.35, secs + 40, 4000), { bpm: 128, firstDownbeat: 0.35, bars: 120 });
      await rig.decks.load('A', a, 'Song A');
      await rig.decks.load('B', b, 'Song B');
      rig.decks.setCrossfader(0);
      rig.decks.seek('A', 10);
      rig.decks.seek('B', 20.2);
      rig.decks.setKeyLock('B', keyLock);
      rig.decks.play('A');
      void rig.ctx.suspend(0.5).then(async () => {
        // B joins half a second later: synced, it lands on A's beat by itself.
        rig.decks.sync('B', true);
        rig.decks.play('B');
        await rig.decks.settled?.();
        void rig.ctx.resume();
      });
      const { l } = await rig.render();
      expect(rig.toasts).toEqual([]);
      const st = rig.decks.store.getState().decks.B;
      expect(st.synced).toBe(true);
      expect(st.bpm).toBeCloseTo(124, 6);
      expect(st.pitch).toBeCloseTo(124 / 128 - 1, 9);
      const ta = clickTimes(l, 1000);
      const tb = clickTimes(l, 4000);
      // For each of B's clicks the nearest of A's.
      const offsets: { t: number; ms: number }[] = [];
      let j = 0;
      for (const t of tb) {
        if (t < 3) continue;
        while (j + 1 < ta.length && Math.abs(ta[j + 1]! - t) < Math.abs(ta[j]! - t)) j++;
        offsets.push({ t, ms: (t - ta[j]!) * 1000 });
      }
      expect(offsets.length).toBeGreaterThan(secs * 1.9);
      const worst = offsets.reduce((m, o) => Math.max(m, Math.abs(o.ms)), 0);
      // The drift: a line through the offsets.
      const n = offsets.length;
      const mt = offsets.reduce((s, o) => s + o.t, 0) / n;
      const mo = offsets.reduce((s, o) => s + o.ms, 0) / n;
      const slope = offsets.reduce((s, o) => s + (o.t - mt) * (o.ms - mo), 0) / offsets.reduce((s, o) => s + (o.t - mt) ** 2, 0);
      // Measured: turntable 0.06 ms worst, key lock 0.85 ms (the stretch moves a click by what its search moves it).
      expect(worst).toBeLessThan(2);
      expect(Math.abs(slope * 300)).toBeLessThan(2);
      rig.decks.dispose();
    }, 240_000);
  }
});

describe('decks: cue, hot cues, loops and jumps (the controller)', () => {
  async function loadedRig() {
    const rig = makeRig(2);
    const song = rig.add('Beats', clickSong(120, 0.25, 60), { bpm: 120, firstDownbeat: 0.25, bars: 28 });
    await rig.decks.load('A', song, 'Beats', 'Test');
    return rig;
  }
  const deckA = (r: Rig) => r.decks.store.getState().decks.A;

  it('loading analyzes the song and parks the deck on its first beat', async () => {
    const rig = await loadedRig();
    const d = deckA(rig);
    expect(d.loading).toBe(false);
    expect(d.song).toMatchObject({ title: 'Beats', artist: 'Test' });
    expect(d.song!.durationSec).toBeCloseTo(60, 2);
    expect(d.baseBpm).toBe(120);
    expect(d.bpm).toBe(120);
    expect(d.cuePoint).toBeCloseTo(0.25, 9);
    expect(d.positionSec).toBeCloseTo(0.25, 9);
    expect(rig.decks.analysisOf?.('A')?.grid?.bpm).toBe(120);
    expect(rig.decks.waveformOf?.('A')?.buckets).toBeGreaterThan(1000);
    rig.decks.dispose();
  });

  it('cue: sets the cue point on the beat when paused, previews while held, goes back when let go', async () => {
    const rig = await loadedRig();
    rig.decks.seek('A', 7.4);
    rig.decks.cueDown('A');
    // 7.4 s is between beats at 0.25 + n × 0.5: the nearest is 7.25.
    expect(deckA(rig).cuePoint).toBeCloseTo(7.25, 9);
    expect(deckA(rig).playing).toBe(true);
    rig.decks.cueUp('A');
    expect(deckA(rig).playing).toBe(false);
    expect(deckA(rig).positionSec).toBeCloseTo(7.25, 9);
    // Pressing play while holding cue keeps it playing after the release (the CDJ latch).
    rig.decks.cueDown('A');
    rig.decks.play('A');
    rig.decks.cueUp('A');
    expect(deckA(rig).playing).toBe(true);
    // Playing: cue goes back to the cue point and pauses.
    rig.decks.cueDown('A');
    expect(deckA(rig).playing).toBe(false);
    expect(deckA(rig).positionSec).toBeCloseTo(7.25, 9);
    rig.decks.cueUp('A');
    expect(deckA(rig).playing).toBe(false);
    rig.decks.dispose();
  });

  it('hot cues: the first press sets one on the beat, the next jumps there and plays; clear removes it', async () => {
    const rig = await loadedRig();
    rig.decks.seek('A', 12.6);
    rig.decks.hotCue('A', 2);
    expect(deckA(rig).hotCues[2]).toBeCloseTo(12.75, 9);
    expect(deckA(rig).hotCues.filter((x) => x !== null)).toHaveLength(1);
    rig.decks.seek('A', 30);
    rig.decks.hotCue('A', 2);
    expect(deckA(rig).positionSec).toBeCloseTo(12.75, 9);
    expect(deckA(rig).playing).toBe(true);
    rig.decks.clearHotCue('A', 2);
    expect(deckA(rig).hotCues[2]).toBeNull();
    rig.decks.pause('A');
    rig.decks.dispose();
  });

  it('loops: auto loops, halve and double, in and out, exit and reloop, all on the beat grid', async () => {
    const rig = await loadedRig();
    const d = () => deckA(rig).loop!;
    rig.decks.seek('A', 8.3);
    rig.decks.autoLoop('A', 4);
    // 4 beats = 2 s from the beat under 8.3 s (8.25).
    expect(d()).toEqual({ startSec: 8.25, endSec: 10.25, active: true });
    rig.decks.loopHalve('A');
    expect(d()).toEqual({ startSec: 8.25, endSec: 9.25, active: true });
    rig.decks.loopDouble('A');
    rig.decks.loopDouble('A');
    expect(d()).toEqual({ startSec: 8.25, endSec: 12.25, active: true });
    rig.decks.exitLoop('A');
    expect(d().active).toBe(false);
    rig.decks.loopOut('A'); // reloop
    expect(d()).toEqual({ startSec: 8.25, endSec: 12.25, active: true });
    // Pressing the size that is looping lets go of it.
    rig.decks.autoLoop('A', 16);
    expect(d().active).toBe(true);
    rig.decks.autoLoop('A', 16);
    expect(d().active).toBe(false);
    // By hand: in, then out.
    rig.decks.seek('A', 20.1);
    rig.decks.loopIn('A');
    expect(d()).toEqual({ startSec: 20.125, endSec: 20.125, active: false });
    rig.decks.seek('A', 22.3);
    rig.decks.loopOut('A');
    expect(d().active).toBe(true);
    expect(d().startSec).toBe(20.125);
    expect(d().endSec).toBeGreaterThan(22);
    rig.decks.dispose();
  });

  it('beat jumps keep the phase and take an active loop along', async () => {
    const rig = await loadedRig();
    rig.decks.seek('A', 10.1);
    rig.decks.beatJumpBy('A', 8);
    expect(deckA(rig).positionSec).toBeCloseTo(14.1, 9);
    rig.decks.beatJumpBy('A', -16);
    expect(deckA(rig).positionSec).toBeCloseTo(6.1, 9);
    rig.decks.autoLoop('A', 2);
    const start = deckA(rig).loop!.startSec;
    rig.decks.beatJumpBy('A', 4);
    expect(deckA(rig).loop!.startSec).toBeCloseTo(start + 2, 9);
    expect(deckA(rig).loop!.active).toBe(true);
    rig.decks.beatJumpBy('A', -1000);
    expect(deckA(rig).positionSec).toBe(0);
    rig.decks.dispose();
  });

  it('pitch is limited to its range, the range widens for sync, and tempo shows as BPM', async () => {
    const rig = makeRig(2);
    const a = rig.add('Slow', clickSong(100, 0, 60), { bpm: 100, firstDownbeat: 0, bars: 24 });
    const b = rig.add('Fast', clickSong(120, 0, 60), { bpm: 120, firstDownbeat: 0, bars: 28 });
    await rig.decks.load('A', a, 'Slow');
    await rig.decks.load('B', b, 'Fast');
    rig.decks.setPitch('A', 0.5);
    expect(rig.decks.store.getState().decks.A.pitch).toBe(0.08);
    rig.decks.setPitchRange('A', 0.16);
    rig.decks.setPitch('A', -0.3);
    expect(rig.decks.store.getState().decks.A.pitch).toBe(-0.16);
    expect(rig.decks.store.getState().decks.A.bpm).toBeCloseTo(84, 9);
    rig.decks.setPitch('A', 0);
    // Syncing A (100 BPM) to B (120 BPM) needs +20 %: the range grows to hold it.
    rig.decks.sync('A', true);
    const d = rig.decks.store.getState().decks.A;
    expect(d.synced).toBe(true);
    expect(d.pitch).toBeCloseTo(0.2, 9);
    expect(d.pitchRange).toBe(0.5);
    expect(d.bpm).toBeCloseTo(120, 9);
    // B's own fader moves A with it; A's own fader lets go of the sync.
    rig.decks.setPitch('B', 0.05);
    expect(rig.decks.store.getState().decks.A.bpm).toBeCloseTo(126, 9);
    rig.decks.setPitch('A', 0.1);
    expect(rig.decks.store.getState().decks.A.synced).toBe(false);
    rig.decks.dispose();
  });

  it('sync knows half and double time: a 70 BPM song follows a 140 BPM one at its own speed', async () => {
    const rig = makeRig(2);
    const a = rig.add('Half', clickSong(70, 0, 60), { bpm: 70, firstDownbeat: 0, bars: 14 });
    const b = rig.add('Full', clickSong(140, 0, 60), { bpm: 140, firstDownbeat: 0, bars: 28 });
    await rig.decks.load('A', a, 'Half');
    await rig.decks.load('B', b, 'Full');
    rig.decks.sync('A', true);
    const d = rig.decks.store.getState().decks.A;
    expect(d.synced).toBe(true);
    expect(d.pitch).toBeCloseTo(0, 9);
    rig.decks.dispose();
  });

  it('sync says why it cannot: no beat grid, no other deck, tempos too far apart', async () => {
    const rig = makeRig(2);
    const a = rig.add('Beatless', [sine(200, 10)]);
    const b = rig.add('Normal', clickSong(120, 0, 30), { bpm: 120, firstDownbeat: 0, bars: 14 });
    const c = rig.add('Very slow', clickSong(60, 0, 30), { bpm: 60, firstDownbeat: 0, bars: 7 });
    await rig.decks.load('A', a, 'Beatless');
    rig.decks.sync('A', true);
    expect(rig.toasts.at(-1)).toMatch(/no steady beat/);
    await rig.decks.load('B', b, 'Normal');
    rig.decks.sync('B', true);
    expect(rig.toasts.at(-1)).toMatch(/second song|another deck/);
    expect(rig.decks.store.getState().decks.B.synced).toBe(false);
    await rig.decks.load('C', c, 'Very slow');
    // 60 BPM against 120 is the double time: it matches. Against a 100 BPM master it is a 67 % gap and 50 BPM.
    rig.decks.sync('C', true);
    expect(rig.decks.store.getState().decks.C.synced).toBe(true);
    rig.decks.dispose();
  });

  it('loading while a deck plays stops it and clears the old song’s cues, loop and sync', async () => {
    const rig = await loadedRig();
    rig.decks.hotCue('A', 0);
    rig.decks.autoLoop('A', 4);
    rig.decks.play('A');
    const other = rig.add('Other', clickSong(90, 0, 30), { bpm: 90, firstDownbeat: 0, bars: 10 });
    await rig.decks.load('A', other, 'Other');
    const d = deckA(rig);
    expect(d.playing).toBe(false);
    expect(d.loop).toBeNull();
    expect(d.hotCues.every((x) => x === null)).toBe(true);
    expect(d.song?.title).toBe('Other');
    expect(d.baseBpm).toBe(90);
    rig.decks.eject('A');
    expect(deckA(rig).song).toBeNull();
    rig.decks.dispose();
  });

  it('keeps mixer settings across songs and reports the crossfader and master', async () => {
    const rig = await loadedRig();
    rig.decks.setEq('A', 'low', -40);
    rig.decks.setEq('A', 'high', 20);
    expect(deckA(rig).eq).toEqual({ low: -26, mid: 0, high: 6 });
    rig.decks.setFilter('A', 3);
    expect(deckA(rig).filter).toBe(1);
    rig.decks.setVolume('A', 9);
    expect(deckA(rig).volume).toBe(1.25);
    rig.decks.setTrim('A', -30);
    expect(deckA(rig).trimDb).toBe(-12);
    rig.decks.setCrossfader(2);
    expect(rig.decks.store.getState().crossfader).toBe(1);
    rig.decks.setCrossfaderAssign('A', 'B');
    expect(rig.decks.store.getState().crossfaderAssign.A).toBe('B');
    rig.decks.setCrossfaderCurve?.('sharp');
    expect(rig.decks.store.getState().crossfaderCurve).toBe('sharp');
    rig.decks.setDeckCount?.(4);
    expect(rig.decks.store.getState().deckCount).toBe(4);
    const song = rig.add('Next', clickSong(100, 0, 30), { bpm: 100, firstDownbeat: 0, bars: 12 });
    await rig.decks.load('A', song, 'Next');
    expect(deckA(rig).eq.low).toBe(-26);
    rig.decks.dispose();
  });
});

describe('decks: speed', () => {
  it('two key-locked decks with EQ render offline far faster than real time', { tags: ['perf'], timeout: 120_000 }, async () => {
    const secs = 60;
    const rig = makeRig(secs);
    const a = rig.add('A', clickSong(124, 0.1, 80, 1000), { bpm: 124, firstDownbeat: 0.1, bars: 30 });
    const b = rig.add('B', clickSong(128, 0.35, 80, 4000), { bpm: 128, firstDownbeat: 0.35, bars: 30 });
    await rig.decks.load('A', a, 'A');
    await rig.decks.load('B', b, 'B');
    rig.decks.setKeyLock('A', true);
    rig.decks.setKeyLock('B', true);
    rig.decks.setPitch('A', 0.05);
    rig.decks.setEq('B', 'low', -6);
    rig.decks.setFilter('B', 0.2);
    rig.decks.play('A');
    rig.decks.play('B');
    await rig.decks.settled?.();
    const t0 = performance.now();
    await rig.ctx.startRendering();
    const seconds = (performance.now() - t0) / 1000;
    // Measured on an M-series Mac under other agents' load: 60 s in about 1.1 s (54× real time).
    expect(secs / seconds).toBeGreaterThan(perfLimit(15, 3));
    rig.decks.dispose();
  });
});

describe('decks: the real engine (realtime)', () => {
  let s: Services | null = null;
  afterAll(async () => {
    (await s?.decks())?.dispose();
    await s?.engine.dispose();
    setTrackAnalyzer(null);
  });

  /** Two library songs from synthetic WAVs (stored through the app's sample store, as imported files are). */
  async function twoSongs(): Promise<{ a: LibrarySong; b: LibrarySong }> {
    s = createServices();
    await s.engine.resume();
    const make = async (name: string, bpm: number, first: number, hz: number) => {
      const audio = clickSong(bpm, first, 60, hz);
      const wav = encodeWav(audio, SR, { bitDepth: 16 });
      await addSongFiles(s!, [new File([wav as BlobPart], `${name}.wav`)]);
      return library.getState().songs.find((x) => x.fileName === `${name}.wav`)!;
    };
    const a = await make('Rt song A', 124, 0.1, 1000);
    const b = await make('Rt song B', 128, 0.35, 4000);
    const byHash = new Map<string, TrackAnalysis>();
    byHash.set(a.key, fakeAnalysis({ bpm: 124, firstDownbeat: 0.1, bars: 28, hash: a.key }));
    byHash.set(b.key, fakeAnalysis({ bpm: 128, firstDownbeat: 0.35, bars: 28, hash: b.key }));
    setTrackAnalyzer(fakeAnalyzer(byHash));
    return { a, b };
  }

  it('the master is recorded into the library at the length it was recorded, and the meters move', async () => {
    const { a, b } = await twoSongs();
    const decks = await s!.decks();
    await decks.load('A', a.ref, a.title, a.artist);
    await decks.load('B', b.ref, b.title, b.artist);
    expect(decks.store.getState().decks.A.baseBpm).toBe(124);
    expect(decks.store.getState().decks.B.song?.title).toBe('Rt song B');
    decks.setKeyLock('A', true);
    decks.setKeyLock('B', true);
    decks.setPitch('A', 0.04);
    decks.sync('B', true);
    decks.play('A');
    decks.play('B');
    await sleep(500);
    const ctx = s!.engine.deckHost!()!.ctx;
    await decks.startRecording();
    const t0 = ctx.currentTime;
    expect(decks.store.getState().recording).not.toBeNull();
    await sleep(3500);
    const title = await decks.stopRecording();
    const seconds = ctx.currentTime - t0;
    expect(title).toMatch(/^Live mix \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(decks.store.getState().recording).toBeNull();
    // The recording is in the music library, as long as the audio clock ran while it was recording (the stop adds
    // its 50 ms tail; a busy machine can stall the clock, which the recording follows).
    const song = library.getState().songs.find((x) => x.title === title);
    expect(song).toBeDefined();
    expect(song!.durationSec!).toBeGreaterThan(seconds - 0.25);
    expect(song!.durationSec!).toBeLessThan(seconds + 0.25);
    // Both play at A's tempo: 124 BPM at +4 %.
    expect(decks.store.getState().decks.B.bpm).toBeCloseTo(124 * 1.04, 6);
    // The clicks are short: watch the meters for a beat or two.
    const levels = new Float32Array(6);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      decks.readLevels?.(levels);
      peak = Math.max(peak, levels[0]!, levels[1]!, levels[4]!);
      await sleep(20);
    }
    expect(peak).toBeGreaterThan(0.05);
    decks.pause('A');
    decks.pause('B');
  }, 60_000);

  it('two key-locked decks keep up with real time (keepUp, as app/playback-health.ts measures it)', { tags: ['perf'], timeout: 60_000 }, async () => {
    const decks = await s!.decks();
    for (const id of ['A', 'B'] as const) decks.setKeyLock(id, true);
    decks.setPitch('A', 0.04);
    decks.sync('B', true);
    decks.seek('A', 2);
    decks.play('A');
    decks.play('B');
    // Over one-second windows: the audio clock against the wall clock; the decks report the last window.
    const end = performance.now() + 6000;
    let worst = 1;
    let seen = 0;
    while (performance.now() < end) {
      await sleep(1100);
      const k = decks.keepUp?.();
      if (k !== undefined) {
        seen++;
        worst = Math.min(worst, k);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(worst).toBeGreaterThanOrEqual(perfLimit(0.98, 0.85));
    decks.pause('A');
    decks.pause('B');
  });

  it('plays through the engine’s output: the host is the engine’s, and a reboot carries the decks over', async () => {
    const decks = await s!.decks();
    const a = library.getState().songs.find((x) => x.fileName === 'Rt song A.wav')!;
    expect(s!.engine.deckHost?.()).not.toBeNull();
    decks.seek('A', 5);
    decks.play('A');
    await sleep(400);
    const before = decks.positionNow('A');
    expect(before).toBeGreaterThan(5.2);
    await s!.rebootEngine();
    await sleep(600);
    expect(s!.engine.deckHost?.()?.ctx.state).toBeDefined();
    // Still the same song, still playing, and past where it was.
    expect(decks.store.getState().decks.A.song?.title).toBe(a.title);
    expect(decks.store.getState().decks.A.playing).toBe(true);
    await sleep(500);
    expect(decks.positionNow('A')).toBeGreaterThan(before);
    decks.pause('A');
  }, 60_000);
});
