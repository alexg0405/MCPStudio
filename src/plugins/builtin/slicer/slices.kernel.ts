// Where the Slicer cuts: shared by the kernel (what plays) and the editor (the markers), so both
// always agree. Both slice the same peak overview (256 frames per bucket).
import { detectSlicesInto, gridSlicesInto, OVERVIEW_BUCKET } from '@agstudio/sdk/dsp/transients';

export interface SliceSettings {
  /** 0 = at hits (transients), 1 = even grid. */
  mode: number;
  sensitivity: number;
  gridSlices: number;
  /** Shortest slice, milliseconds. */
  minSlice: number;
}

/** Writes the slice start frames of a `length`-frame sample to `out`; returns how many. */
export function computeSlices(
  peaks: Float32Array,
  buckets: number,
  length: number,
  sampleRate: number,
  s: SliceSettings,
  out: Int32Array,
  scratch?: Float64Array,
): number {
  if (length <= 0) return 0;
  if (s.mode === 1) return gridSlicesInto(length, s.gridSlices, out);
  return detectSlicesInto(
    peaks,
    buckets,
    OVERVIEW_BUCKET,
    sampleRate,
    { sensitivity: s.sensitivity, minLength: s.minSlice / 1000, max: out.length },
    out,
    scratch,
  );
}
