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
  let svfType: SvfType;
  let order: 1 | 2 | 4 = 1;
  let isSingleSection = true;
  switch (type) {
    case 'bell':
      svfType = 'bell';
      break;
    case 'lowShelf':
      svfType = 'lowshelf';
      break;
    case 'highShelf':
      svfType = 'highshelf';
      break;
    case 'notch':
      svfType = 'notch';
      break;
    default:
      isSingleSection = false;
      svfType = type.startsWith('low') ? 'highpass' : 'lowpass';
      order = type.endsWith('48') ? 4 : type.endsWith('24') ? 2 : 1;
  }
  if (isSingleSection) {
    const section = out[0] as Section;
    section.type = svfType;
    section.q = q;
    return 1;
  }
  const sectionQs = BUTTERWORTH[order];
  for (let i = 0; i < order; i++) {
    const s = out[i] as Section;
    s.type = svfType;
    s.q = i === order - 1 ? (sectionQs[i] as number) * (q / Math.SQRT1_2) : (sectionQs[i] as number);
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
function sectionPower(type: SvfType, q: number, gainDb: number, normalisedFrequency: number): number {
  const wSquared = normalisedFrequency * normalisedFrequency;
  const damping = 1 / Math.max(q, 1e-3);
  // |a·s² + b·s + c|² at s = jw is (c − a·w²)² + (b·w)².
  const polynomialPower = (a: number, b: number, c: number) =>
    (c - a * wSquared) * (c - a * wSquared) + b * b * wSquared;
  switch (type) {
    case 'lowpass':
      return 1 / polynomialPower(1, damping, 1);
    case 'highpass':
      return (wSquared * wSquared) / polynomialPower(1, damping, 1);
    case 'notch':
      return polynomialPower(1, 0, 1) / polynomialPower(1, damping, 1);
    case 'bell': {
      const amplitude = Math.pow(10, gainDb / 40);
      return polynomialPower(1, damping * amplitude, 1) / polynomialPower(1, damping / amplitude, 1);
    }
    case 'lowshelf': {
      const amplitude = Math.pow(10, gainDb / 40);
      const sqrtAmplitude = Math.sqrt(amplitude);
      return (
        (amplitude * amplitude * polynomialPower(1, damping * sqrtAmplitude, amplitude)) /
        polynomialPower(amplitude, damping * sqrtAmplitude, 1)
      );
    }
    case 'highshelf': {
      const amplitude = Math.pow(10, gainDb / 40);
      const sqrtAmplitude = Math.sqrt(amplitude);
      return (
        (amplitude * amplitude * polynomialPower(amplitude, damping * sqrtAmplitude, 1)) /
        polynomialPower(1, damping * sqrtAmplitude, amplitude)
      );
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
  centreHz: number,
  gainDb: number,
  q: number,
  freq: number,
  sampleRate: number,
  sections: Section[],
): number {
  const clampedCentreHz = clampFreq(centreHz, sampleRate);
  const probeHz = Math.min(freq, sampleRate * 0.4999);
  const normalisedFrequency =
    Math.tan((Math.PI * probeHz) / sampleRate) / Math.tan((Math.PI * clampedCentreHz) / sampleRate);
  const count = bandSections(type, q, sections);
  let power = 1;
  for (let i = 0; i < count; i++) {
    const section = sections[i] as Section;
    power *= sectionPower(section.type, section.q, gainDb, normalisedFrequency);
  }
  return power > 0 ? 10 * Math.log10(power) : -300;
}
