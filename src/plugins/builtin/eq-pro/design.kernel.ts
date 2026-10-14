// EQ Pro band design, shared by the kernel (which runs it) and the editor (which draws it). Every
// section is an SDK Svf: a bilinear transform, prewarped at its frequency, of an analog prototype,
// so the digital response at f is the prototype's at Ω = tan(π·f/fs) / tan(π·f0/fs). The editor's
// curve uses exactly that, so it shows what the kernel does. Pure: no DOM, no allocation per call.
import type { SvfType } from '@agstudio/sdk/worklet';

export const BAND_TYPES = [
  'bell',
  'lowShelf',
  'highShelf',
  'lowCut12',
  'lowCut24',
  'lowCut48',
  'highCut12',
  'highCut24',
  'highCut48',
  'notch',
] as const;
export type BandType = (typeof BAND_TYPES)[number];

/** Types whose gain matters (cuts and notches only have a frequency and a Q). */
export function hasGain(type: BandType): boolean {
  return type === 'bell' || type === 'lowShelf' || type === 'highShelf';
}

/** At most this many 2nd-order sections per band (a 48 dB/octave cut). */
export const MAX_SECTIONS = 4;

/** Q of each section of a Butterworth filter of order 2, 4 and 8. */
const BUTTERWORTH: Readonly<Record<1 | 2 | 4, readonly number[]>> = {
  1: [Math.SQRT1_2],
  2: [0.5411961, 1.306563],
  4: [0.5097956, 0.6013449, 0.8999762, 2.5629154],
};

/** One section: an Svf type with its settings. */
export interface Section {
  type: SvfType;
  q: number;
}

/**
 * The sections of a band, written into `out` (reused); returns how many. For cuts the Q shapes the
 * corner like a resonance: the default 0.71 is a plain Butterworth slope, higher Q peaks at the
 * frequency (it scales the sharpest section).
 */
export function bandSections(type: BandType, q: number, out: Section[]): number {
  let svf: SvfType;
  let order: 1 | 2 | 4 = 1;
  let single = true;
  switch (type) {
    case 'bell':
      svf = 'bell';
      break;
    case 'lowShelf':
      svf = 'lowshelf';
      break;
    case 'highShelf':
      svf = 'highshelf';
      break;
    case 'notch':
      svf = 'notch';
      break;
    default:
      single = false;
      svf = type.startsWith('low') ? 'highpass' : 'lowpass';
      order = type.endsWith('48') ? 4 : type.endsWith('24') ? 2 : 1;
  }
  if (single) {
    const s = out[0] as Section;
    s.type = svf;
    s.q = q;
    return 1;
  }
  const qs = BUTTERWORTH[order];
  for (let i = 0; i < order; i++) {
    const s = out[i] as Section;
    s.type = svf;
    s.q = i === order - 1 ? (qs[i] as number) * (q / Math.SQRT1_2) : (qs[i] as number);
  }
  return order;
}

/** A list of sections to design into (no allocation in loops). */
export function sectionBuffer(): Section[] {
  return Array.from({ length: MAX_SECTIONS }, () => ({ type: 'bell' as SvfType, q: 1 }));
}

/** The frequency an Svf actually uses (it clamps below Nyquist). */
export function clampFreq(freq: number, sampleRate: number): number {
  return Math.min(Math.max(freq, 1), sampleRate * 0.49);
}

/** |H|² of one analog prototype section at normalized frequency w (s = jw). */
function sectionPower(type: SvfType, q: number, gainDb: number, w: number): number {
  const w2 = w * w;
  const k = 1 / Math.max(q, 1e-3);
  // |a·s² + b·s + c|² at s = jw is (c − a·w²)² + (b·w)².
  const mag = (a: number, b: number, c: number) => (c - a * w2) * (c - a * w2) + b * b * w2;
  switch (type) {
    case 'lowpass':
      return 1 / mag(1, k, 1);
    case 'highpass':
      return (w2 * w2) / mag(1, k, 1);
    case 'notch':
      return mag(1, 0, 1) / mag(1, k, 1);
    case 'bell': {
      const A = Math.pow(10, gainDb / 40);
      return mag(1, k * A, 1) / mag(1, k / A, 1);
    }
    case 'lowshelf': {
      const A = Math.pow(10, gainDb / 40);
      const sa = Math.sqrt(A);
      return (A * A * mag(1, k * sa, A)) / mag(A, k * sa, 1);
    }
    case 'highshelf': {
      const A = Math.pow(10, gainDb / 40);
      const sa = Math.sqrt(A);
      return (A * A * mag(A, k * sa, 1)) / mag(1, k * sa, A);
    }
    default:
      return 1;
  }
}

/**
 * A band's response in dB at `freq` (what the kernel does at that frequency), for a sample rate.
 * `sections` is scratch space from `sectionBuffer()`.
 */
export function bandResponseDb(
  type: BandType,
  f0: number,
  gainDb: number,
  q: number,
  freq: number,
  sampleRate: number,
  sections: Section[],
): number {
  const fc = clampFreq(f0, sampleRate);
  const f = Math.min(freq, sampleRate * 0.4999);
  const w = Math.tan((Math.PI * f) / sampleRate) / Math.tan((Math.PI * fc) / sampleRate);
  const count = bandSections(type, q, sections);
  let power = 1;
  for (let i = 0; i < count; i++) {
    const s = sections[i] as Section;
    power *= sectionPower(s.type, s.q, gainDb, w);
  }
  return power > 0 ? 10 * Math.log10(power) : -300;
}
