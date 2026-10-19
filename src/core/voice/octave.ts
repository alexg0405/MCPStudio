/**
 * Octave-error repair for the pitch editor's tracker. YIN follows the strongest periodicity: a voice whose
 * fundamental is much weaker than its second (or third) harmonic, typically a strong formant near 900 Hz over a
 * note at 440 Hz or above, can be read an octave (or an octave and a fifth) high for a whole note. The error is
 * the same for every frame of the note, so the track's neighbours in time cannot fix it; the spectrum can: if the
 * sound really has a lower fundamental g = f / c, its spectrum has narrow lines at g's own multiples that f's comb
 * does not contain (at f / 2 and 3f / 2 for c = 2), far above the floor between the lines; a sound truly at f has
 * nothing there. Pure, no DOM.
 *
 * The test runs on short windows along the track (58 ms, or 116 ms when the lowest candidate is under ~175 Hz),
 * every 29 ms, not once per note: a note read an octave high can join the true note above it into one long note,
 * and only a spectrum from that moment tells the two apart. A window's answer needs a neighbouring window to agree.
 */
import { RealFFT, hannWindow, magnitudeSpectrum } from './fft';
import { decimate } from './filters';

/** The divisors tried, lowest candidate fundamental first: f / 3, f / 2, f / 1.5. */
export const OCTAVE_DIVISORS: readonly number[] = [3, 2, 1.5];

/**
 * The numbers that decide whether the spectrum shows a lower fundamental under a tracked pitch; each field says what it
 * limits.
 */
export const OCTAVE_THRESHOLDS = {
  /** Each line at a new multiple must stand at least this far (amplitude ratio) above the floor between the lines… */
  lineOverFloor: [4, 4] as const,
  /** …and together (geometric mean of the two) this far above their floors: one very strong line may carry a modest one. */
  meanOverFloor: 11,
  /** …and be at least this much of the spectrum's strongest peak, for the first and the second new multiple. */
  minShare: [0.07, 0.035] as const,
  /** The lowest fundamental a repair may land on, Hz. */
  minHz: 80,
  /** Search for a line within this share of its frequency (vibrato and drift), plus a bin. */
  lineTolerance: 0.03,
  /** Windows start every this many samples of the analysis rate (≈ 29 ms). */
  step: 256,
  /** A frame follows its step's answer when it is within this many octaves of the pitch that was judged (≈ 150 cents). */
  sameNoteOctaves: 0.125,
  /** Voiced frames a step needs to be judged. */
  minFrames: 3,
  /** A candidate fundamental at or above this (Hz) can use the short window. */
  shortWindowFromHz: 175,
};

/** Which multiples of the candidate fundamental g are new (not in the comb of f) for each divisor. */
const NEW_MULTIPLES: Readonly<Record<number, readonly [number, number]>> = {
  3: [1, 2],
  2: [1, 3],
  1.5: [1, 2],
};

/** The rate the spectra are taken at (voice fundamentals and their first harmonics sit well under 4 kHz). */
const ANALYSIS_RATE = 8800;

/** The audio of a repair: decimated once, spectra taken from it. */
export class OctaveProbe {
  readonly rate: number;
  private readonly x: Float32Array;
  private readonly kits = new Map<number, { fft: RealFFT; window: Float64Array; mag: Float64Array }>();

  constructor(mono: Float32Array, sampleRate: number) {
    const k = Math.max(1, Math.floor(sampleRate / ANALYSIS_RATE));
    this.x = decimate(mono, k, sampleRate);
    this.rate = sampleRate / k;
  }

  /** The magnitude spectrum of the `size`-sample window centred `centre` samples (of the analysis rate) in. The array is reused. */
  spectrum(centre: number, size: 512 | 1024): { mag: Float64Array; binHz: number } {
    let kit = this.kits.get(size);
    if (!kit) {
      const fft = new RealFFT(size);
      kit = { fft, window: hannWindow(size), mag: new Float64Array(fft.bins) };
      this.kits.set(size, kit);
    }
    magnitudeSpectrum(kit.fft, this.x, Math.round(centre - size / 2), kit.window, kit.mag);
    return { mag: kit.mag, binHz: this.rate / size };
  }
}

