import type { OscillatorState } from './voice.kernel';

/**
 * Adds one oscillator's unison copies into the stereo mix buffers for `count` samples, and moves their
 * phases and the morph on. Each copy reads two neighbouring frames of the wavetable (linearly
 * interpolated between samples) and crossfades them by the morph.
 *
 * This is the synth's hottest loop: it allocates nothing and calls nothing per sample. Copies are done
 * two per pass (half the loop overhead and half the traffic through the mix buffers) with a one-copy
 * pass for an odd last copy.
 */
export function addOscillatorToMix(
  osc: OscillatorState,
  unison: number,
  count: number,
  mixLeft: Float64Array,
  mixRight: Float64Array,
): void {
  const table = osc.data;
  const frameA = osc.frameAOffset;
  const frameB = osc.frameBOffset;
  const cycleSize = osc.cycleSize;
  const startMorph = osc.morph;
  const morphStep = osc.morphStep;
  let copy = 0;
  for (; copy + 1 < unison; copy += 2) {
    let phase1 = osc.phase[copy] as number;
    let phase2 = osc.phase[copy + 1] as number;
    const step1 = osc.phaseStep[copy] as number;
    const step2 = osc.phaseStep[copy + 1] as number;
    const left1 = osc.gainLeft[copy] as number;
    const right1 = osc.gainRight[copy] as number;
    const left2 = osc.gainLeft[copy + 1] as number;
    const right2 = osc.gainRight[copy + 1] as number;
    let morph = startMorph;
    for (let s = 0; s < count; s++) {
      const position1 = phase1 * cycleSize;
      const index1 = position1 | 0;
      const fraction1 = position1 - index1;
      const position2 = phase2 * cycleSize;
      const index2 = position2 | 0;
      const fraction2 = position2 - index2;
      // Both frames at both copies' positions: the sample below the position, then interpolated towards the one above.
      const lowerA1 = table[frameA + index1] as number;
      const lowerB1 = table[frameB + index1] as number;
      const lowerA2 = table[frameA + index2] as number;
      const lowerB2 = table[frameB + index2] as number;
      const sampleA1 = lowerA1 + ((table[frameA + index1 + 1] as number) - lowerA1) * fraction1;
      const sampleB1 = lowerB1 + ((table[frameB + index1 + 1] as number) - lowerB1) * fraction1;
      const sampleA2 = lowerA2 + ((table[frameA + index2 + 1] as number) - lowerA2) * fraction2;
      const sampleB2 = lowerB2 + ((table[frameB + index2 + 1] as number) - lowerB2) * fraction2;
      const sample1 = sampleA1 + (sampleB1 - sampleA1) * morph;
      const sample2 = sampleA2 + (sampleB2 - sampleA2) * morph;
      mixLeft[s] = (mixLeft[s] as number) + sample1 * left1 + sample2 * left2;
      mixRight[s] = (mixRight[s] as number) + sample1 * right1 + sample2 * right2;
      phase1 += step1;
      if (phase1 >= 1) phase1 -= 1;
      phase2 += step2;
      if (phase2 >= 1) phase2 -= 1;
      morph += morphStep;
    }
    osc.phase[copy] = phase1;
    osc.phase[copy + 1] = phase2;
  }
  for (; copy < unison; copy++) {
    let phase = osc.phase[copy] as number;
    const step = osc.phaseStep[copy] as number;
    const left = osc.gainLeft[copy] as number;
    const right = osc.gainRight[copy] as number;
    let morph = startMorph;
    for (let s = 0; s < count; s++) {
      const position = phase * cycleSize;
      const index = position | 0;
      const fraction = position - index;
      const sampleA =
        (table[frameA + index] as number) +
        ((table[frameA + index + 1] as number) - (table[frameA + index] as number)) * fraction;
      const sampleB =
        (table[frameB + index] as number) +
        ((table[frameB + index + 1] as number) - (table[frameB + index] as number)) * fraction;
      const sample = sampleA + (sampleB - sampleA) * morph;
      mixLeft[s] = (mixLeft[s] as number) + sample * left;
      mixRight[s] = (mixRight[s] as number) + sample * right;
      phase += step;
      if (phase >= 1) phase -= 1;
      morph += morphStep;
    }
    osc.phase[copy] = phase;
  }
  osc.morph = startMorph + morphStep * count;
}
