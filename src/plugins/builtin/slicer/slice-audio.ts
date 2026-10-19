import { OVERVIEW_BUCKET, peakOverview } from '@agstudio/sdk';
import { demoLoop, DEMO_RATE } from './demo.kernel';

/** The audio the editor slices and draws: its peak overview, length in frames and sample rate. */
export interface SliceAudio {
  peaks: Float32Array;
  length: number;
  sampleRate: number;
}

let cachedDemo: SliceAudio | null = null;

/** The built-in demo loop (what is sliced while no sample is loaded), made once. */
export function demoSliceAudio(): SliceAudio {
  if (!cachedDemo) {
    const data = demoLoop();
    cachedDemo = { peaks: peakOverview([data], OVERVIEW_BUCKET), length: data.length, sampleRate: DEMO_RATE };
  }
  return cachedDemo;
}