/** The strongest line within the tolerance around `hz`. */
function lineAt(mag: Float64Array, binHz: number, hz: number): number {
  const tol = OCTAVE_THRESHOLDS.lineTolerance;
  const lo = Math.max(1, Math.floor((hz * (1 - tol)) / binHz) - 1);
  const hi = Math.min(mag.length - 2, Math.ceil((hz * (1 + tol)) / binHz) + 1);
  let best = 0;
  for (let k = lo; k <= hi; k++) if ((mag[k] as number) > best) best = mag[k] as number;
  return best;
}

/** The floor around `hz`: the lower quartile of the magnitudes within ±0.45 g, leaving the line's own bins out. */
function floorAround(mag: Float64Array, binHz: number, hz: number, g: number, scratch: number[]): number {
  const lo = Math.max(1, Math.floor((hz - 0.45 * g) / binHz));
  const hi = Math.min(mag.length - 2, Math.ceil((hz + 0.45 * g) / binHz));
  const centre = hz / binHz;
  scratch.length = 0;
  for (let k = lo; k <= hi; k++) if (Math.abs(k - centre) > 2.5) scratch.push(mag[k] as number);
  if (scratch.length < 4) return Number.POSITIVE_INFINITY;
  scratch.sort((p, q) => p - q);
  return scratch[Math.floor(0.25 * (scratch.length - 1))] as number;
}

/** What the spectrum shows at the two new multiples of the candidate fundamental `hz / divisor` (null when it cannot be judged). */
export interface SubharmonicEvidence {
  /** Each line's share of the spectrum's strongest peak. */
  share: [number, number];
  /** Each line over the floor around it (amplitude ratio). */
  overFloor: [number, number];
}

/**
 * Measures the spectrum at the two new multiples of a candidate fundamental `hz / divisor`: how strong each line is and
 * how far it stands above its floor. Null when the candidate is too low, too narrow to resolve or the spectrum is
 * silent.
 */
export function subharmonicEvidence(
  mag: Float64Array,
  binHz: number,
  hz: number,
  divisor: number,
): SubharmonicEvidence | null {
  const T = OCTAVE_THRESHOLDS;
  const g = hz / divisor;
  if (g < T.minHz) return null;
  const multiples = NEW_MULTIPLES[divisor];
  if (!multiples) return null;
  const top = Math.min(mag.length - 1, Math.floor(4000 / binHz));
  let max = 0;
  for (let k = 1; k <= top; k++) if ((mag[k] as number) > max) max = mag[k] as number;
  if (!(max > 0)) return null;
  const scratch: number[] = [];
  const share: [number, number] = [0, 0];
  const overFloor: [number, number] = [0, 0];
  for (let m = 0; m < multiples.length; m++) {
    const at = (multiples[m] as number) * g;
    // The line has to be resolved from its neighbours: g several bins wide, and below the top of the spectrum.
    if (at * (1 + T.lineTolerance) >= (mag.length - 2) * binHz || g < 6 * binHz) return null;
    const line = lineAt(mag, binHz, at);
    share[m] = line / max;
    const floor = floorAround(mag, binHz, at, g, scratch);
    overFloor[m] = floor > 0 ? line / floor : Number.POSITIVE_INFINITY;
  }
  return { share, overFloor };
}

/**
 * True when the spectrum of a sound the tracker put at `hz` shows the lines of a fundamental `hz / divisor`: at
 * both of the multiples of that fundamental that `hz`'s own comb lacks, a line well above the floor around it and a
 * real share of the strongest peak.
 */
export function hasSubharmonic(mag: Float64Array, binHz: number, hz: number, divisor: number): boolean {
  const T = OCTAVE_THRESHOLDS;
  const e = subharmonicEvidence(mag, binHz, hz, divisor);
  if (!e) return false;
  return (
    e.share[0] >= T.minShare[0] &&
    e.share[1] >= T.minShare[1] &&
    e.overFloor[0] >= T.lineOverFloor[0] &&
    e.overFloor[1] >= T.lineOverFloor[1] &&
    Math.sqrt(e.overFloor[0] * e.overFloor[1]) >= T.meanOverFloor
  );
}

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? (values[m] as number) : 0.5 * ((values[m - 1] as number) + (values[m] as number));
}

