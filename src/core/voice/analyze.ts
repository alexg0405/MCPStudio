/**
 * Voice analysis: a recording of mouth sounds (beatboxing, humming a bass line) in, timed and
 * classified events out. Pure TypeScript, no DOM.
 *
 * Pipeline (all thresholds are in `VOICE_THRESHOLDS`):
 *   1. High-pass at 30 Hz (DC, rumble). Envelopes on 1 ms blocks in three bands (full, < 300 Hz,
 *      > 3 kHz): 11 ms RMS for levels, rises and decay, 3 ms RMS for onset times. The noise floor is
 *      the 10th percentile of the level, capped 25 dB under the loudest moment (so continuous
 *      humming still has a floor under it).
 *   2. Onset candidates: spectral flux of log-compressed band magnitudes (knee just above the noise
 *      floor; ~21 ms Hann frames at 100 frames/s, each compared with the frame 20 ms back;
 *      quarter-octave bands from 30 Hz to 16 kHz), adaptive threshold = moving median × 1.5 +
 *      offset, local-maximum peak picking.
 *   3. Each candidate is checked on the envelopes. Its level must have risen by a few dB (valley →
 *      peak) in the full band, or by more in a sub-band that holds a real share of the sound (a hat
 *      over a kick's tail rises only above 3 kHz). Borderline rises get a second look: after a low
 *      note the level is measured over two pitch periods (it ripples at that rate), after noise the
 *      valley is the median rather than the minimum (noise wobbles). Then gates: the peak must clear
 *      the noise floor and lie within a range under the loudest sound, and a noisy sound that takes
 *      over 40 ms to reach half its level is a swell (a breath), not an attack. The onset time is
 *      where the attack, on the 3 ms envelope of the band that rose most, passes 5 % of the way from
 *      the valley to the peak. Onsets closer than `minGapSec` collapse into one.
 *   4. Per event: peak level, decay (−30 dB from the peak or 6 dB over the noise floor, held 10 ms),
 *      sustain (time above −15 dB), and features from the first 60 ms under an attack-weighted
 *      window, with the background just before the onset (noise, the previous sound's tail)
 *      subtracted per band: power-weighted spectral centroid, energy ratios below 150 Hz and above
 *      4 kHz, zero-crossing rate, and YIN periodicity (on audio decimated to ~8 kHz).
 *   5. Classification: tonal needs periodicity, sustain, confidently pitched frames, little energy
 *      above 4 kHz and no kick-like pitch drop at the start; otherwise kick / snare / hat from soft
 *      (logistic) scores on centroid, the energy ratios and length.
 *   6. Tonal events: onsets inside a sustained tonal event without a real level rise merge away,
 *      then the pitch track splits notes where the pitch moves > 1.5 semitones and stays there
 *      ≥ 60 ms. A glide that never settles stays one event; `pitchEnd` tells where it went.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from './fft';
import { butterworth, decimate, filterInPlace } from './filters';
import { Yin, hzToMidi, pitchDecimation, sanitize } from './pitch';

export type VoiceKind = 'kick' | 'snare' | 'hat' | 'tonal';

export interface VoiceFeatures {
  /** Spectral centroid in Hz (power-weighted) over the first 60 ms. */
  centroid: number;
  /** Fraction of the energy below 150 Hz. */
  lowRatio: number;
  /** Fraction of the energy above 4 kHz. */
  highRatio: number;
  /** Zero crossings per second. */
  zcr: number;
  /** YIN periodicity 0..1 (1 − CMND minimum: ≈ 1 for a clean tone, low for noise). */
  periodicity: number;
}

export interface VoiceEvent {
  /** Seconds from the start of the audio (the onset). */
  time: number;
  /** Seconds until it decays (−30 dB from its peak) or the next onset. */
  duration: number;
  /** 0..1, peak level relative to the loudest event (linear amplitude). */
  strength: number;
  kind: VoiceKind;
  /** 0..1 how sure the classification is. */
  confidence: number;
  /** Tonal: median MIDI pitch (fractional) of the confident frames; otherwise null. */
  pitch: number | null;
  /** Tonal: MIDI pitch near the end (for slides/glides); otherwise null. */
  pitchEnd: number | null;
  features: VoiceFeatures;
}

export interface AnalyzeOptions {
  /** 0..1, default 0.5. Higher finds quieter and softer onsets (and more false ones). */
  sensitivity?: number;
  /** Onsets closer than this collapse into one (default 0.05 s). */
  minGapSec?: number;
  /** 'drums' never returns tonal; 'tonal' makes every event tonal (with pitch where detectable). */
  mode?: 'auto' | 'drums' | 'tonal';
}

/**
 * Every threshold the analysis uses, in one place. `[a, b]` pairs depend on `sensitivity`: a at 0,
 * b at 1, linear in between (the default 0.5 is the midpoint). Drum thresholds are soft: each is
 * the 50 % point of a logistic score.
 */
