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

type Params = typeof eqProParams;

/** Filter designs follow their params every CONTROL frames (param changes are smoothed by the host). */
const CONTROL_FRAMES = 32;
/** Switching a band on or off crossfades over about 10 ms. */
const FADE_SEC = 0.01 / 3;

/** One band: its sections for both channels and the settings they were designed for. */
class Band {
  readonly leftFilters: Svf[] = Array.from({ length: MAX_SECTIONS }, () => new Svf());
  readonly rightFilters: Svf[] = Array.from({ length: MAX_SECTIONS }, () => new Svf());
  sectionCount = 0;
  typeIndex = -1;
  frequencyHz = -1;
  gainDb = Number.NaN;
  q = -1;
  /** 0–1: how much of the band is heard (fades when it is switched). */
  audibleShare = 0;
  targetShare = 0;

  reset(): void {
    for (const filter of this.leftFilters) filter.reset();
    for (const s of this.rightFilters) s.reset();
  }
}

/**
 * EQ Pro: eight bands (bell, shelves, 12/24/48 dB/octave cuts, notch), each a cascade of SDK Svf
 * sections designed by design.kernel.ts (the same design the editor draws), then an output gain.
 * Bands that are off (or at 0 dB) cost nothing; switching one crossfades. With every band off it
 * returns the input unchanged.
 */
export class EqProKernel extends EffectKernel<Params> {
  private readonly bands: Band[] = Array.from({ length: BAND_COUNT }, () => new Band());
  private readonly sectionScratch: Section[] = sectionBuffer();
  private readonly fadeSmoothing = 1 - Math.exp(-1 / (FADE_SEC * this.sampleRate));
  private readonly bandParamIds = Array.from({ length: BAND_COUNT }, (_, b) => bandIds(b + 1));
  private countdown = 0;
  private outputDb = 0;
  private outputGain = 1;
  private isPrimed = false;

  override reset(): void {
    for (const band of this.bands) band.reset();
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, paramBlock: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const paramArrays = paramBlock as unknown as Record<string, Float32Array>;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.update(paramArrays, i);
      }
      this.countdown--;
      let leftSample = inLeft[i] as number;
      let rightSample = inRight[i] as number;
      for (let bandIndex = 0; bandIndex < BAND_COUNT; bandIndex++) {
        const band = this.bands[bandIndex] as Band;
        if (band.targetShare === 0 && band.audibleShare === 0) continue;
        let share = band.audibleShare + (band.targetShare - band.audibleShare) * this.fadeSmoothing;
        if (Math.abs(share - band.targetShare) < 1e-5) share = band.targetShare;
        band.audibleShare = share;
        let bandLeft = leftSample;
        let bandRight = rightSample;
        for (let sectionIndex = 0; sectionIndex < band.sectionCount; sectionIndex++) {
          bandLeft = (band.leftFilters[sectionIndex] as Svf).process(bandLeft);
          bandRight = (band.rightFilters[sectionIndex] as Svf).process(bandRight);
        }
        if (share === 1) {
          leftSample = bandLeft;
          rightSample = bandRight;
        } else {
          leftSample += share * (bandLeft - leftSample);
          rightSample += share * (bandRight - rightSample);
        }
      }
      const outputGain = this.outputGain;
      outLeft[i] = outputGain === 1 ? leftSample : leftSample * outputGain;
      outRight[i] = outputGain === 1 ? rightSample : rightSample * outputGain;
    }
  }

  /** Redesigns the bands whose settings changed. */
  private update(paramArrays: Record<string, Float32Array>, frame: number): void {
    const sampleRate = this.sampleRate;
    for (let bandIndex = 0; bandIndex < BAND_COUNT; bandIndex++) {
      const band = this.bands[bandIndex] as Band;
      const paramIds = this.bandParamIds[bandIndex] as ReturnType<typeof bandIds>;
      const isOn = (at(paramArrays[paramIds.on] as Float32Array, frame) as number) >= 0.5;
      const typeIndex = Math.round(at(paramArrays[paramIds.type] as Float32Array, frame));
      const frequencyHz = clampFreq(at(paramArrays[paramIds.freq] as Float32Array, frame), sampleRate);
      const gainDb = at(paramArrays[paramIds.gain] as Float32Array, frame);
      const q = at(paramArrays[paramIds.q] as Float32Array, frame);
      const kind = (BAND_TYPES[typeIndex] ?? 'bell') as BandType;
      // A bell or shelf at 0 dB does nothing: skip it.
      const isFlat = (kind === 'bell' || kind === 'lowShelf' || kind === 'highShelf') && gainDb === 0;
      band.targetShare = isOn && !isFlat ? 1 : 0;
      if (!this.isPrimed) band.audibleShare = band.targetShare;
      if (band.targetShare === 0 && band.audibleShare === 0) continue;
      if (typeIndex === band.typeIndex && frequencyHz === band.frequencyHz && gainDb === band.gainDb && q === band.q)
        continue;
      band.typeIndex = typeIndex;
      band.frequencyHz = frequencyHz;
      band.gainDb = gainDb;
      band.q = q;
      const sectionCount = bandSections(kind, q, this.sectionScratch);
      band.sectionCount = sectionCount;
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
        const section = this.sectionScratch[sectionIndex] as Section;
        (band.leftFilters[sectionIndex] as Svf).set(section.type, frequencyHz, section.q, sampleRate, gainDb);
        (band.rightFilters[sectionIndex] as Svf).set(section.type, frequencyHz, section.q, sampleRate, gainDb);
      }
    }
    const outputDb = at(paramArrays.output as Float32Array, frame);
    if (outputDb !== this.outputDb) {
      this.outputDb = outputDb;
      this.outputGain = dbToGain(outputDb);
    }
    this.isPrimed = true;
  }
}
