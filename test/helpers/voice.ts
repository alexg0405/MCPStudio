/**
 * A synthetic singing voice for pitch-correction tests: harmonics whose amplitudes follow a fixed
 * spectral envelope (formants), so the envelope is known and does not depend on the pitch. Notes
 * can glide, drift and have vibrato; measuring helpers read pitch and the formant peak back.
 */

export interface SungNote {
  /** Seconds. */
  from: number;
  to: number;
  /** MIDI note (fractional) at time `t` seconds into the note. */
  midi: number | ((t: number) => number);
  /** Linear level (default 0.3). */
  level?: number;
}

export interface Formant {
  hz: number;
  /** −3 dB width, Hz. */
  bandwidth: number;
  gain: number;
}

export const DEFAULT_FORMANTS: readonly Formant[] = [
  { hz: 900, bandwidth: 260, gain: 1 },
  { hz: 2400, bandwidth: 500, gain: 0.35 },
];

/** The spectral envelope at a frequency (linear). */
export function envelopeAt(hz: number, formants: readonly Formant[] = DEFAULT_FORMANTS): number {
  let a = 0.01;
  for (const f of formants) a += f.gain / (1 + ((hz - f.hz) / (f.bandwidth / 2)) ** 2);
  return a;
}

/** Sung notes as audio: an exact additive voice (each harmonic scaled by the envelope at its frequency). */
export function sing(
  notes: readonly SungNote[],
  sampleRate: number,
  seconds: number,
  formants: readonly Formant[] = DEFAULT_FORMANTS,
): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const ramp = Math.round(0.012 * sampleRate);
  for (const note of notes) {
    const a = Math.max(0, Math.round(note.from * sampleRate));
    const b = Math.min(n, Math.round(note.to * sampleRate));
    const level = note.level ?? 0.3;
    let phase = 0;
    for (let i = a; i < b; i++) {
      const t = (i - a) / sampleRate;
      const midi = typeof note.midi === 'number' ? note.midi : note.midi(t);
      const f0 = 440 * Math.pow(2, (midi - 69) / 12);
      phase += (2 * Math.PI * f0) / sampleRate;
      let v = 0;
      for (let k = 1; k * f0 < 0.45 * sampleRate && k < 90; k++) v += (envelopeAt(k * f0, formants) / k) * Math.cos(k * phase);
      const fade = Math.min(1, (i - a) / ramp, (b - 1 - i) / ramp);
      out[i] = (out[i] as number) + level * 0.5 * v * Math.max(0, fade);
    }
  }
  return out;
}

/** Amplitude of the component at `hz` over [from, to) (Hann-windowed single-frequency DFT). */
export function amplitudeAt(x: Float32Array, sampleRate: number, hz: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  let wsum = 0;
  const len = to - from;
  for (let i = from; i < to; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (len - 1));
    const ph = (2 * Math.PI * hz * i) / sampleRate;
    re += w * (x[i] as number) * Math.cos(ph);
    im -= w * (x[i] as number) * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

/** The frequency near `guess` (within ±`span` Hz) where the Hann-windowed spectrum peaks, to 0.002 Hz. */
export function peakFrequency(x: Float32Array, sampleRate: number, guess: number, from: number, to: number, span = 3): number {
  let lo = guess - span;
  let hi = guess + span;
  // Coarse scan, then narrowing.
  let best = guess;
  for (let pass = 0; pass < 4; pass++) {
    const steps = 12;
    const width = (hi - lo) / steps;
    let bestAmp = -1;
    for (let s = 0; s <= steps; s++) {
      const f = lo + s * width;
      const a = amplitudeAt(x, sampleRate, f, from, to);
      if (a > bestAmp) {
        bestAmp = a;
        best = f;
      }
    }
    lo = best - width;
    hi = best + width;
  }
  return best;
}

/** Cents from `ref` Hz to `hz`. */
export const centsBetween = (hz: number, ref: number): number => 1200 * Math.log2(hz / ref);

/**
 * The formant peak (Hz) of a voiced steady sound at fundamental `f0`: the harmonic amplitudes,
 * smoothed over three neighbours, and a parabola through the largest one (in log amplitude).
 */
export function formantPeak(x: Float32Array, sampleRate: number, f0: number, from: number, to: number): number {
  const amps: number[] = [];
  const freqs: number[] = [];
  for (let k = 1; k * f0 < 3000; k++) {
    const f = peakFrequency(x, sampleRate, k * f0, from, to, Math.max(0.5, 0.004 * k * f0));
    freqs.push(f);
    amps.push(amplitudeAt(x, sampleRate, f, from, to) * k);
  }
  let m = 0;
  for (let i = 1; i < amps.length; i++) if ((amps[i] as number) > (amps[m] as number)) m = i;
  if (m === 0 || m === amps.length - 1) return freqs[m] as number;
  const y0 = Math.log(amps[m - 1] as number);
  const y1 = Math.log(amps[m] as number);
  const y2 = Math.log(amps[m + 1] as number);
  const den = y0 - 2 * y1 + y2;
  const shift = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
  const f1 = freqs[m] as number;
  const spacing = f1 - (freqs[m - 1] as number);
  return f1 + shift * spacing;
}