export const VOICE_THRESHOLDS = {
  highPassHz: 30,
  /** Features (spectrum, zcr, periodicity) are measured over this much audio after the onset. */
  featureSec: 0.06,

  /** A recording whose loudest moment is under this (dBFS RMS) is silence. */
  silenceDbfs: -80,

  // Onsets
  /** Adaptive threshold = median of the flux over ~95 ms × this + `fluxOffset`. */
  fluxMedianFactor: 1.5,
  /** Flux offset (mean log-magnitude rise per band, nepers). */
  fluxOffset: [0.2, 0.05],
  /** The level must rise this much (dB, valley → peak). Bands: full, < 300 Hz, > 3 kHz. */
  onsetRiseDb: [9, 3],
  /** A sub-band's rise counts when the band holds at least this share of the level (dB)… */
  subBandShareDb: -10,
  /**
   * …and must exceed the threshold by this much more (dB): the level of a narrow band of noise
   * wobbles (11 ms RMS below 300 Hz has ~6 degrees of freedom, above 3 kHz hundreds).
   */
  lowBandPenaltyDb: 12,
  highBandPenaltyDb: 6,
  /** Onset time: where the attack is this fraction (amplitude) of the way from the valley to the peak. */
  onsetFraction: 0.05,
  /** Gate: the peak level must be at least this far above the noise floor (dB)… */
  gateAboveNoiseDb: [20, 6],
  /** …and at most this far under the loudest moment of the recording (dB). */
  gateRangeDb: [30, 54],
  /** The noise floor estimate is capped this far under the loudest moment (dB). */
  noiseCapDb: 25,
  /**
   * Swells: a sound that takes longer than this (s) from its onset to half its peak level within
   * 400 ms, and whose periodicity is under `swellPeriodicity`, is a breath or similar noise swell
   * and is dropped. Drums get there in a few ms; a slowly swelling hum is periodic and stays.
   */
  swellAttackSec: 0.04,
  swellPeriodicity: 0.5,
  /** An onset inside a still-sustained tonal event needs a full-band rise of this much (dB), else it merges. */
  legatoRiseDb: 8,

  // Envelope measurements
  /** Decay = the level falls this far under the peak (dB)… */
  decayDb: 30,
  /** …or to this far over the noise floor (dB), whichever is higher. */
  decayAboveNoiseDb: 6,
  /** Sustain = time from the onset until the level falls this far under the peak (dB). */
  sustainDropDb: 15,

  // Tonal
  /** Minimum YIN periodicity over the first 60 ms. */
  tonalPeriodicity: 0.8,
  /** Minimum sustain (s). */
  tonalSustainSec: 0.12,
  /** Minimum fraction of confidently pitched frames over the sustained part. */
  tonalVoicedRatio: 0.6,
  /** Maximum energy fraction above 4 kHz (voices hum low; the pitch tracker can't see above 4 kHz). */
  tonalMaxHighRatio: 0.4,
  /** Maximum pitch change between the first 20 ms and 60–80 ms in (semitones): a kick sweeps down faster. */
  tonalMaxSweepSemitones: 5,
  /** A frame is confidently pitched at this YIN confidence (1 − aperiodicity). */
  pitchConfidence: 0.75,
  /** Pitch frames more than this far under the event's peak are ignored (dB). */
  pitchRangeDb: 25,
  /** Legato note change: the pitch moves more than this (semitones)… */
  splitSemitones: 1.5,
  /** …and stays there at least this long (s)… */
  splitHoldSec: 0.06,
  /** …within this of its median (semitones), drifting less than `stableDrift` across the hold. */
  stableSemitones: 0.35,
  stableDrift: 0.2,

  // Drums
  /** Kick: energy below 150 Hz at least this, or… */
  kickLowRatio: 0.3,
  /** …centroid under this (Hz). */
  kickCentroidHz: 400,
  /** Hat: energy above 4 kHz at least this, centroid over `hatCentroidHz` (Hz), shorter than `hatMaxSec`. */
  hatHighRatio: 0.65,
  hatCentroidHz: 5000,
  /** Longer bright sounds lean to snare (e.g. "psh"). */
  hatMaxSec: 0.15,
} as const;

type SensPair = readonly [number, number];
const T = VOICE_THRESHOLDS;

const BLOCK_SEC = 0.001;
const HOP_SEC = 0.005;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const dbToAmp = (db: number): number => Math.pow(10, db / 20);
const ampToDb = (a: number): number => 20 * Math.log10(Math.max(a, 1e-12));

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

interface Onset {
  /** Seconds. */
  time: number;
  /** Flux peak value (for choosing between close onsets). */
  flux: number;
  /** Rise in the band that rose most (dB). */
  riseDb: number;
  /** Rise of the full-band level (dB). */
  fullRiseDb: number;
  /** A legato note change found in the pitch track (no attack: no background subtraction). */
  split?: boolean;
}

interface Measured {
  onset: Onset;
  /** Previous onset (s), −Infinity for the first. */
  prev: number;
  /** Span end: next onset or end of audio (s). */
  end: number;
  peak: number;
  /** Seconds. */
  duration: number;
  sustainSec: number;
  features: VoiceFeatures;
  kind: VoiceKind;
  confidence: number;
}

/** Analyses mouth sounds into events; see the module comment for the pipeline. */
export function analyzeVoice(samples: Float32Array, sampleRate: number, opts: AnalyzeOptions = {}): VoiceEvent[] {
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || samples.length < 2) return [];
  return new Analysis(samples, sampleRate, opts).run();
}

class Analysis {
  private readonly sr: number;
  private readonly sens: number;
  private readonly minGap: number;
  private readonly mode: 'auto' | 'drums' | 'tonal';
  private readonly x: Float32Array;
  private readonly n: number;

  // Envelopes on 1 ms blocks; bands: 0 = full, 1 = low (< 300 Hz), 2 = high (> 3 kHz).
  private readonly block: number;
  private readonly blocks: number;
  /** Prefix sums of the block energies per band (any RMS window from them). */
  private readonly prefix: Float64Array[];
  /** 11 ms RMS per band. `slow[0]` is the level used everywhere. */
  private readonly slow: Float32Array[];
  /** 3 ms RMS per band (onset times). */
  private readonly fast: Float32Array[];
  private readonly env: Float32Array;
  private readonly peakLevel: number;
  private readonly noise: number;
  /** The recording's typical quiet level: the 10th percentile, uncapped. */
  private readonly quiet: number;

  /** Pitch frames: frame i is centered at i × hop (~5 ms). */
  private readonly hop: number;
  private readonly frames: number;
  /** Onset-detection frames: twice the pitch hop (~10 ms, 100 frames/s). */
  private readonly fluxHop: number;

  // Pitch track, computed on demand
  private readonly decim: number;
  private readonly yin: Yin;
  private xd: Float32Array | null = null;
  private readonly f0: Float32Array;
  private readonly aper: Float32Array;
  private readonly frameDb: Float32Array;
  private readonly done: Uint8Array;

  // Feature spectra
  private readonly featureFft: RealFFT;
  private readonly power: Float64Array;
  private readonly bandOf: Int8Array;
  private readonly bandHz: Float64Array;
  private readonly highBand: number;
  private readonly bandEnergy: Float64Array;
  private readonly bandBackground: Float64Array;
  private readonly windows = new Map<string, { w: Float64Array; energy: number }>();

