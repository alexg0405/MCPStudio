// What the table editor's buttons do to the list of key frames: pure functions, so the editor stays a thin layer
// and the behaviour is tested without a browser.
import { Rng } from '@agstudio/sdk/dsp/random';
import {
  bandLimit,
  cloneFrame,
  FRAME_POINTS,
  frameFromWave,
  framesBetween,
  MAX_FRAMES,
  normalizeFrame,
  removeDc,
  sineFrame,
  type Frame,
} from '@agstudio/sdk/dsp/wavetable-frames';

/** A list of key frames and which one is selected after an edit. */
export interface TableEdit {
  frames: Frame[];
  selected: number;
}

const clampIndex = (index: number, count: number) => Math.max(0, Math.min(count - 1, index));

/** Adds a copy of the selected frame after it (a sine when the table is empty). Does nothing at the frame limit. */
export function addFrameAfter(frames: readonly Frame[], selected: number): TableEdit {
  if (frames.length === 0) return { frames: [sineFrame()], selected: 0 };
  if (frames.length >= MAX_FRAMES) return { frames: [...frames], selected };
  const at = clampIndex(selected, frames.length);
  const next = [...frames];
  next.splice(at + 1, 0, cloneFrame(frames[at] as Frame));
  return { frames: next, selected: at + 1 };
}

/** Removes the selected frame (the last one is kept: a table needs a frame, and an empty table means "none yet"). */
export function removeFrameAt(frames: readonly Frame[], selected: number): TableEdit {
  if (frames.length <= 1) return { frames: [...frames], selected: 0 };
  const at = clampIndex(selected, frames.length);
  const next = frames.filter((_, i) => i !== at);
  return { frames: next, selected: clampIndex(at, next.length) };
}

/** Moves the selected frame one place earlier (`-1`) or later (`1`) in the table. */
export function moveFrame(frames: readonly Frame[], selected: number, direction: -1 | 1): TableEdit {
  const at = clampIndex(selected, frames.length);
  const to = at + direction;
  if (to < 0 || to >= frames.length) return { frames: [...frames], selected: at };
  const next = [...frames];
  [next[at], next[to]] = [next[to] as Frame, next[at] as Frame];
  return { frames: next, selected: to };
}

/** Puts `frame` in place of the selected one (creating the first frame of an empty table). */
export function replaceFrame(frames: readonly Frame[], selected: number, frame: Frame): TableEdit {
  if (frames.length === 0) return { frames: [frame], selected: 0 };
  const at = clampIndex(selected, frames.length);
  const next = [...frames];
  next[at] = frame;
  return { frames: next, selected: at };
}

/**
 * Inserts `count` frames after the selected one that step evenly from it to the next, so a morph between two key
 * frames becomes an exact series (the selected frame stays where it is). Stops at the frame limit.
 */
export function fillBetween(frames: readonly Frame[], selected: number, count: number): TableEdit {
  const at = clampIndex(selected, frames.length);
  const after = frames[at + 1];
  if (!after) return { frames: [...frames], selected: at };
  const room = Math.max(0, MAX_FRAMES - frames.length);
  const made = framesBetween(frames[at] as Frame, after, Math.min(Math.round(count), room));
  return { frames: [...frames.slice(0, at + 1), ...made, ...frames.slice(at + 1)], selected: at };
}

/** The ready-made shapes the editor offers to start a frame from. */
export const STARTING_SHAPES = [
  ['sine', 'Sine'],
  ['triangle', 'Triangle'],
  ['saw', 'Saw'],
  ['square', 'Square'],
  ['pulse', 'Pulse (25%)'],
  ['noise', 'Random (smoothed noise)'],
] as const;
export type StartingShape = (typeof STARTING_SHAPES)[number][0];

/** How many random values the "random" starting shape steps between. */
const NOISE_POINTS = 64;
/** The seed of the "random" shape, so it is the same each time. */
const NOISE_SEED = 2024;

/** A triangle at `t` (0–1 through the cycle): up to the peak, down through zero to the trough, back up. */
function triangleAt(t: number): number {
  if (t < 0.25) return 4 * t;
  if (t < 0.75) return 2 - 4 * t;
  return 4 * t - 4;
}

/** Linear steps between the random values: smooth enough to be a tone, rough enough to be interesting. */
function smoothedNoiseAt(t: number, randoms: Float32Array): number {
  const x = t * randoms.length;
  const a = randoms[Math.floor(x) % randoms.length] as number;
  const b = randoms[(Math.floor(x) + 1) % randoms.length] as number;
  return a + (b - a) * (x - Math.floor(x));
}

/** One cycle of a ready-made shape as a drawing buffer. The random shape uses a fixed seed, so it is the same each time. */
export function shapeWave(shape: StartingShape, points = FRAME_POINTS): Float32Array {
  const rng = new Rng(NOISE_SEED);
  const randoms = Float32Array.from({ length: NOISE_POINTS }, () => rng.bipolar());
  return Float32Array.from({ length: points }, (_, i) => {
    const t = i / points;
    switch (shape) {
      case 'sine':
        return Math.sin(2 * Math.PI * t);
      case 'triangle':
        return triangleAt(t);
      case 'saw':
        return 1 - 2 * t;
      case 'square':
        return t < 0.5 ? 1 : -1;
      case 'pulse':
        return t < 0.25 ? 1 : -1;
      case 'noise':
        return smoothedNoiseAt(t, randoms);
    }
  });
}

/** A frame of a ready-made shape: band-limited to 128 harmonics (hard edges keep their ring-free top), no DC, peak 1. */
export function startingFrame(shape: StartingShape): Frame {
  return normalizeFrame(removeDc(bandLimit(frameFromWave(shapeWave(shape)), 128)));
}

/** The table a "start from Basic shapes" button makes: sine, triangle, saw and square, one frame each. */
export function basicShapesTable(): Frame[] {
  return (['sine', 'triangle', 'saw', 'square'] as const).map(startingFrame);
}
