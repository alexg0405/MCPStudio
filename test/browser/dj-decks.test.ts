/**
 * DJ live decks through the real audio graph (headless Chrome, 48 kHz): synthetic songs (clicks on every beat at a
 * known tempo, sines for pitch) played by `createDecks` into an OfflineAudioContext, so every check is a render, not a
 * stopwatch. The deck controller, the player worklets, the EQ and filter, the faders and the crossfader are the
 * real ones; only the analyzer is faked (it knows each song's grid).
 */
import { describe, expect, it } from 'vitest';
import { createDecks, type DecksDeps } from '@app/dj/decks';
import type { DecksApi } from '@app/dj/decks-api';
import { fakeAnalysis, type FakeSong } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import { SampleCache } from '@engine/samples';
import { autocorrelationPitch, TestSamples } from '../helpers/audio';

const SR = 48000;

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