  constructor(samples: Float32Array, sampleRate: number, opts: AnalyzeOptions) {
    const sr = sampleRate;
    this.sr = sr;
    this.sens = Math.min(1, Math.max(0, opts.sensitivity ?? 0.5));
    this.minGap = Math.max(0, opts.minGapSec ?? 0.05);
    this.mode = opts.mode ?? 'auto';
    this.x = sanitize(samples);
    filterInPlace(this.x, butterworth('highpass', 2, T.highPassHz, sr));
    this.n = this.x.length;

    this.block = Math.max(1, Math.round(sr * BLOCK_SEC));
    this.blocks = Math.ceil(this.n / this.block);
    this.prefix = this.bandEnergies();
    this.slow = this.prefix.map((p) => this.rms(p, 5));
    this.fast = this.prefix.map((p) => this.rms(p, 1));
    this.env = this.slow[0] as Float32Array;
    let peak = 0;
    for (let j = 0; j < this.blocks; j++) peak = Math.max(peak, this.env[j] as number);
    this.peakLevel = peak;
    this.quiet = this.percentile(this.env, 0.1);
    this.noise = Math.min(this.quiet, peak * dbToAmp(-T.noiseCapDb));

    this.decim = pitchDecimation(sr, 1000);
    const rate = sr / this.decim;
    this.yin = new Yin(rate, 40, 1000, Math.max(rate / 40, rate * 0.01));
    this.hop = this.decim * Math.max(1, Math.round((HOP_SEC * sr) / this.decim));
    this.frames = Math.floor((this.n - 1) / this.hop) + 1;
    this.fluxHop = 2 * this.hop;
    this.f0 = new Float32Array(this.frames);
    this.aper = new Float32Array(this.frames);
    this.frameDb = new Float32Array(this.frames);
    this.done = new Uint8Array(this.frames);

    // Feature bands: 30–150 Hz, 150–315 Hz, then third octaves with an edge at 4 kHz.
    this.featureFft = new RealFFT(Math.max(2, nextPowerOfTwo(Math.round(T.featureSec * sr))));
    this.power = new Float64Array(this.featureFft.bins);
    const edges = [T.highPassHz, 150];
    let highBand = -1;
    for (let k = -11; ; k++) {
      const f = 4000 * Math.pow(2, k / 3);
      if (f >= sr / 2) break;
      if (k === 0) highBand = edges.length;
      edges.push(f);
    }
    edges.push(sr / 2);
    const bands = edges.length - 1;
    this.highBand = highBand < 0 ? bands : highBand;
    this.bandHz = new Float64Array(bands);
    for (let b = 0; b < bands; b++) this.bandHz[b] = Math.sqrt((edges[b] as number) * (edges[b + 1] as number));
    this.bandOf = new Int8Array(this.featureFft.bins).fill(-1);
    const binHz = sr / this.featureFft.size;
    for (let k = 1, b = 0; k < this.featureFft.bins; k++) {
      const f = k * binHz;
      while (b < bands && f >= (edges[b + 1] as number)) b++;
      if (f >= T.highPassHz && b < bands) this.bandOf[k] = b;
    }
    this.bandEnergy = new Float64Array(bands);
    this.bandBackground = new Float64Array(bands);
  }

  run(): VoiceEvent[] {
    if (!(this.peakLevel > dbToAmp(T.silenceDbfs))) return [];
    const onsets = this.detectOnsets();
    if (onsets.length === 0) return [];
    const total = this.n / this.sr;
    let events = onsets.map((o, i) => this.measure(o, onsets[i - 1]?.time ?? -Infinity, onsets[i + 1]?.time ?? total));
    if (this.mode !== 'drums') {
      events = this.mergeLegato(events);
      events = this.splitByPitch(events);
    }
    return this.finish(events);
  }

  // ---------------------------------------------------------------------------------------------
  // Envelopes

  /**
   * Prefix sums (length blocks + 1) of the energy per block in the full band, below 300 Hz and
   * above 3 kHz, in one pass (the two filters are streamed; nothing is copied).
   */
  private bandEnergies(): Float64Array[] {
    const x = this.x;
    const n = this.n;
    const B = this.block;
    const nb = this.blocks;
    const full = new Float64Array(nb + 1);
    const low = new Float64Array(nb + 1);
    const high = new Float64Array(nb + 1);
    const lp = butterworth('lowpass', 2, 300, this.sr);
    const hp = butterworth('highpass', 2, 3000, this.sr);
    const l0 = lp[0] as number;
    const l1 = lp[1] as number;
    const l2 = lp[2] as number;
    const l3 = lp[3] as number;
    const l4 = lp[4] as number;
    const h0 = hp[0] as number;
    const h1 = hp[1] as number;
    const h2 = hp[2] as number;
    const h3 = hp[3] as number;
    const h4 = hp[4] as number;
    let lz1 = 0;
    let lz2 = 0;
    let hz1 = 0;
    let hz2 = 0;
    for (let j = 0; j < nb; j++) {
      let ef = 0;
      let el = 0;
      let eh = 0;
      const end = Math.min(n, (j + 1) * B);
      for (let i = j * B; i < end; i++) {
        const v = x[i] as number;
        ef += v * v;
        const yl = l0 * v + lz1;
        lz1 = l1 * v - l3 * yl + lz2;
        lz2 = l2 * v - l4 * yl;
        el += yl * yl;
        const yh = h0 * v + hz1;
        hz1 = h1 * v - h3 * yh + hz2;
        hz2 = h2 * v - h4 * yh;
        eh += yh * yh;
      }
      // Flush denormals (digital silence after a sound) once per block.
      if (Math.abs(lz1) < 1e-30) lz1 = 0;
      if (Math.abs(lz2) < 1e-30) lz2 = 0;
      if (Math.abs(hz1) < 1e-30) hz1 = 0;
      if (Math.abs(hz2) < 1e-30) hz2 = 0;
      full[j + 1] = (full[j] as number) + ef;
      low[j + 1] = (low[j] as number) + el;
      high[j + 1] = (high[j] as number) + eh;
    }
    return [full, low, high];
  }

  /** RMS of `band` over 2h + 1 blocks centered on block j (zeros beyond the ends). */
  private levelAt(band: number, j: number, h: number): number {
    const prefix = this.prefix[band] as Float64Array;
    const lo = Math.min(this.blocks, Math.max(0, j - h));
    const hi = Math.min(this.blocks, Math.max(0, j + h + 1));
    return Math.sqrt(Math.max(0, (prefix[hi] as number) - (prefix[lo] as number)) / ((2 * h + 1) * this.block));
  }

