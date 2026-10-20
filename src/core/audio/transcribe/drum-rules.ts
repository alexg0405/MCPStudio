/**
 * Telling the drums apart from the starts found in the four views (`drum-views.ts`). Each kind is looked for where it
 * lives, so a hat over a kick is two hits, not one confused one:
 *
 * - **kick**: a start in the sub view that holds (a snare's low tone leaks in and fades at once), that the sample browser's
 *   classifier calls a kick or 808
 * - **tom**: a start in the low view, quiet in the mid view, that the classifier calls a tom
 * - **snare, clap, perc**: a start in the mid view that lasts and is more than a kick leaks there, in its first 30 ms or
 *   after them (`drum-leak.ts`), classified from the mid view so a kick under it does not matter
 * - **hat, open hat, cymbal**: a start in the high view that rings on (a kick's click is gone in 8 ms) and is not the tail of
 *   another hit, by how long it rings; a hat under a snare or clap counts when the recording has hats of its own and this
 *   one is about as loud as they are
 *
 * The classifier is the sample browser's (`core/samples/classify.ts`), fed slices of the views. Pure.
 */
import type { SampleCategory } from '../../samples/types';
import type { BandOnset } from './drum-bands';
import { beyondLeak, leakModel, type LeakModel } from './drum-leak';
import { bestOf, levelAfterPeak, levelFrom, newLevel, nextStart, peakWithin, SAME_HIT_SEC, scoresOf, type DrumViews, type View } from './drum-views';
import type { DrumKind, HeardHit } from './types';

/** The kind a classifier category stands for among drums (808s are kicks; anything else is percussion). */
function kindOfCategory(category: SampleCategory): DrumKind {
  if (category === '808') return 'kick';
  if (category === 'kick' || category === 'snare' || category === 'clap' || category === 'hat' || category === 'open-hat' || category === 'tom' || category === 'cymbal') return category;
  return 'perc';
}

/** A hit with the level it is measured at (dB; the strength is worked out from all the hits of its kind later). */
function hit(kind: DrumKind, timeSec: number, levelDb: number, confidence: number, bodyHz?: number): HeardHit {
  return { timeSec, kind, strength: levelDb, confidence: Math.min(1, confidence), ...(bodyHz ? { bodyHz } : {}) };
}

/** Where a tom's body is measured, seconds after its start (past the first strike). */
const BODY_FROM_SEC = 0.015;
const BODY_TO_SEC = 0.09;

/** The pitch of a tom's body in Hz: how often the low view crosses zero (rising) between 15 and 90 ms after the start. */
function bodyHz(view: View, rate: number, onset: BandOnset): number {
  const from = Math.round((onset.timeSec + BODY_FROM_SEC) * rate);
  const to = Math.min(view.signal.length - 1, Math.round((onset.timeSec + BODY_TO_SEC) * rate));
  let crossings = 0;
  for (let i = from + 1; i <= to; i++) if ((view.signal[i - 1] as number) < 0 && (view.signal[i] as number) >= 0) crossings++;
  return to > from ? Math.round((crossings * rate) / (to - from)) : 0;
}

/** A kick's sub level 24 ms after its peak is still within 9 dB of it (a snare's tone leak falls faster). */
const KICK_HOLD_SEC = 0.024;
const KICK_HOLD_DB = 9;

/** Kicks: starts in the sub view that hold and sound like a kick. */
function kickHits(views: DrumViews): HeardHit[] {
  const out: HeardHit[] = [];
  for (const onset of views.sub.onsets) {
    const peak = peakWithin(views.sub, onset);
    if (levelAfterPeak(views.sub, onset, KICK_HOLD_SEC) < peak - KICK_HOLD_DB) continue;
    const level = newLevel(views.sub, onset);
    const verdict = bestOf(scoresOf(views.sub, views.rate, onset), ['kick', '808', 'tom']);
    const kind = kindOfCategory(verdict.category);
    out.push(hit(kind, onset.timeSec, level, verdict.score, kind === 'tom' ? bodyHz(views.low, views.rate, onset) : undefined));
  }
  return out;
}

