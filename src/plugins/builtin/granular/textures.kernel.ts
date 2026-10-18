// The built-in sounds the Granular instrument plays while no sample is loaded: five short stereo textures made by
// additive synthesis, so it makes sound out of the box. Pure maths with no DOM; the main thread builds a texture once
// per page when it is first needed and hands it to the kernels (building takes ~30 ms: not for the audio thread).
import { Noise, Svf } from '@agstudio/sdk/worklet';

/** Sample rate the textures are made at; the kernel resamples them to the context's rate. */
export const TEXTURE_RATE = 32000;
const SECONDS = 4;
const FRAMES = TEXTURE_RATE * SECONDS;
/** Peak level of every texture (leaves room for the grains to add up). */
const PEAK = 0.8;

/** A sine oscillator that costs a few multiplies per sample (a rotating phasor: no trigonometry in the loop). */
class Phasor {
  private cos = 1;
  private sin = 0;
  private readonly stepCos: number;
  private readonly stepSin: number;

  constructor(hz: number, startPhase = 0) {
    const w = (2 * Math.PI * hz) / TEXTURE_RATE;
    this.stepCos = Math.cos(w);
    this.stepSin = Math.sin(w);
    this.cos = Math.cos(startPhase);
    this.sin = Math.sin(startPhase);
  }

  next(): number {
    const out = this.sin;
    const c = this.cos * this.stepCos - this.sin * this.stepSin;
    this.sin = this.sin * this.stepCos + this.cos * this.stepSin;
    this.cos = c;
    return out;
  }
}

/** Scales a texture's channels together so the loudest sample is `PEAK`. */
function normalize(channels: Float32Array[]): Float32Array[] {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i] as number));
  const gain = peak > 0 ? PEAK / peak : 1;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] = (c[i] as number) * gain;
  return channels;
}

const gaussian = (x: number, centre: number, width: number) => Math.exp(-(((x - centre) / width) ** 2));

/** Formants (Hz) of a sung "ah" and "oh": the chord slowly moves from one vowel to the other and back. */
const AH = [700, 1100, 2500] as const;
const OH = [450, 800, 2500] as const;

/** Strength of a partial at `hz` under a vowel's three formants. */
function vowelStrength(hz: number, vowel: readonly number[]): number {
  return 0.04 + gaussian(hz, vowel[0] as number, 110) + 0.6 * gaussian(hz, vowel[1] as number, 150) + 0.3 * gaussian(hz, vowel[2] as number, 250);
}

/** A sung chord (A2, E3, A3, C#4): partials shaped by two vowels that crossfade over the loop, two detuned copies per side. */
function choir(): Float32Array[] {
  const notes = [110, 164.81, 220, 277.18];
  const channels = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
  const PARTIALS = 14;
  channels.forEach((out, side) => {
    const phasors: Phasor[] = [];
    const ah: number[] = [];
    const oh: number[] = [];
    notes.forEach((note, n) => {
      // Detune a few cents per voice and per side so the two channels differ: a wide chorus.
      const hz = note * Math.pow(2, ((side === 0 ? -1 : 1) * (3 + n)) / 1200);
      for (let k = 1; k <= PARTIALS; k++) {
        phasors.push(new Phasor(hz * k, k * 0.7 + n));
        ah.push(vowelStrength(hz * k, AH) / Math.sqrt(k));
        oh.push(vowelStrength(hz * k, OH) / Math.sqrt(k));
      }
    });
    for (let i = 0; i < FRAMES; i++) {
      const blend = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAMES);
      let sum = 0;
      for (let j = 0; j < phasors.length; j++) sum += (phasors[j] as Phasor).next() * ((ah[j] as number) * (1 - blend) + (oh[j] as number) * blend);
      out[i] = sum;
    }
  });
  return normalize(channels);
}