  /** Centered RMS over 2h + 1 blocks for every block. */
  private rms(prefix: Float64Array, h: number): Float32Array {
    const nb = this.blocks;
    const out = new Float32Array(nb);
    const norm = 1 / ((2 * h + 1) * this.block);
    for (let j = 0; j < nb; j++) {
      const lo = Math.max(0, j - h);
      const hi = Math.min(nb, j + h + 1);
      out[j] = Math.sqrt(Math.max(0, (prefix[hi] as number) - (prefix[lo] as number)) * norm);
    }
    return out;
  }

  /** Level percentile (0.5 dB histogram). */
  private percentile(level: Float32Array, q: number): number {
    const lo = -160;
    const bins = new Uint32Array(400);
    for (let j = 0; j < level.length; j++) {
      const b = Math.min(399, Math.max(0, Math.floor((ampToDb(level[j] as number) - lo) * 2)));
      bins[b] = (bins[b] as number) + 1;
    }
    const target = q * level.length;
    let acc = 0;
    for (let b = 0; b < bins.length; b++) {
      acc += bins[b] as number;
      if (acc >= target) return dbToAmp(lo + (b + 0.5) / 2);
    }
    return dbToAmp(lo);
  }

  private blockAt(sec: number): number {
    return Math.min(this.blocks - 1, Math.max(0, Math.floor((sec * this.sr) / this.block)));
  }

  /** Start time of block j (s). */
  private blockStart(j: number): number {
    return (j * this.block) / this.sr;
  }

  private maxIn(e: Float32Array, from: number, to: number): { at: number; value: number } {
    const lo = Math.max(0, from);
    let at = lo;
    let value = 0;
    for (let j = lo; j <= Math.min(this.blocks - 1, to); j++) {
      if ((e[j] as number) > value) {
        value = e[j] as number;
        at = j;
      }
    }
    return { at, value };
  }

  private minIn(e: Float32Array, from: number, to: number): { at: number; value: number } {
    const lo = Math.max(0, from);
    let at = lo;
    let value = Infinity;
    for (let j = lo; j <= Math.min(this.blocks - 1, to); j++) {
      if ((e[j] as number) < value) {
        value = e[j] as number;
        at = j;
      }
    }
    return { at, value: Number.isFinite(value) ? value : 0 };
  }

  private bySensitivity(pair: SensPair): number {
    return pair[0] + (pair[1] - pair[0]) * this.sens;
  }

  // ---------------------------------------------------------------------------------------------
  // Onsets