/** A tom's mid view is at least this far under its low view (a snare's body has noise over it, so it is not far under) (dB). */
const TOM_MID_UNDER_DB = 5;

/** Toms: starts in the low view that are not a kick, not a snare's body and sound like a tom. */
function tomHits(views: DrumViews, kicks: readonly HeardHit[]): HeardHit[] {
  const out: HeardHit[] = [];
  for (const onset of views.low.onsets) {
    if (kicks.some((k) => Math.abs(k.timeSec - onset.timeSec) <= SAME_HIT_SEC)) continue;
    const low = peakWithin(views.low, onset);
    const level = newLevel(views.low, onset);
    const mid = levelFrom(views.mid, Math.round(onset.timeSec / views.mid.env.blockSec) - 3, 18);
    if (mid > low - TOM_MID_UNDER_DB) continue;
    const verdict = bestOf(scoresOf(views.low, views.rate, onset), ['tom', 'kick', '808', 'perc']);
    if (verdict.category !== 'tom' && verdict.category !== 'perc') continue;
    const isTom = verdict.category === 'tom';
    out.push(hit(isTom ? 'tom' : 'perc', onset.timeSec, level, verdict.score, isTom ? bodyHz(views.low, views.rate, onset) : undefined));
  }
  return out;
}

/** The mid level this long after the start must still be this close under the peak for a hit to count (a click is gone) (dB). */
const LASTS_AFTER_SEC = 0.012;
const LASTS_WITHIN_DB = 22;

/** A mid start must be at least this loud against the high view's start beside it (dB), or it is a hat's top end. */
const MID_OVER_HIGH_DB = -8;

/** The loudest high-view level within 30 ms of a mid start, or -Infinity when the high view is quiet there. */
function highBeside(views: DrumViews, onset: BandOnset): number {
  const beside = views.high.onsets.filter((h) => Math.abs(h.timeSec - onset.timeSec) <= SAME_HIT_SEC);
  return beside.length === 0 ? -Infinity : Math.max(...beside.map((h) => peakWithin(views.high, h)));
}

/** Snares, claps and percussion: starts in the mid view that last, are not the leak of a kick, and are not a hat's top end. */
function midHits(views: DrumViews, leak: LeakModel, bodies: readonly HeardHit[]): HeardHit[] {
  const out: HeardHit[] = [];
  for (const onset of views.mid.onsets) {
    const peak = peakWithin(views.mid, onset);
    // A tom's click is no snare: its body is the hit (a snare under a tom is too rare to look for).
    if (bodies.some((b) => b.kind === 'tom' && Math.abs(b.timeSec - onset.timeSec) <= SAME_HIT_SEC)) continue;
    if (levelAfterPeak(views.mid, onset, LASTS_AFTER_SEC) < onset.peakDb - LASTS_WITHIN_DB) continue;
    if (peak < highBeside(views, onset) + MID_OVER_HIGH_DB) continue;
    if (!beyondLeak(leak, views.mid, onset.timeSec, peak)) continue;
    const verdict = bestOf(scoresOf(views.mid, views.rate, onset), ['snare', 'clap', 'perc']);
    out.push(hit(kindOfCategory(verdict.category), onset.timeSec, newLevel(views.mid, onset), verdict.score));
  }
  return out;
}

/** A closed hat is quiet again this long after its peak, an open hat is not (s). */
const RING_CHECK_SEC = 0.08;
/** An open hat is still within this many dB of its peak at the check (dB). */
const OPEN_WITHIN_DB = 16;
/** A start whose next start in the same view is further than this has its whole ring to be judged by the classifier (s). */
const FULL_RING_SEC = 0.45;

