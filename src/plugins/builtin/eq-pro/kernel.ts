import { at, dbToGain, EffectKernel, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import {
  BAND_TYPES,
  bandSections,
  clampFreq,
  MAX_SECTIONS,
  sectionBuffer,
  type BandType,
  type Section,
} from './design.kernel';
import { BAND_COUNT, bandIds, type eqProParams } from './params';

type P = typeof eqProParams;

/** Filter designs follow their params every CONTROL frames (param changes are smoothed by the host). */
const CONTROL = 32;
/** Switching a band on or off crossfades over about 10 ms. */
const FADE_SECONDS = 0.01 / 3;

/** One band: its sections for both channels and the settings they were designed for. */
class Band {
  readonly left: Svf[] = Array.from({ length: MAX_SECTIONS }, () => new Svf());
  readonly right: Svf[] = Array.from({ length: MAX_SECTIONS }, () => new Svf());
  sections = 0;
  type = -1;
  freq = -1;
  gain = Number.NaN;
  q = -1;
  /** 0–1: how much of the band is heard (fades when it is switched). */
  mix = 0;
  target = 0;

  reset(): void {
    for (const s of this.left) s.reset();
    for (const s of this.right) s.reset();
  }
}

/**
 * EQ Pro: eight bands (bell, shelves, 12/24/48 dB/octave cuts, notch), each a cascade of SDK Svf
 * sections designed by design.kernel.ts (the same design the editor draws), then an output gain.
 * Bands that are off (or at 0 dB) cost nothing; switching one crossfades. With every band off it
 * returns the input unchanged.
 */
export class EqProKernel extends EffectKernel<P> {
  private readonly bands: Band[] = Array.from({ length: BAND_COUNT }, () => new Band());
  private readonly scratch: Section[] = sectionBuffer();
  private readonly fade = 1 - Math.exp(-1 / (FADE_SECONDS * this.sampleRate));
  private readonly ids = Array.from({ length: BAND_COUNT }, (_, b) => bandIds(b + 1));
  private countdown = 0;
  private outDb = 0;
  private outGain = 1;
  private primed = false;

  override reset(): void {
    for (const b of this.bands) b.reset();
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const params = p as unknown as Record<string, Float32Array>;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.update(params, i);
      }
      this.countdown--;
      let l = inL[i] as number;
      let r = inR[i] as number;
      for (let b = 0; b < BAND_COUNT; b++) {
        const band = this.bands[b] as Band;
        if (band.target === 0 && band.mix === 0) continue;
        let mix = band.mix + (band.target - band.mix) * this.fade;
        if (Math.abs(mix - band.target) < 1e-5) mix = band.target;
        band.mix = mix;
        let yl = l;
        let yr = r;
        for (let s = 0; s < band.sections; s++) {
          yl = (band.left[s] as Svf).process(yl);
          yr = (band.right[s] as Svf).process(yr);
        }
        if (mix === 1) {
          l = yl;
          r = yr;
        } else {
          l += mix * (yl - l);
          r += mix * (yr - r);
        }
      }
      const g = this.outGain;
      outL[i] = g === 1 ? l : l * g;
      outR[i] = g === 1 ? r : r * g;
    }
  }

  /** Redesigns the bands whose settings changed. */
  private update(p: Record<string, Float32Array>, i: number): void {
    const sr = this.sampleRate;
    for (let b = 0; b < BAND_COUNT; b++) {
      const band = this.bands[b] as Band;
      const ids = this.ids[b] as ReturnType<typeof bandIds>;
      const on = (at(p[ids.on] as Float32Array, i) as number) >= 0.5;
      const type = Math.round(at(p[ids.type] as Float32Array, i));
      const freq = clampFreq(at(p[ids.freq] as Float32Array, i), sr);
      const gain = at(p[ids.gain] as Float32Array, i);
      const q = at(p[ids.q] as Float32Array, i);
      const kind = (BAND_TYPES[type] ?? 'bell') as BandType;
      // A bell or shelf at 0 dB does nothing: skip it.
      const flat = (kind === 'bell' || kind === 'lowShelf' || kind === 'highShelf') && gain === 0;
      band.target = on && !flat ? 1 : 0;
      if (!this.primed) band.mix = band.target;
      if (band.target === 0 && band.mix === 0) continue;
      if (type === band.type && freq === band.freq && gain === band.gain && q === band.q) continue;
      band.type = type;
      band.freq = freq;
      band.gain = gain;
      band.q = q;
      const count = bandSections(kind, q, this.scratch);
      band.sections = count;
      for (let s = 0; s < count; s++) {
        const sec = this.scratch[s] as Section;
        (band.left[s] as Svf).set(sec.type, freq, sec.q, sr, gain);
        (band.right[s] as Svf).set(sec.type, freq, sec.q, sr, gain);
      }
    }
    const out = at(p.output as Float32Array, i);
    if (out !== this.outDb) {
      this.outDb = out;
      this.outGain = dbToGain(out);
    }
    this.primed = true;
  }
}
