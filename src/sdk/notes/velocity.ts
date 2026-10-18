/** Velocity transforms ("scale levels"): scale, fit into a range, ramp over time. */
import type { ScriptNote } from '../types';
import { bend, clamp, span } from './util';

/** Settings for `scaleVelocities`. */
export interface ScaleVelocityOptions {
  /** Multiplies every velocity (1 = unchanged). */
  factor?: number;
  /** Added after scaling (−1…1). */
  offset?: number;
}

/** velocity × factor + offset, clamped to 0–1. */
export function scaleVelocities(notes: readonly ScriptNote[], opts: ScaleVelocityOptions): ScriptNote[] {
  const factor = opts.factor ?? 1;
  const offset = opts.offset ?? 0;
  return notes.map((n) => ({ ...n, velocity: clamp(n.velocity * factor + offset, 0, 1) }));
}

/**
 * Maps the notes' own velocity range onto [min, max] (the softest note gets `min`, the loudest
 * `max`). Notes that all share one velocity are clamped into the range instead.
 */
export function fitVelocities(notes: readonly ScriptNote[], range: { min: number; max: number }): ScriptNote[] {
  const lo = clamp(Math.min(range.min, range.max), 0, 1);
  const hi = clamp(Math.max(range.min, range.max), 0, 1);
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const n of notes) {
    vMin = Math.min(vMin, n.velocity);
    vMax = Math.max(vMax, n.velocity);
  }
  return notes.map((n) => ({
    ...n,
    velocity: vMax > vMin ? lo + ((n.velocity - vMin) / (vMax - vMin)) * (hi - lo) : clamp(n.velocity, lo, hi),
  }));
}

/** Settings for `rampVelocities`. */
export interface RampOptions {
  /** Level at the first note's start… */
  from: number;
  /** …and at the last note's start. */
  to: number;
  /** −1…1: bends the ramp (0 = straight). */
  curve?: number;
  /** Multiply the existing velocities by the ramp instead of replacing them. */
  multiply?: boolean;
}

/** A crescendo or decrescendo across the notes' time span. */
export function rampVelocities(notes: readonly ScriptNote[], opts: RampOptions): ScriptNote[] {
  const s = span(notes);
  if (!s) return [];
  let last = s.start;
  for (const n of notes) last = Math.max(last, n.tick);
  return notes.map((n) => {
    const x = last > s.start ? (n.tick - s.start) / (last - s.start) : 0;
    const level = opts.from + (opts.to - opts.from) * bend(x, opts.curve ?? 0);
    return { ...n, velocity: clamp(opts.multiply ? n.velocity * level : level, 0, 1) };
  });
}