/** Hat, open hat or cymbal for one start in the high view. */
function hatKind(views: DrumViews, onset: BandOnset): { kind: DrumKind; confidence: number } {
  const gap = nextStart(views.high.onsets, onset.timeSec) - onset.timeSec;
  if (gap >= FULL_RING_SEC) {
    const verdict = bestOf(scoresOf(views.high, views.rate, onset), ['hat', 'open-hat', 'cymbal']);
    return { kind: kindOfCategory(verdict.category), confidence: verdict.score };
  }
  const rings = gap > RING_CHECK_SEC + 0.01 && levelAfterPeak(views.high, onset, RING_CHECK_SEC) >= onset.peakDb - OPEN_WITHIN_DB;
  return { kind: rings ? 'open-hat' : 'hat', confidence: 0.7 };
}

/** The most dB a hat under a snare or clap may be quieter than the recording's own hats, and still count. */
const UNDER_HIT_MARGIN_DB = 3;
/** Hats of its own a recording needs before a hat is believed under a snare or clap. */
const MIN_OWN_HATS = 3;
/** A hat under a snare or clap is believed only with a hat of its own this close (s): a hat pattern is running there. */
const PATTERN_REACH_SEC = 0.45;
/** A start in the high view this soon after a hit (but not with it) is that hit's top end ringing, not a hat (s). */
const TAIL_OF_HIT_SEC = 0.06;
/** A high start's level 8 ms after its peak is within this of it: a hat rings, a kick's or tom's click and a clap's first burst do not (dB). */
const HAT_HOLD_SEC = 0.008;
const HAT_HOLD_DB = 14;

/** The middle value of a list (NaN for none). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[sorted.length >> 1] as number) : Number.NaN;
}

/** Hats and cymbals: starts in the high view that ring (a kick's click does not), not the tail of another hit. */
function hatHits(views: DrumViews, others: readonly HeardHit[]): HeardHit[] {
  const candidates: { onset: BandOnset; level: number; beside: boolean }[] = [];
  for (const onset of views.high.onsets) {
    const level = peakWithin(views.high, onset);
    if (levelAfterPeak(views.high, onset, HAT_HOLD_SEC) < onset.peakDb - HAT_HOLD_DB) continue;
    const isTail = others.some((h) => h.timeSec < onset.timeSec - SAME_HIT_SEC && onset.timeSec - h.timeSec < TAIL_OF_HIT_SEC && h.kind !== 'hat');
    if (isTail) continue;
    const beside = others.some((h) => h.kind !== 'kick' && h.kind !== 'tom' && Math.abs(h.timeSec - onset.timeSec) <= SAME_HIT_SEC);
    candidates.push({ onset, level, beside });
  }
  const lone = candidates.filter((c) => !c.beside).map((c) => c.level);
  const own = lone.length >= MIN_OWN_HATS ? median(lone) : null;
  const out: HeardHit[] = [];
  const loneTimes = candidates.filter((c) => !c.beside).map((c) => c.onset.timeSec);
  for (const c of candidates) {
    if (c.beside && (own === null || c.level < own - UNDER_HIT_MARGIN_DB)) continue;
    if (c.beside && !loneTimes.some((t) => Math.abs(t - c.onset.timeSec) <= PATTERN_REACH_SEC)) continue;
    const { kind, confidence } = hatKind(views, c.onset);
    out.push(hit(kind, c.onset.timeSec, newLevel(views.high, c.onset), confidence));
  }
  return out;
}

/** All the hits of a recording, with `strength` still holding each hit's level in dB. */
export function hitsFromViews(views: DrumViews): HeardHit[] {
  const kicks = kickHits(views);
  const toms = tomHits(views, kicks);
  const bodies = [...kicks, ...toms];
  const mids = midHits(views, leakModel(views.mid, bodies), bodies);
  const hats = hatHits(views, [...bodies, ...mids]);
  return [...bodies, ...mids, ...hats].sort((a, b) => a.timeSec - b.timeSec);
}
