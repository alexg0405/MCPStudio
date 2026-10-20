/**
 * What a kick or a tom leaks into the other views. A kick has a click and a lot of harmonics, so the mid and high views show
 * a start at every kick; a snare or a hat on top of a kick shows as *more* than the kick leaks. The recording teaches the
 * model: for every kick (or tom) the level its view reached in the other view, against its own level; the lowest quarter of
 * those ratios is what a kick does alone (a recording with kicks on their own beats has them; one where every kick has a
 * snare on it cannot tell, and reads those snares as leak). Pure.
 */
import { levelFrom, SAME_HIT_SEC, type View } from './drum-views';
import type { HeardHit } from './types';

/** The head of a hit: from 6 ms before to 30 ms after its start; its tail: from 30 to 70 ms after it (blocks of 2 ms). */
const HEAD_FROM = -3;
const HEAD_BLOCKS = 18;
const TAIL_FROM = 15;
const TAIL_BLOCKS = 20;
/** A start must be this much louder than the leak in its head, or in its tail, to be another hit (dB). */
export const HEAD_EXCESS_DB = 6;
export const TAIL_EXCESS_DB = 8;
/** Which quarter of the ratios is the leak: the lowest. */
const LEAK_SHARE = 0.25;

/** How loud a view should be at a time because of the kicks and toms there, in its head and in its tail. */
export interface Expected {
  head: number;
  tail: number;
}

/** The model of a view's leak: what a kick or tom near a time makes of it, or null when none is near. */
export interface LeakModel {
  expectedAt(timeSec: number): Expected | null;
}

/** What a view shows in a stretch after a hit, against the hit's own level (dB). */
function ratioAt(view: View, hit: HeardHit, from: number, blocks: number): number {
  const block = Math.round(hit.timeSec / view.env.blockSec);
  return levelFrom(view, block + from, blocks) - hit.strength;
}

/** True when a start is louder than the kick or tom beside it leaks into the view, in its head or in its tail (or none is beside it). */
export function beyondLeak(model: LeakModel, view: View, onsetSec: number, headDb: number): boolean {
  const expected = model.expectedAt(onsetSec);
  if (!expected) return true;
  const tail = levelFrom(view, Math.round(onsetSec / view.env.blockSec) + TAIL_FROM, TAIL_BLOCKS);
  return headDb >= expected.head + HEAD_EXCESS_DB || tail >= expected.tail + TAIL_EXCESS_DB;
}

/** The lower quarter of a list (the lowest value for a short list). */
function lowQuarter(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(LEAK_SHARE * (sorted.length - 1))] as number;
}

/** The model of what `bodies` (kicks and toms; `strength` holds each one's level in dB) leak into `view`. */
export function leakModel(view: View, bodies: readonly HeardHit[]): LeakModel {
  const leakOf = new Map<string, Expected>();
  for (const kind of new Set(bodies.map((b) => b.kind))) {
    const ofKind = bodies.filter((b) => b.kind === kind);
    leakOf.set(kind, {
      head: lowQuarter(ofKind.map((b) => ratioAt(view, b, HEAD_FROM, HEAD_BLOCKS))),
      tail: lowQuarter(ofKind.map((b) => ratioAt(view, b, TAIL_FROM, TAIL_BLOCKS))),
    });
  }
  return {
    expectedAt(timeSec) {
      let near: HeardHit | null = null;
      for (const body of bodies) {
        if (Math.abs(body.timeSec - timeSec) > SAME_HIT_SEC) continue;
        if (!near || Math.abs(body.timeSec - timeSec) < Math.abs(near.timeSec - timeSec)) near = body;
      }
      if (!near) return null;
      const ratio = leakOf.get(near.kind) as Expected;
      return { head: near.strength + ratio.head, tail: near.strength + ratio.tail };
    },
  };
}
