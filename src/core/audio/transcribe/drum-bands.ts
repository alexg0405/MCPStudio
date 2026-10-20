/**
 * The four views of a drum loop the hit finder works on, and how a hit's start is found in one of them.
 *
 *   sub  (< 100 Hz)        kicks and 808s: the only drums with a body this low
 *   low  (80–400 Hz)       toms and the body of a snare
 *   mid  (> 330 Hz)        snares, claps and rim shots, with the kick taken out (a steep filter: a kick's harmonics reach 300 Hz)
 *   high (> 7 kHz)         hats and cymbals, with everything else taken out
 *
 * A hit that sounds together with another (a hat over a kick) shows up in its own view, so each kind is found where
 * the others are not. Pure, no DOM.
 */
import { butterworth, filterInPlace } from '../../voice/filters';

/** The corner frequencies of the views (Hz). */
export const VIEW_HZ = { subTop: 100, lowBottom: 80, lowTop: 400, midBottom: 330, midTop: 5500, highBottom: 7000 } as const;

/** The four views of one mono signal at one rate. */
export interface BandViews {
  sub: Float32Array;
  low: Float32Array;
  /** Everything above 330 Hz: what the classifier is shown for snares and claps (a snare's top is part of it). */
  mid: Float32Array;
  /** 330 Hz to 5.5 kHz: where the starts of snares and claps are looked for, so a hat's top end is not one. */
  midBand: Float32Array;
  high: Float32Array;
}

/** A filtered copy of a signal. */
function filtered(x: Float32Array, steps: readonly (readonly ['lowpass' | 'highpass', number, (2 | 4 | 8)?])[], sampleRate: number): Float32Array {
  const out = Float32Array.from(x);
  for (const [type, hz, order = 4] of steps) filterInPlace(out, butterworth(type, order, hz, sampleRate));
  return out;
}

/** The sub, low, mid and high views of a mono signal. */
export function bandViews(mono: Float32Array, sampleRate: number): BandViews {
  const nyquistSafe = Math.min(VIEW_HZ.highBottom, sampleRate * 0.4);
  return {
    sub: filtered(mono, [['lowpass', VIEW_HZ.subTop]], sampleRate),
    low: filtered(mono, [['highpass', VIEW_HZ.lowBottom], ['lowpass', VIEW_HZ.lowTop]], sampleRate),
    mid: filtered(mono, [['highpass', VIEW_HZ.midBottom, 8]], sampleRate),
    midBand: filtered(mono, [['highpass', VIEW_HZ.midBottom, 8], ['lowpass', VIEW_HZ.midTop]], sampleRate),
    high: filtered(mono, [['highpass', nyquistSafe]], sampleRate),
  };
}

/** The level of a signal block by block (RMS, dB), and how long a block is. */
export interface Envelope {
  db: Float32Array;
  /** Samples per block. */
  block: number;
  blockSec: number;
}

/** Seconds per block of the envelopes the onset finder reads. */
const BLOCK_SEC = 0.002;
/** The level of digital silence (dB). */
const FLOOR_DB = -140;
/**
 * How long a block's peak is held in each view (s). A low sound's level ripples at its own pitch (a 50 Hz kick has a
 * 10 ms half cycle), so the envelope holds each peak for about a half cycle: it rises the moment a sound starts (the hold
 * looks back, never ahead) and does not wobble.
 */
export const HOLD_SEC: Readonly<Record<keyof BandViews, number>> = { sub: 0.014, low: 0.01, mid: 0.004, midBand: 0.004, high: 0.002 };

/** The 2 ms peak level curve of a signal, each peak held for `holdSec`. */
export function envelopeOf(x: Float32Array, sampleRate: number, holdSec: number): Envelope {
  const block = Math.max(8, Math.round(BLOCK_SEC * sampleRate));
  const blocks = Math.ceil(x.length / block);
  const peaks = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const end = Math.min(x.length, (b + 1) * block);
    let peak = 0;
    for (let i = b * block; i < end; i++) peak = Math.max(peak, Math.abs(x[i] as number));
    peaks[b] = peak;
  }
  const hold = Math.max(1, Math.round(holdSec / (block / sampleRate)));
  const db = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let held = 0;
    for (let k = Math.max(0, b - hold + 1); k <= b; k++) held = Math.max(held, peaks[k] as number);
    db[b] = Math.max(FLOOR_DB, 20 * Math.log10(held + 1e-9));
  }
  return { db, block, blockSec: block / sampleRate };
}

/** A start found in one view: when (seconds), how loud the sound gets within 30 ms (dB) and how far it rose (dB). */
export interface BandOnset {
  timeSec: number;
  peakDb: number;
  riseDb: number;
  /** The quietest level in the blocks before the start (dB): what was still sounding, which the new sound adds to. */
  lowDb: number;
  /** The block the attack's peak is in. */
  peakBlock: number;
}

/** What makes a rise an onset in one view. */
export interface OnsetRule {
  /** Blocks looked back for the quietest level to measure the rise from. */
  lookBack: number;
  /** The rise over that level (dB). */
  riseDb: number;
  /** Onsets quieter than the loudest moment of the view by more than this are ignored (dB). */
  rangeDb: number;
  /** A start this soon (blocks) after the last one is part of it: a clap's four bursts are one hit. */
  minGapBlocks: number;
}

/** The loudest level of an envelope (dB). */
export function topDb(env: Envelope): number {
  let top = FLOOR_DB;
  for (let b = 0; b < env.db.length; b++) top = Math.max(top, env.db[b] as number);
  return top;
}

/** The block where the attack that peaks at `peak` begins: the first block of the rise that is within 3 dB of the pre-level climb. */
function attackStart(db: Float32Array, first: number, low: number, peakLevel: number): number {
  const threshold = low + 0.25 * (peakLevel - low);
  let b = first;
  while (b > 0 && (db[b - 1] as number) >= threshold) b--;
  return b;
}

/** Finds the starts of sounds in an envelope: a rise of `riseDb` over the quietest of the blocks before, near the top level. */
export function findOnsets(env: Envelope, rule: OnsetRule, fromTopDb = topDb(env)): BandOnset[] {
  const { db } = env;
  const found: BandOnset[] = [];
  let resumeAt = 0;
  let lastPeak = 0;
  let lastStart = -Infinity;
  for (let b = 0; b < db.length; b++) {
    if (b < resumeAt) continue;
    const level = db[b] as number;
    if (level < fromTopDb - rule.rangeDb) continue;
    // The quietest level before: not looking back past the last attack's peak, whose decay is no "quiet" to rise from.
    // Before the first block there is silence (a loop that starts on a hit starts with it).
    let low = b === 0 ? FLOOR_DB : Infinity;
    for (let k = Math.max(b - rule.lookBack, lastPeak); k < b; k++) low = Math.min(low, db[k] as number);
    if (level - low < rule.riseDb) continue;
    // Walk up to the peak of this attack (the rise is over when the level stops climbing).
    let peak = b;
    while (peak + 1 < db.length && (db[peak + 1] as number) >= (db[peak] as number)) peak++;
    const start = attackStart(db, b, low, db[peak] as number);
    resumeAt = peak + 1;
    lastPeak = peak;
    // A start this soon after the last is part of it (a clap's bursts).
    if (start < lastStart + rule.minGapBlocks) continue;
    lastStart = start;
    found.push({ timeSec: start * env.blockSec, peakDb: db[peak] as number, riseDb: (db[peak] as number) - low, lowDb: low, peakBlock: peak });
  }
  return found;
}