  private detectOnsets(): Onset[] {
    const odf = this.flux();
    const F = odf.length;
    const offset = this.bySensitivity(T.fluxOffset);
    const scratch = new Float64Array(10);
    const candidates: { frame: number; flux: number }[] = [];
    for (let i = 0; i < F; i++) {
      const v = odf[i] as number;
      if (v <= offset) continue;
      let peak = true;
      for (let d = -2; d <= 2 && peak; d++) {
        if (d === 0 || i + d < 0 || i + d >= F) continue;
        const w = odf[i + d] as number;
        if (d < 0 ? w >= v : w > v) peak = false;
      }
      if (!peak) continue;
      // Moving median over [i − 6, i + 3] (~95 ms; insertion sort into the scratch buffer).
      let m = 0;
      for (let j = Math.max(0, i - 6); j <= Math.min(F - 1, i + 3); j++) {
        const w = odf[j] as number;
        let k = m++;
        while (k > 0 && (scratch[k - 1] as number) > w) {
          scratch[k] = scratch[k - 1] as number;
          k--;
        }
        scratch[k] = w;
      }
      const med =
        m & 1 ? (scratch[m >> 1] as number) : ((scratch[(m >> 1) - 1] as number) + (scratch[m >> 1] as number)) / 2;
      if (v >= T.fluxMedianFactor * med + offset) candidates.push({ frame: i, flux: v });
    }

    const gate = Math.max(
      this.noise * dbToAmp(this.bySensitivity(T.gateAboveNoiseDb)),
      this.peakLevel * dbToAmp(-this.bySensitivity(T.gateRangeDb)),
    );
    const minRise = this.bySensitivity(T.onsetRiseDb);
    const accepted: Onset[] = [];
    let prevTime = -Infinity;
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c] as { frame: number; flux: number };
      const next = candidates[c + 1];
      const center = (cand.frame * this.fluxHop) / this.sr;
      const nextTime = next ? (next.frame * this.fluxHop) / this.sr : Infinity;
      const onset = this.refine(center, prevTime, nextTime, cand.flux, minRise);
      if (!onset || onset.riseDb < minRise) continue;
      const t = onset.time;
      // Stay clear of the next candidate: its flux frame can trail a soft attack by ~20 ms.
      const stop = Math.max(t + 0.005, nextTime - 0.03);
      const level = this.maxIn(this.env, this.blockAt(t), this.blockAt(Math.min(t + T.featureSec, stop))).value;
      if (level < gate) continue;
      // A noisy sound that takes long to reach half its peak is a swell (a breath), not an attack.
      const b0 = this.blockAt(t);
      const later = this.maxIn(this.env, b0, this.blockAt(Math.min(t + 0.4, stop))).value;
      let reach = b0;
      while (reach < this.blocks - 1 && (this.env[reach] as number) < 0.5 * later) reach++;
      const attackSec = this.blockStart(reach) - t;
      if (attackSec > T.swellAttackSec && this.periodicity(t, nextTime) < T.swellPeriodicity) continue;
      accepted.push(onset);
      prevTime = onset.time;
    }

    // Collapse onsets closer than minGap: keep the earlier one unless the later is much stronger.
    accepted.sort((a, b) => a.time - b.time);
    const out: Onset[] = [];
    for (const o of accepted) {
      const last = out[out.length - 1];
      if (last && o.time - last.time < this.minGap) {
        if (o.flux > 2 * last.flux) out[out.length - 1] = o;
        else {
          last.riseDb = Math.max(last.riseDb, o.riseDb);
          last.fullRiseDb = Math.max(last.fullRiseDb, o.fullRiseDb);
        }
        continue;
      }
      out.push(o);
    }
    return out;
  }

  /** Onset detection function: spectral flux of log-compressed band magnitudes, per frame. */
  private flux(): Float32Array {
    const sr = this.sr;
    const N = Math.max(256, nextPowerOfTwo(Math.round(0.02 * sr)));
    const fft = new RealFFT(N);
    const window = hannWindow(N);
    const mag = new Float32Array(fft.bins);

    // Quarter-octave bands from 30 Hz to 16 kHz (each at least one bin).
    const top = Math.min(16000, 0.95 * (sr / 2));
    const edges: number[] = [];
    for (let f = 30; f <= top; f *= Math.pow(2, 0.25)) {
      const bin = Math.max(1, Math.round((f * N) / sr));
      if (edges.length === 0 || bin > (edges[edges.length - 1] as number)) edges.push(bin);
    }
    const topBin = Math.min(fft.bins - 1, Math.round((top * N) / sr));
    if (topBin > (edges[edges.length - 1] as number)) edges.push(topBin);
    const bands = Math.max(0, edges.length - 1);

    // log(1 + m / knee) with the knee just above the noise floor (never more than 50 dB under the peak).
    let w2 = 0;
    for (let i = 0; i < N; i++) w2 += (window[i] as number) * (window[i] as number);
    const noiseMag = 0.886 * Math.sqrt(w2); // mean |X| of unit-RMS white noise under this window
    const knee = Math.max(2 * this.noise, this.peakLevel * dbToAmp(-50)) * noiseMag;
    const invKnee = 1 / Math.max(knee, 1e-12);

    // Rise against the frame two back (20 ms), so an attack between two frames isn't split in half.
    const lag = 2;
    const rows = new Float32Array((lag + 1) * Math.max(1, bands));
    const odf = new Float32Array(Math.floor((this.n - 1) / this.fluxHop) + 1);
    for (let i = 0; i < odf.length; i++) {
      magnitudeSpectrum(fft, this.x, i * this.fluxHop - N / 2, window, mag);
      const cur = (i % (lag + 1)) * bands;
      const old = ((i + 1) % (lag + 1)) * bands; // frame i − lag
      let sum = 0;
      for (let b = 0; b < bands; b++) {
        const lo = edges[b] as number;
        const hi = edges[b + 1] as number;
        let s = 0;
        for (let k = lo; k < hi; k++) s += mag[k] as number;
        const l = Math.log1p((s / (hi - lo)) * invKnee);
        const d = l - (i >= lag ? (rows[old + b] as number) : 0);
        if (d > 0) sum += d;
        rows[cur + b] = l;
      }
      odf[i] = bands > 0 ? sum / bands : 0;
    }
    return odf;
  }

  /**
   * Level rise of `band` (RMS over 2h + 1 blocks): the peak in [pLo, pHi] over the valley in
   * [lo, peak]. Windows never reach `limit` (the next onset). With `fromStart` the time before the
   * recording counts as its typical quiet level. With `medianUntil` the valley is the median level
   * over [lo, medianUntil] instead of the minimum.
   */
  private rise(
    band: number,
    h: number,
    lo: number,
    pLo: number,
    pHi: number,
    limit: number,
    floor: number,
    fromStart: boolean,
    medianUntil = -1,
  ): { db: number; peak: number } {
    const slow = h === 5 ? (this.slow[band] as Float32Array) : null;
    const level = (j: number) => (slow ? (slow[j] as number) : this.levelAt(band, j, h));
    let peak = 0;
    let peakAt = pLo;
    for (let j = pLo; j <= Math.min(pHi, limit - h - 1); j++) {
      const v = level(j);
      if (v > peak) {
        peak = v;
        peakAt = j;
      }
    }
    let valley = fromStart ? this.quiet : Infinity;
    if (medianUntil >= 0) {
      const before: number[] = [];
      for (let j = Math.min(lo, peakAt); j <= Math.min(medianUntil, peakAt); j++) before.push(level(j));
      if (before.length > 0) valley = Math.min(valley, median(before));
    } else for (let j = Math.min(lo, peakAt); j <= peakAt; j++) valley = Math.min(valley, level(j));
    return { db: ampToDb(peak) - ampToDb(Math.max(valley, floor)), peak };
  }

  /** The sound just before `t`: median f0 of its voiced frames (0 if unvoiced) and median periodicity. */
  private before(t: number): { f0: number; periodicity: number } {
    const from = this.frameAt(t - 0.06);
    const to = this.frameAt(t - 0.03);
    this.ensurePitch(from, to);
    const hz: number[] = [];
    const per: number[] = [];
    for (let i = from; i <= to; i++) {
      if ((this.f0[i] as number) > 0) hz.push(this.f0[i] as number);
      per.push(1 - (this.aper[i] as number));
    }
    return { f0: hz.length >= 2 ? median(hz) : 0, periodicity: median(per) };
  }

  /**
   * The attack behind a flux peak at `center`: per band, the level peak in [center − 10 ms,
   * center + 30 ms] over the valley up to 40 ms before it (see the module comment for the second
   * looks at borderline rises). The band that rose most gives the time: on its 3 ms envelope, the
   * start of the final climb past 5 % of the way from the valley to the peak.
   */
  private refine(center: number, prevTime: number, nextTime: number, flux: number, minRise: number): Onset | null {
    const lo = this.blockAt(Math.max(center - 0.04, prevTime + 0.01));
    const pLo = this.blockAt(Math.max(center - 0.01, prevTime + 0.01));
    const pHi = this.blockAt(Math.min(center + 0.03, nextTime - 0.005));
    // Flux frames can sit a few ms after the attack they found, so keep a margin before the next one.
    const limit = Number.isFinite(nextTime) ? this.blockAt(nextTime - 0.005) : this.blocks + 5;
    if (pHi < pLo) return null;
    const floor = Math.max(this.noise * 0.5, this.peakLevel * dbToAmp(-80), 1e-9);
    // A sound at the very start has no "before" in the recording: compare with its quiet level.
    const fromStart = prevTime === -Infinity && center - 0.04 < 0;
    const rises = [0, 1, 2].map((b) => this.rise(b, 5, lo, pLo, pHi, limit, floor, fromStart));
    // Only a borderline rise is worth a second look (clear ones stand, small ones fail anyway).
    const best = Math.max(...rises.map((r) => r.db));
    if (best >= minRise && best < 12) {
      const before = this.before(center);
      if (before.f0 > 0 && before.f0 < 90) {
        const h = Math.max(5, Math.round(1 / before.f0 / BLOCK_SEC));
        rises[0] = this.rise(0, h, lo, pLo, pHi, limit, floor, fromStart);
        rises[1] = this.rise(1, h, lo, pLo, pHi, limit, floor, fromStart);
      } else if (before.periodicity < T.swellPeriodicity) {
        // In noise the minimum of a few RMS readings is biased low (a breath "rises" by chance):
        // compare with the median level before the candidate instead.
        for (let b = 0; b < rises.length; b++) rises[b] = this.rise(b, 5, lo, pLo, pHi, limit, floor, fromStart, pLo);
      }
    }
    const fullPeak = (rises[0] as { peak: number }).peak;
    const fullRiseDb = (rises[0] as { db: number }).db;
    let band = 0;
    let riseDb = fullRiseDb;
    rises.forEach((r, b) => {
      // A sub-band counts when it carries a real part of the sound (≥ −10 dB of the full band), and
      // must rise more than the full band would have to: narrow bands of noise wobble more.
      if (b === 0 || r.peak < dbToAmp(T.subBandShareDb) * fullPeak) return;
      const db = Math.max(fullRiseDb, r.db - (b === 1 ? T.lowBandPenaltyDb : T.highBandPenaltyDb));
      if (db > riseDb) {
        riseDb = db;
        band = b;
      }
    });
    const e = this.fast[band] as Float32Array;
    const p = this.maxIn(e, pLo, pHi);
    if (!(p.value > 0)) return null;
    const v = this.minIn(e, Math.min(lo, p.at), p.at);
    // Relative to the 11 ms peak: the 3 ms one rides the ripple crests of low notes.
    const ref = Math.max(v.value, this.maxIn(this.slow[band] as Float32Array, pLo, pHi).value);
    const level = v.value + T.onsetFraction * (ref - v.value);
    // Walk back from the peak to the first block under the level (not across troughs: the rippling
    // tail of a previous kick can sit above it).
    let at = p.at;
    while (at > v.at && (e[at - 1] as number) >= level) at--;
    // The 3 ms window reaches one block ahead, so a sharp attack shows a block early.
    return { time: this.blockStart(at + 1), flux, riseDb, fullRiseDb };
  }

  // ---------------------------------------------------------------------------------------------
  // Events

  private measure(onset: Onset, prev: number, end: number): Measured {
    const t0 = onset.time;
    const b0 = this.blockAt(t0);
    // The level is an 11 ms centered RMS: stop before it sees the next onset.
    const bEnd = Math.max(b0, this.blockAt(end - 0.007));
    const { at: peakAt, value: peak } = this.maxIn(this.env, b0, bEnd);
    const decayLevel = Math.max(peak * dbToAmp(-T.decayDb), this.noise * dbToAmp(T.decayAboveNoiseDb));
    // A sound still going at the next onset lasts until it (the level stops 7 ms short).
    const until = (j: number) => (j < 0 ? end : Math.min(end, this.blockStart(j)));
    const m: Measured = {
      onset,
      prev,
      end,
      peak,
      duration: Math.max(BLOCK_SEC, until(this.firstBelow(peakAt, bEnd, decayLevel)) - t0),
      sustainSec: Math.max(0, until(this.firstBelow(peakAt, bEnd, peak * dbToAmp(-T.sustainDropDb))) - t0),
      features: this.features(onset, prev, end),
      kind: 'snare',
      confidence: 0,
    };
    this.classify(m);
    return m;
  }

  /**
   * First block in [from, to] where the level stays below `level` for 10 ms (or from where it is
   * below up to `to`); −1 if it never goes below.
   */
  private firstBelow(from: number, to: number, level: number): number {
    const env = this.env;
    let run = 0;
    for (let j = from; j <= to; j++) {
      if ((env[j] as number) < level) {
        if (++run >= 10) return j - 9;
      } else run = 0;
    }
    return run > 0 ? to - run + 1 : -1;
  }

  /** Window of `len` samples: 'attack' rises over 2 ms and falls as a half cosine; 'hann' is Hann. */
  private window(kind: 'attack' | 'hann', len: number): { w: Float64Array; energy: number } {
    const key = `${kind}:${len}`;
    let entry = this.windows.get(key);
    if (!entry) {
      let w: Float64Array;
      if (kind === 'hann') w = hannWindow(len);
      else {
        w = new Float64Array(len);
        const r = Math.max(1, Math.min(Math.round(0.002 * this.sr), len >> 2));
        for (let i = 0; i < len; i++)
          w[i] =
            i < r ? 0.5 - 0.5 * Math.cos((Math.PI * i) / r) : 0.5 + 0.5 * Math.cos((Math.PI * (i - r)) / (len - r));
      }
      let energy = 0;
      for (let i = 0; i < len; i++) energy += (w[i] as number) * (w[i] as number);
      entry = { w, energy: Math.max(energy, 1e-12) };
      this.windows.set(key, entry);
    }
    return entry;
  }

  /** Adds the power spectrum of x[start, start + len) under `kind`, normalized to mean power, into `bands`. */
  private bandPower(start: number, len: number, kind: 'attack' | 'hann', bands: Float64Array): void {
    const { w, energy } = this.window(kind, len);
    magnitudeSpectrum(this.featureFft, this.x, start, w, this.power, true);
    bands.fill(0);
    const P = this.power;
    const bandOf = this.bandOf;
    for (let k = 1; k < P.length; k++) {
      const b = bandOf[k] as number;
      if (b >= 0) bands[b] = (bands[b] as number) + (P[k] as number) / energy;
    }
  }

  private features(onset: Onset, prev: number, end: number): VoiceFeatures {
    const sr = this.sr;
    const t0 = onset.time;
    const start = Math.round(t0 * sr);
    const len = Math.max(
      2,
      Math.min(Math.round(T.featureSec * sr), Math.round((end - t0) * sr), this.n - start, this.featureFft.size),
    );
    const E = this.bandEnergy;
    this.bandPower(start, len, 'attack', E);
    let raw = 0;
    for (let b = 0; b < E.length; b++) raw += E[b] as number;
    // Subtract the background just before the onset (noise, the previous sound's tail).
    if (!onset.split) {
      const preEnd = start - Math.round(0.003 * sr);
      const preStart = Math.max(0, start - Math.round(0.023 * sr), Math.round((prev + 0.01) * sr));
      if (preEnd - preStart >= Math.round(0.005 * sr)) {
        const bg = this.bandBackground;
        this.bandPower(preStart, preEnd - preStart, 'hann', bg);
        let left = 0;
        for (let b = 0; b < E.length; b++) left += Math.max(0, (E[b] as number) - (bg[b] as number));
        // Keep the raw spectrum if the event barely stands out of the background.
        if (left > 0.05 * raw)
          for (let b = 0; b < E.length; b++) E[b] = Math.max(0, (E[b] as number) - (bg[b] as number));
      }
    }
    let total = 0;
    let high = 0;
    let weighted = 0;
    for (let b = 0; b < E.length; b++) {
      const e = E[b] as number;
      total += e;
      weighted += e * (this.bandHz[b] as number);
      if (b >= this.highBand) high += e;
    }
    const x = this.x;
    let crossings = 0;
    const stop = Math.min(this.n, start + len);
    for (let i = Math.max(1, start + 1); i < stop; i++)
      if ((x[i - 1] as number) < 0 !== (x[i] as number) < 0) crossings++;
    return {
      centroid: total > 0 ? weighted / total : 0,
      lowRatio: total > 0 ? (E[0] as number) / total : 0,
      highRatio: total > 0 ? high / total : 0,
      zcr: (crossings * sr) / Math.max(1, stop - start),
      periodicity: this.periodicity(t0, end),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Pitch frames

  private frameAt(sec: number): number {
    return Math.min(this.frames - 1, Math.max(0, Math.round((sec * this.sr) / this.hop)));
  }

  private frameTime(i: number): number {
    return (i * this.hop) / this.sr;
  }

  /** Seconds between a pitch frame's center and the start of the audio it reads. */
  private get lead(): number {
    return (this.yin.lead * this.decim) / this.sr;
  }

  private ensurePitch(from: number, to: number): void {
    const yin = this.yin;
    this.xd ??= decimate(this.x, this.decim, this.sr);
    const xd = this.xd;
    const step = this.hop / this.decim;
    for (let i = Math.max(0, from); i <= Math.min(this.frames - 1, to); i++) {
      if (this.done[i]) continue;
      yin.estimate(xd, i * step - yin.lead, 1e-12);
      this.f0[i] = yin.f0;
      this.aper[i] = yin.aperiodicity;
      this.frameDb[i] = 10 * Math.log10(Math.max(yin.energy, 1e-24));
      this.done[i] = 1;
    }
  }

  /** Median YIN periodicity of the frames whose audio starts within the first 35 ms. */
  private periodicity(t0: number, end: number): number {
    const span = (this.yin.span * this.decim) / this.sr;
    const from = this.frameAt(t0 + this.lead);
    const to = Math.max(from, this.frameAt(t0 + this.lead + Math.min(0.035, Math.max(0, end - t0 - span))));
    this.ensurePitch(from, to);
    const vals: number[] = [];
    for (let i = from; i <= to; i++) vals.push(1 - (this.aper[i] as number));
    return Math.max(0, Math.min(1, median(vals)));
  }

  /** MIDI pitch of the frames inside [t0, end): NaN unless confident and within range of the peak. */
  private pitchFrames(t0: number, end: number, peak: number): { from: number; midi: Float64Array } {
    const from = this.frameAt(t0 + this.lead);
    const to = Math.max(from, this.frameAt(end - 0.015));
    this.ensurePitch(from, to);
    const floorDb = ampToDb(peak) - T.pitchRangeDb;
    const midi = new Float64Array(to - from + 1);
    for (let i = from; i <= to; i++) {
      const ok =
        (this.f0[i] as number) > 0 &&
        1 - (this.aper[i] as number) >= T.pitchConfidence &&
        (this.frameDb[i] as number) >= floorDb;
      midi[i - from] = ok ? hzToMidi(this.f0[i] as number) : NaN;
    }
    return { from, midi };
  }

  // ---------------------------------------------------------------------------------------------
  // Classification

  private classify(m: Measured): void {
    const f = m.features;
    const drums = drumScores(f, m.duration);
    if (this.mode === 'drums') {
      m.kind = drums.kind;
      m.confidence = drums.confidence;
      return;
    }
    // Periodicity and sustain first: only then is the pitch track over the sustain worth computing.
    const pP = sigmoid((f.periodicity - T.tonalPeriodicity) / 0.04);
    const pS = sigmoid((m.sustainSec - T.tonalSustainSec) / 0.02);
    // YIN runs below 4 kHz: a sound that lives above it (a hat over a kick's tail) can't be judged by it.
    const pH = sigmoid((T.tonalMaxHighRatio - f.highRatio) / 0.08);
    let pV = 0;
    let pSweep = 1;
    if (this.mode === 'tonal' || (pP > 0.1 && pS > 0.1 && pH > 0.1)) {
      const t0 = m.onset.time;
      const { midi } = this.pitchFrames(t0, Math.min(m.end, t0 + Math.max(m.sustainSec, 0.03), t0 + 0.4), m.peak);
      let voiced = 0;
      for (let i = 0; i < midi.length; i++) if (!Number.isNaN(midi[i] as number)) voiced++;
      pV = sigmoid((voiced / Math.max(1, midi.length) - T.tonalVoicedRatio) / 0.08);
      // A kick's pitch falls fast (a clipped kick also sustains, so this is what tells it from a hum).
      const at = (a: number, b: number) => median(Array.from(midi.subarray(a, b)).filter((v) => !Number.isNaN(v)));
      const early = at(0, 4);
      const late = at(12, 17);
      if (Number.isFinite(early) && Number.isFinite(late))
        pSweep = sigmoid((T.tonalMaxSweepSemitones - Math.abs(late - early)) / 0.5);
    }
    const tonal = Math.min(pP, pS, pH, pV, pSweep);
    if (this.mode === 'tonal' || tonal >= 0.5) {
      m.kind = 'tonal';
      m.confidence = tonal;
    } else {
      m.kind = drums.kind;
      m.confidence = drums.confidence * (1 - tonal);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Tonal post-processing

  /** Drops onsets inside a still-sustained tonal event that don't come with a real level rise. */
  private mergeLegato(events: Measured[]): Measured[] {
    const out: Measured[] = [];
    for (const e of events) {
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.kind === 'tonal' &&
        e.onset.fullRiseDb < T.legatoRiseDb &&
        (e.kind === 'tonal' || e.features.periodicity >= 0.6) &&
        prev.sustainSec >= prev.end - prev.onset.time - 0.02
      ) {
        out[out.length - 1] = this.measure(prev.onset, prev.prev, e.end);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  /** Splits tonal events at legato note changes. */
  private splitByPitch(events: Measured[]): Measured[] {
    const out: Measured[] = [];
    for (const e of events) {
      const cuts = e.kind === 'tonal' ? this.noteChanges(e) : [];
      if (cuts.length === 0) {
        out.push(e);
        continue;
      }
      let onset = e.onset;
      let prev = e.prev;
      for (const end of [...cuts, e.end]) {
        const piece = this.measure(onset, prev, end);
        piece.kind = 'tonal';
        piece.confidence = e.confidence;
        out.push(piece);
        prev = onset.time;
        onset = { time: end, flux: 0, riseDb: 0, fullRiseDb: 0, split: true };
      }
    }
    return out;
  }

  /**
   * Note changes inside a tonal event (s). Stable regions = runs of ≥ 60 ms where the smoothed pitch
   * stays put; neighbouring regions more than 1.5 semitones apart are different notes. The cut is
   * where the pitch crosses the midpoint for quick changes (YIN smears both ways), or where it
   * arrives for long glides (so the first note carries the slide).
   */
  private noteChanges(e: Measured): number[] {
    const { from, midi } = this.pitchFrames(e.onset.time, e.end, e.peak);
    const F = midi.length;
    const hold = Math.max(3, Math.round(T.splitHoldSec / HOP_SEC));
    if (F < 2 * hold) return [];
    const sm = new Float64Array(F);
    for (let i = 0; i < F; i++) {
      const vals: number[] = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(F - 1, i + 2); j++)
        if (!Number.isNaN(midi[j] as number)) vals.push(midi[j] as number);
      sm[i] = vals.length >= 3 ? median(vals) : NaN;
    }
    const valid = (a: number, b: number) => Array.from(sm.subarray(a, b)).filter((v) => !Number.isNaN(v));
    const stableAt = (i: number): number => {
      const vals = valid(i, i + hold);
      if (vals.length < 0.8 * hold) return NaN;
      const m = median(vals);
      if (vals.some((v) => Math.abs(v - m) > T.stableSemitones)) return NaN;
      const half = hold >> 1;
      if (Math.abs(median(valid(i + hold - half, i + hold)) - median(valid(i, i + half))) > T.stableDrift) return NaN;
      return m;
    };
    const regions: { start: number; end: number; pitch: number }[] = [];
    for (let i = 0; i + hold <= F;) {
      const m = stableAt(i);
      if (Number.isNaN(m)) {
        i++;
        continue;
      }
      let end = i + hold;
      let misses = 0;
      while (end < F) {
        const v = sm[end] as number;
        if (!Number.isNaN(v) && Math.abs(v - m) <= T.stableSemitones + 0.25) misses = 0;
        else if (Number.isNaN(v) && misses < 4) misses++;
        else break;
        end++;
      }
      end -= misses;
      regions.push({ start: i, end, pitch: m });
      i = end;
    }
    // Neighbours only: a slow glide is a chain of close regions and stays one note.
    const cuts: number[] = [];
    for (let r = 1; r < regions.length; r++) {
      const a = regions[r - 1] as { start: number; end: number; pitch: number };
      const b = regions[r] as { start: number; end: number; pitch: number };
      if (Math.abs(b.pitch - a.pitch) <= T.splitSemitones) continue;
      let cut = b.start;
      if (b.start - a.end <= Math.round(0.08 / HOP_SEC)) {
        const mid = (a.pitch + b.pitch) / 2;
        const up = b.pitch > a.pitch;
        for (let j = Math.max(0, a.end - 2); j <= b.start; j++) {
          const v = sm[j] as number;
          if (!Number.isNaN(v) && (up ? v >= mid : v <= mid)) {
            cut = j;
            break;
          }
        }
      }
      cuts.push(this.frameTime(from + cut));
    }
    const out: number[] = [];
    for (const c of cuts) {
      const last = out.length > 0 ? (out[out.length - 1] as number) : e.onset.time;
      if (c - last >= T.splitHoldSec && e.end - c >= T.splitHoldSec) out.push(c);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Output

  private finish(events: Measured[]): VoiceEvent[] {
    let loudest = 0;
    for (const e of events) loudest = Math.max(loudest, e.peak);
    return events.map((e) => {
      let pitch: number | null = null;
      let pitchEnd: number | null = null;
      if (e.kind === 'tonal') {
        const { midi } = this.pitchFrames(e.onset.time, e.end, e.peak);
        const valid = Array.from(midi).filter((v) => !Number.isNaN(v));
        if (valid.length >= 3) {
          pitch = median(valid);
          const tail = Math.max(3, Math.min(Math.round(T.splitHoldSec / HOP_SEC), Math.ceil(valid.length / 4)));
          pitchEnd = median(valid.slice(-tail));
        }
      }
      return {
        time: e.onset.time,
        duration: e.duration,
        strength: loudest > 0 ? e.peak / loudest : 0,
        kind: e.kind,
        confidence: Math.max(0, Math.min(1, e.confidence)),
        pitch,
        pitchEnd,
        features: e.features,
      };
    });
  }
}

/** Kick / snare / hat from soft scores; confidence = the winner's share of the three scores. */
function drumScores(f: VoiceFeatures, duration: number): { kind: 'kick' | 'snare' | 'hat'; confidence: number } {
  const logC = Math.log2(Math.max(f.centroid, 1));
  const kick = Math.max(
    sigmoid((f.lowRatio - T.kickLowRatio) / 0.08),
    sigmoid((Math.log2(T.kickCentroidHz) - logC) / 0.4),
  );
  const hat =
    (2 * sigmoid((f.highRatio - T.hatHighRatio) / 0.1) +
      2 * sigmoid((logC - Math.log2(T.hatCentroidHz)) / 0.35) +
      sigmoid((T.hatMaxSec - duration) / 0.04)) /
    5;
  const snare = 1 - Math.max(kick, hat);
  const sum = kick + hat + snare;
  if (kick >= hat && kick >= snare) return { kind: 'kick', confidence: kick / sum };
  if (hat >= snare) return { kind: 'hat', confidence: hat / sum };
  return { kind: 'snare', confidence: snare / sum };
}