/** The frames within half a step of window `p`'s centre (a and b inclusive; b < a when none). */
function framesOfStep(p: number, stepSec: number, frameSec: number, n: number): { a: number; b: number } {
  const a = Math.max(0, Math.ceil(((p - 0.5) * stepSec) / frameSec));
  const b = Math.min(n - 1, Math.floor(((p + 0.5) * stepSec) / frameSec - 1e-9));
  return { a, b };
}

/** The window size (samples at the analysis rate) for a step at `hz`: the short one when the lowest candidate is high enough. */
const windowSizeFor = (hz: number): 512 | 1024 => (hz / 3 >= OCTAVE_THRESHOLDS.shortWindowFromHz ? 512 : 1024);

/** What each step of the track was judged to be: its median pitch and the divisor its sound calls for (0 = not judged, 1 = no repair). */
function judgeSteps(
  probe: OctaveProbe,
  f0: Float32Array,
  steps: number,
  stepSec: number,
  frameSec: number,
): { divisor: Float32Array; stepHz: Float32Array } {
  const T = OCTAVE_THRESHOLDS;
  const n = f0.length;
  const divisor = new Float32Array(steps).fill(0); // 0 = not judged
  const stepHz = new Float32Array(steps);
  const values: number[] = [];
  for (let p = 0; p < steps; p++) {
    const { a, b } = framesOfStep(p, stepSec, frameSec, n);
    values.length = 0;
    for (let i = a; i <= b; i++) if ((f0[i] as number) > 0) values.push(f0[i] as number);
    if (values.length < T.minFrames) continue;
    const hz = medianOf(values);
    stepHz[p] = hz;
    if (hz < 2 * T.minHz) {
      divisor[p] = 1;
      continue;
    }
    const { mag, binHz } = probe.spectrum(p * T.step, windowSizeFor(hz));
    let d = 1;
    for (const c of OCTAVE_DIVISORS) {
      if (hasSubharmonic(mag, binHz, hz, c)) {
        d = c;
        break;
      }
    }
    divisor[p] = d;
  }
  return { divisor, stepHz };
}

/**
 * Moves the voiced frames of `f0` (Hz, one per `hopSamples` samples of `mono`, frame i centred at i × hop) down by
 * the divisor their sound calls for (in place), where the spectrum shows a lower fundamental's lines. Returns how
 * many frames moved.
 */
export function repairOctaveSlips(
  mono: Float32Array,
  sampleRate: number,
  f0: Float32Array,
  hopSamples: number,
): number {
  const T = OCTAVE_THRESHOLDS;
  const n = f0.length;
  // Anything high enough to hide a lower fundamental?
  let any = false;
  for (let i = 0; i < n && !any; i++) any = (f0[i] as number) >= 2 * T.minHz;
  if (!any) return 0;
  const probe = new OctaveProbe(mono, sampleRate);
  const frameSec = hopSamples / sampleRate;
  const stepSec = T.step / probe.rate;
  const steps = Math.floor((n * frameSec) / stepSec) + 1;
  const { divisor, stepHz } = judgeSteps(probe, f0, steps, stepSec, frameSec);
  // A step's answer stands when a neighbouring step agrees (or none was judged next to it): one odd window is noise.
  let moved = 0;
  for (let p = 0; p < steps; p++) {
    const d = divisor[p] as number;
    if (d <= 1) continue;
    const left = p > 0 ? (divisor[p - 1] as number) : 0;
    const right = p + 1 < steps ? (divisor[p + 1] as number) : 0;
    if (!(left === d || right === d || (left === 0 && right === 0))) continue;
    const { a, b } = framesOfStep(p, stepSec, frameSec, n);
    const hz = stepHz[p] as number;
    for (let i = a; i <= b; i++) {
      // Only frames at the pitch that was judged: a step that straddles a note change moves the frames it heard.
      const v = f0[i] as number;
      if (v > 0 && Math.abs(Math.log2(v / hz)) < T.sameNoteOctaves) {
        f0[i] = v / d;
        moved++;
      }
    }
  }
  return moved;
}
