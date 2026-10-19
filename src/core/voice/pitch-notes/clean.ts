import { framesToCents, hzOf, median } from './shared';

/** Frames of an unvoiced dropout that are bridged by interpolation. */
const BRIDGE_FRAMES = 2;
/** Shortest voiced run kept, frames. */
const MIN_RUN_FRAMES = 4;
/** A glitch is looked for against up to this many voiced frames on each side, within this many frames. */
const NEIGHBOURS = 3;
const NEIGHBOUR_REACH = 4;
/** The two sides agree when their medians are within this many cents; otherwise the frame is left alone. */
const SIDES_AGREE_CENTS = 250;
/** A frame this far (cents) from its neighbours is a glitch… */
const GLITCH_CENTS = 450;
/** …moved back by whole octaves when it then lands within this of them, else made unvoiced. */
const OCTAVE_FIT_CENTS = 250;
const OCTAVE_CENTS = 1200;
/** A dropout is bridged only when the two sides are within this many cents of each other. */
const BRIDGE_MAX_JUMP_CENTS = 200;
/** A bridged frame is at most this confident. */
const BRIDGED_CONFIDENCE = 0.6;

/** Up to three voiced frames on one side of frame `i` (nearest first), looking at most four frames away. */
function voicedNeighbours(c: Float64Array, i: number, direction: 1 | -1, into: number[]): void {
  into.length = 0;
  const stop = direction === 1 ? Math.min(c.length - 1, i + NEIGHBOUR_REACH) : Math.max(0, i - NEIGHBOUR_REACH);
  for (let j = i + direction; direction === 1 ? j <= stop : j >= stop; j += direction) {
    if (into.length >= NEIGHBOURS) break;
    if (!Number.isNaN(c[j] as number)) into.push(c[j] as number);
  }
}

/** Octave slips (a frame an octave off its neighbours moves back; an isolated outlier goes NaN), in cents. */
function repairGlitches(c: Float64Array): Float64Array {
  const n = c.length;
  const fixed = Float64Array.from(c);
  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(c[i] as number)) continue;
    // Up to three voiced frames on each side: a glitch differs from both and they agree with each other.
    voicedNeighbours(c, i, -1, before);
    voicedNeighbours(c, i, 1, after);
    // At the very start or end of a run only one side exists: the tracker's last wild frames as a
    // voice dies away are compared with the three before them.
    const oneSided = (before.length >= 3 && after.length < 2) || (after.length >= 3 && before.length < 2);
    if (!oneSided && (before.length < 2 || after.length < 2)) continue;
    const l = before.length >= 2 ? median(before) : median(after);
    const r = after.length >= 2 ? median(after) : l;
    if (Math.abs(l - r) > SIDES_AGREE_CENTS) continue;
    const d = (c[i] as number) - 0.5 * (l + r);
    if (Math.abs(d) <= GLITCH_CENTS) continue;
    const octaves = Math.round(d / OCTAVE_CENTS);
    const fitsOctaves = octaves !== 0 && Math.abs(d - OCTAVE_CENTS * octaves) < OCTAVE_FIT_CENTS;
    fixed[i] = fitsOctaves ? (c[i] as number) - OCTAVE_CENTS * octaves : Number.NaN;
  }
  return fixed;
}

/** Bridges unvoiced dropouts of up to two frames by a line in cents (and a confidence of at most 0.6). */
function bridgeDropouts(fixed: Float64Array, conf: Float32Array, outConf: Float32Array): void {
  const n = fixed.length;
  let i = 0;
  while (i < n) {
    if (!Number.isNaN(fixed[i] as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && Number.isNaN(fixed[j] as number)) j++;
    if (i > 0 && j < n && j - i <= BRIDGE_FRAMES) {
      const a = fixed[i - 1] as number;
      const b = fixed[j] as number;
      if (Math.abs(a - b) < BRIDGE_MAX_JUMP_CENTS) {
        for (let k = i; k < j; k++) {
          fixed[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
          outConf[k] = Math.min(conf[i - 1] as number, conf[j] as number, BRIDGED_CONFIDENCE);
        }
      }
    }
    i = j;
  }
}

/** Makes voiced runs under 20 ms unvoiced. */
function dropShortRuns(fixed: Float64Array): void {
  const n = fixed.length;
  let i = 0;
  while (i < n) {
    if (Number.isNaN(fixed[i] as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !Number.isNaN(fixed[j] as number)) j++;
    if (j - i < MIN_RUN_FRAMES) for (let k = i; k < j; k++) fixed[k] = Number.NaN;
    i = j;
  }
}

/**
 * Repairs a raw YIN track: octave slips (a frame an octave off its neighbours moves back; an
 * isolated outlier goes unvoiced), dropouts of up to two frames are bridged, runs under 20 ms
 * dropped. Returns new arrays.
 */
export function cleanF0(f0: Float32Array, conf: Float32Array): { f0: Float32Array; conf: Float32Array } {
  const n = f0.length;
  const fixed = repairGlitches(framesToCents(f0));
  const outConf = Float32Array.from(conf);
  bridgeDropouts(fixed, conf, outConf);
  dropShortRuns(fixed);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = fixed[k] as number;
    out[k] = Number.isNaN(v) ? 0 : hzOf(v);
    if (Number.isNaN(v)) outConf[k] = 0;
  }
  return { f0: out, conf: outConf };
}
