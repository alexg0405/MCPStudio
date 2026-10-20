/**
 * The four views of a drum recording with their level curves and the starts found in each, and the small questions the hit
 * rules ask of them (what is near this time, how loud, what the sample browser's classifier says about this slice). Pure.
 */
import { categoryScores } from '../../samples/classify';
import { extractFeatures } from '../../samples/features';
import type { SampleCategory } from '../../samples/types';
import { findOnsets, topDb, type BandOnset, type BandViews, type Envelope, type OnsetRule } from './drum-bands';

/** One view with its level curve and its starts. */
export interface View {
  signal: Float32Array;
  env: Envelope;
  onsets: BandOnset[];
}

/** The views of a recording, ready to be read. */
export interface DrumViews {
  rate: number;
  sub: View;
  low: View;
  mid: View;
  high: View;
}

type RuleName = 'sub' | 'low' | 'mid' | 'high';

/** The rise over the quietest block before that makes a start, at sensitivity 0 and 1 (dB). */
const RISE_DB: Readonly<Record<RuleName, readonly [number, number]>> = { sub: [8, 5], low: [10, 6], mid: [10, 6], high: [10, 6] };
/** How far under the view's loudest moment a start may be and still count, at sensitivity 0 and 1 (dB). */
const RANGE_DB = [26, 40] as const;
/** Blocks (2 ms) looked back for the quietest level. */
const LOOK_BACK: Readonly<Record<RuleName, number>> = { sub: 12, low: 12, mid: 8, high: 6 };
/** The soonest a second start counts after one (s). */
const MIN_GAP_SEC: Readonly<Record<RuleName, number>> = { sub: 0.06, low: 0.05, mid: 0.04, high: 0.03 };

const lerp = (pair: readonly [number, number], t: number) => pair[0] + (pair[1] - pair[0]) * t;

/** The onset rule of one view at a sensitivity. */
function ruleOf(name: RuleName, sensitivity: number, blockSec: number): OnsetRule {
  return {
    lookBack: LOOK_BACK[name],
    riseDb: lerp(RISE_DB[name], sensitivity),
    rangeDb: lerp(RANGE_DB, sensitivity),
    minGapBlocks: Math.round(MIN_GAP_SEC[name] / blockSec),
  };
}

/** Finds the starts in each of the views. */
export function readViews(views: BandViews, envelopes: Record<keyof BandViews, Envelope>, rate: number, sensitivity: number): DrumViews {
  /** `name` is the view the sound is taken from; `finder` the one whose level curve the starts are looked for in. */
  const make = (name: RuleName, finder: keyof BandViews = name): View => ({
    signal: views[name],
    env: envelopes[finder],
    onsets: findOnsets(envelopes[finder], ruleOf(name, sensitivity, envelopes[finder].blockSec), topDb(envelopes[finder])),
  });
  return { rate, sub: make('sub'), low: make('low'), mid: make('mid', 'midBand'), high: make('high') };
}

/** Two starts this close (s) are the same hit seen in two views. */
export const SAME_HIT_SEC = 0.025;
/** A lead before the start in a slice, so the classifier sees the attack (s). */
const SLICE_LEAD_SEC = 0.003;
/** The longest slice the classifier is given (s). */
const SLICE_MAX_SEC = 0.45;
/** Blocks (2 ms) a start's peak level is looked for in after it (30 ms). */
const PEAK_BLOCKS = 15;

/** The time of the next start after `timeSec` in a view (Infinity when none). */
export function nextStart(onsets: readonly BandOnset[], timeSec: number): number {
  for (const o of onsets) if (o.timeSec > timeSec + 0.01) return o.timeSec;
  return Infinity;
}

/** The classifier's scores for the slice of a view that holds one sound: from its start to the next start in that view. */
export function scoresOf(view: View, rate: number, onset: BandOnset): Record<SampleCategory, number> {
  const from = Math.max(0, Math.round((onset.timeSec - SLICE_LEAD_SEC) * rate));
  const stop = Math.min(onset.timeSec + SLICE_MAX_SEC, nextStart(view.onsets, onset.timeSec) - 0.003);
  const to = Math.max(from + Math.round(0.02 * rate), Math.min(view.signal.length, Math.round(stop * rate)));
  return categoryScores(extractFeatures(view.signal.subarray(from, to), rate));
}

/** The best of some categories by score, with its score. */
export function bestOf(scores: Record<SampleCategory, number>, among: readonly SampleCategory[]): { category: SampleCategory; score: number } {
  let best = among[0] as SampleCategory;
  for (const c of among) if (scores[c] > scores[best]) best = c;
  return { category: best, score: scores[best] };
}

/** The loudest level of a view's curve from a block on, over `blocks` blocks (dB). */
export function levelFrom(view: View, fromBlock: number, blocks: number): number {
  let peak = -Infinity;
  for (let b = Math.max(0, fromBlock); b < Math.min(view.env.db.length, fromBlock + blocks); b++) peak = Math.max(peak, view.env.db[b] as number);
  return peak;
}

/** The loudest level of a view within 30 ms of a start (dB). */
export function peakWithin(view: View, onset: BandOnset): number {
  return Math.max(onset.peakDb, levelFrom(view, Math.round(onset.timeSec / view.env.blockSec), PEAK_BLOCKS));
}

/**
 * How loud the new sound is (dB): its peak less what was still sounding before it (a kick that lands on the tail of the
 * last one is not as loud as the sum of the two). Amplitudes subtract; the result is never below 30 dB under the peak.
 */
export function newLevel(view: View, onset: BandOnset): number {
  const peak = peakWithin(view, onset);
  const added = Math.pow(10, peak / 20) - Math.pow(10, onset.lowDb / 20);
  return Math.max(peak - 30, 20 * Math.log10(Math.max(added, 1e-9)));
}

/** The level of a view `afterSec` after a start's peak (dB). */
export function levelAfterPeak(view: View, onset: BandOnset, afterSec: number): number {
  const b = Math.min(view.env.db.length - 1, onset.peakBlock + Math.round(afterSec / view.env.blockSec));
  return view.env.db[b] as number;
}