/** Five bell strikes with inharmonic partials, each a different pitch, alternating sides: glassy and sparse. */
function glass(): Float32Array[] {
  const channels = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
  const PARTIAL_RATIOS = [1, 2.76, 5.4, 8.93, 13.34];
  const notes = [659.26, 880, 783.99, 987.77, 587.33];
  const gap = FRAMES / notes.length;
  notes.forEach((hz, n) => {
    const start = Math.floor(n * gap);
    const pan = n % 2 === 0 ? 0.25 : 0.75;
    PARTIAL_RATIOS.forEach((ratio, k) => {
      const phasor = new Phasor(hz * ratio, k);
      const decayPerSample = Math.exp(-1 / (TEXTURE_RATE * (1.6 / (1 + k * 0.8))));
      let level = 0.8 / (1 + k * 0.7);
      for (let i = start; i < FRAMES; i++) {
        const x = phasor.next() * level;
        (channels[0] as Float32Array)[i] = ((channels[0] as Float32Array)[i] as number) + x * (1 - pan);
        (channels[1] as Float32Array)[i] = ((channels[1] as Float32Array)[i] as number) + x * pan;
        level *= decayPerSample;
        if (level < 1e-5) break;
      }
    });
  });
  return normalize(channels);
}

/** A detuned saw ensemble on a D minor 9 chord with a slow low-pass sweep: warm, moving strings. */
function strings(): Float32Array[] {
  const notes = [73.42, 110, 146.83, 174.61, 220, 261.63];
  const channels = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
  const PARTIALS = 12;
  channels.forEach((out, side) => {
    const phasors: Phasor[] = [];
    const partialHz: number[] = [];
    notes.forEach((note, n) => {
      const hz = note * Math.pow(2, ((side === 0 ? -1 : 1) * (4 + 2 * n)) / 1200);
      for (let k = 1; k <= PARTIALS; k++) {
        phasors.push(new Phasor(hz * k, k + n));
        partialHz.push(hz * k);
      }
    });
    for (let i = 0; i < FRAMES; i++) {
      // The cutoff swings between 500 Hz and 3 kHz once over the loop.
      const cutoff = 1700 - 1200 * Math.cos((2 * Math.PI * i) / FRAMES);
      let sum = 0;
      for (let j = 0; j < phasors.length; j++) {
        const hz = partialHz[j] as number;
        sum += (phasors[j] as Phasor).next() / (1 + (hz / cutoff) ** 2) / (hz / 110);
      }
      out[i] = sum;
    }
  });
  return normalize(channels);
}

/** Noise through a band-pass whose centre wanders between 300 Hz and 3 kHz, a different noise on each side: airy wind. */
function air(): Float32Array[] {
  const channels = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
  channels.forEach((out, side) => {
    const noise = new Noise(77 + side * 31, 'pink');
    const filter = new Svf();
    for (let i = 0; i < FRAMES; i++) {
      if (i % 64 === 0) {
        const centre = 950 * Math.pow(10, 0.5 * Math.sin((2 * Math.PI * (i / FRAMES) * 2) + side * 1.7));
        filter.set('bandpass', centre, 1.2, TEXTURE_RATE);
      }
      out[i] = filter.process(noise.next());
    }
  });
  return normalize(channels);
}

/** Sixteen plucked notes of an A minor arpeggio, every 1/4 s: a rhythm that the grains can chop and re-pitch. */
function pluck(): Float32Array[] {
  const channels = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
  const arpeggio = [220, 261.63, 329.63, 440, 329.63, 261.63, 220, 164.81];
  const step = TEXTURE_RATE / 4;
  const count = Math.floor(FRAMES / step);
  for (let n = 0; n < count; n++) {
    const hz = arpeggio[n % arpeggio.length] as number;
    const start = Math.floor(n * step);
    const pan = 0.3 + 0.4 * ((n % 3) / 2);
    for (let k = 1; k <= 8; k++) {
      const phasor = new Phasor(hz * k, k);
      const decayPerSample = Math.exp(-1 / (TEXTURE_RATE * (0.5 / (0.6 + k * 0.4))));
      let level = 1 / k;
      for (let i = start; i < FRAMES; i++) {
        const x = phasor.next() * level;
        (channels[0] as Float32Array)[i] = ((channels[0] as Float32Array)[i] as number) + x * (1 - pan);
        (channels[1] as Float32Array)[i] = ((channels[1] as Float32Array)[i] as number) + x * pan;
        level *= decayPerSample;
        if (level < 1e-4) break;
      }
    }
  }
  return normalize(channels);
}

/** The ids `TEXTURE_OPTIONS` lists, as the builders. */
const BUILDERS: Record<string, () => Float32Array[]> = { choir, glass, strings, air, pluck };

/** A built-in texture as two channels at `TEXTURE_RATE` (an unknown id gives the choir). */
export function buildTexture(id: string): Float32Array[] {
  return (BUILDERS[id] ?? choir)();
}
