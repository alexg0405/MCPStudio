/**
 * What kind of one-shot a sound is, from its measurements (`features.ts`): a score per category in 0..1, each a
 * product of soft memberships (a "ramp" is 0 at one number and 1 at another, linear between), so a borderline sound gets
 * two middling scores instead of one wrong sure answer. The file name can add to a category (`names.ts`).
 */
import type { SoundFeatures } from './features';
import { SAMPLE_CATEGORIES, type SampleCategory } from './types';

/** 0 at `a`, 1 at `b`, linear between, clamped; works in either direction (a > b falls). */
export function ramp(x: number, a: number, b: number): number {
  if (a === b) return x >= a ? 1 : 0;
  const u = (x - a) / (b - a);
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

/** How well a sound fits each category, 0..1 per category. */
export type CategoryScores = Record<SampleCategory, number>;

/** Every number the rules use, in one place. */
export const CLASSIFY = {
  /** Share of the energy under 250 Hz a kick / 808 / tom needs (ramp from none to full score). */
  lowShare: [0.55, 0.85],
  /** A kick's pitch is under ~75 Hz; toms start above ~85 Hz. */
  kickHz: [90, 72],
  tomHz: [70, 95],
  /** A ringing low sound (808): the level 0.3–0.5 s after the peak, or the time to fall 20 dB. */
  ring: { sustain: [0.38, 0.6], t20: [0.8, 1.1] },
  /** Closed hat falls 40 dB within ~0.15 s, open hat up to ~1 s, longer is a cymbal. */
  hatT40: { closed: [0.2, 0.13], open: [0.13, 0.2], openEnd: [1.1, 0.8], cymbal: [0.8, 1.1] },
} as const;

/** The shares and soft memberships every category's rule draws on, worked out once per sound. */
interface Shares {
  /** The energy shares of the six bands. */
  bands: readonly number[];
  /** Energy under 90 Hz + 90–250 Hz. */
  low: number;
  /** Energy 90–1000 Hz. */
  body: number;
  /** Energy under 1 kHz. */
  lowBody: number;
  /** Energy over 4 kHz. */
  hi: number;
  /** 0..1, how clearly pitched; and its opposite. */
  pitched: number;
  noisy: number;
  /** Spectral flatness, counted only where there is energy above the bass. */
  flat: number;
  /** 0..1, how much of the energy is low (a kick / 808 / tom needs it). */
  lowOf: number;
  /** 0..1, how long a low sound rings on. */
  ring: number;
}

function sharesOf(f: SoundFeatures): Shares {
  const b = f.bands;
  const sub = b[0] as number;
  const low = sub + (b[1] as number);
  const body = (b[1] as number) + (b[2] as number); // 90–1000 Hz
  const pitched = ramp(f.voiced, 0.45, 0.8);
  return {
    bands: b,
    low,
    body,
    lowBody: sub + body, // under 1 kHz
    hi: (b[4] as number) + (b[5] as number),
    pitched,
    noisy: 1 - pitched,
    // Flatness means something only where there is energy above the bass.
    flat: 1 - low > 0.25 ? f.flatness : 0.5,
    lowOf: ramp(low, CLASSIFY.lowShare[0], CLASSIFY.lowShare[1]),
    ring: Math.max(
      ramp(f.sustain, CLASSIFY.ring.sustain[0], CLASSIFY.ring.sustain[1]),
      ramp(f.t20, CLASSIFY.ring.t20[0], CLASSIFY.ring.t20[1]),
    ),
  };
}

/** Low sounds: a kick is short and drops in pitch, an 808 rings on, a tom is pitched, 80–400 Hz, glides down and is short. */
function lowSoundScores(f: SoundFeatures, m: Shares): Pick<CategoryScores, 'kick' | '808' | 'tom'> {
  const f0 = f.f0;
  const kickPitch = f0 === 0 ? 0.75 : ramp(f0, CLASSIFY.kickHz[0], CLASSIFY.kickHz[1]);
  const kick = m.lowOf * ramp(f.centroid, 520, 220) * kickPitch * (1 - m.ring);
  // A clean tone: noise in a rumble (an impact) makes its pitch wander.
  const clean = ramp(f.pitchSpread, 0.14, 0.06);
  const bassPitch = f0 === 0 ? 0.5 : ramp(f0, 160, 110);
  const bass808 = m.lowOf * ramp(f.centroid, 650, 300) * m.ring * bassPitch * (0.4 + 0.6 * m.pitched) * clean;
  const tom =
    m.pitched *
    ramp(f0, CLASSIFY.tomHz[0], CLASSIFY.tomHz[1]) *
    ramp(f0, 420, 280) *
    ramp(m.lowBody, 0.6, 0.85) *
    ramp(f.pitchDrop, 0.6, 2) *
    ramp(f.t40, 2.2, 1.4);
  return { kick, '808': bass808, tom };
}

/** How much of a sound is top-heavy noise (hats and cymbals are all top). */
function topHeaviness(m: Shares): number {
  return ramp(m.hi, 0.62, 0.85) * ramp(m.lowBody, 0.14, 0.05) * m.noisy;
}

/** Noisy hits: hats and cymbals are all top, a snare has a body, a clap is mid and stutters. */
function noisyHitScores(
  f: SoundFeatures,
  m: Shares,
): Pick<CategoryScores, 'hat' | 'open-hat' | 'cymbal' | 'clap' | 'snare'> {
  const topHeavy = topHeaviness(m);
  const hat = topHeavy * ramp(f.t40, CLASSIFY.hatT40.closed[0], CLASSIFY.hatT40.closed[1]);
  const openHat =
    topHeavy *
    ramp(f.t40, CLASSIFY.hatT40.open[0], CLASSIFY.hatT40.open[1]) *
    ramp(f.t40, CLASSIFY.hatT40.openEnd[0], CLASSIFY.hatT40.openEnd[1]);
  const cymbal =
    ramp(m.hi, 0.55, 0.85) *
    ramp(m.lowBody, 0.2, 0.06) *
    (0.5 + 0.5 * m.noisy) *
    ramp(f.t40, CLASSIFY.hatT40.cymbal[0], CLASSIFY.hatT40.cymbal[1]) *
    ramp(f.attackSec, 0.6, 0.2);
  const clapish = ramp(f.bursts, 1.5, 3);
  const clap =
    m.noisy *
    clapish *
    ramp(f.centroid, 800, 1400) *
    ramp(f.centroid, 6500, 4200) *
    ramp(m.hi, 0.7, 0.4) *
    ramp(f.t40, 0.9, 0.5);
  const snare =
    m.noisy *
    ramp(m.body, 0.05, 0.14) *
    ramp(m.hi + (m.bands[3] as number), 0.12, 0.3) *
    ramp(m.flat, 0.04, 0.12) *
    (1 - 0.7 * clapish) *
    ramp(f.t40, 0.06, 0.1) *
    ramp(f.t40, 0.9, 0.55) *
    ramp(f.centroid, 600, 1200) *
    ramp(m.hi, 0.9, 0.7);
  return { hat, 'open-hat': openHat, cymbal, clap, snare };
}

/** Pitched sounds: sustained and steady is tonal, a sung one wobbles a little, a short ping is a percussion hit. */
function pitchedScores(
  f: SoundFeatures,
  m: Shares,
  low: Pick<CategoryScores, '808' | 'tom'>,
): { tonal: number; vocal: number; ping: number } {
  const f0 = f.f0;
  const sustained = ramp(f.len40, 0.32, 0.7);
  const glides = ramp(f.pitchDrop, 1, 2) * ramp(f0, 320, 200);
  const not808 = 1 - low['808'];
  const tonal =
    m.pitched *
    sustained *
    not808 *
    (1 - low.tom) *
    (1 - glides) *
    ramp(f.pitchSpread, 0.5, 0.2) *
    (1 - 0.5 * ramp(f.pitchSpread, 0.12, 0.25));
  const vocal =
    0.62 *
    m.pitched *
    ramp(f.pitchSpread, 0.1, 0.22) *
    ramp(f.pitchSpread, 3, 1.5) *
    ramp(f.centroid, 380, 650) *
    ramp(f.centroid, 4200, 2600) *
    ramp(f0, 70, 120) *
    ramp(f0, 800, 550) *
    ramp(f.len40, 0.2, 0.4);
  const shortPing = ramp(f.len40, 0.9, 0.4);
  const ping = m.pitched * shortPing * ramp(f0, 150, 230) * ramp(f.pitchDrop, 3, 1.5) * (1 - low.tom);
  return { tonal, vocal, ping };
}

/** FX: noise that swells in, a long noisy wash, a pitched drone that is not a note. */
function fxScore(f: SoundFeatures, m: Shares): number {
  const swell = ramp(f.attackSec, 0.3, 0.8) * m.noisy;
  const wash = ramp(f.t40, 2, 3) * m.noisy * ramp(m.hi, 0.85, 0.6) * 0.8;
  const longNoise = ramp(f.len40, 1.2, 3.5) * m.noisy * (1 - topHeaviness(m)) * 0.6;
  const drone = m.lowOf * ramp(f.len40, 1.2, 2.2) * ramp(f.pitchSpread, 0.08, 0.16) * 0.9;
  return Math.max(swell, wash, longNoise, drone);
}

/** Scores of every category for a measured one-shot. */
export function categoryScores(f: SoundFeatures): CategoryScores {
  const m = sharesOf(f);
  const s = Object.fromEntries(SAMPLE_CATEGORIES.map((c) => [c, 0])) as CategoryScores;
  const low = lowSoundScores(f, m);
  Object.assign(s, low, noisyHitScores(f, m));
  const pitched = pitchedScores(f, m, low);
  s.tonal = pitched.tonal;
  s.vocal = pitched.vocal;
  // Anything short that is none of the above (a shaker, a snap, a block): a weak percussion guess.
  const elsewhere = 1 - Math.max(s.kick, s.snare, s.clap, s.hat, s['open-hat'], s.tom);
  s.perc = Math.max(pitched.ping * 0.8, 0.32 * ramp(f.len40, 1, 0.5) * elsewhere);
  s.fx = fxScore(f, m);
  return s;
}

/**
 * The classifier's verdict on a one-shot: the best category (null when none fits), how sure it is (0..1) and the score
 * of every category.
 */
export interface Classification {
  category: SampleCategory | null;
  /** 0..1 */
  confidence: number;
  scores: CategoryScores;
}

/**
 * The best category (null when nothing scores 0.25), with how sure it is: the score, held back when the runner-up is
 * close.
 */
export function classify(f: SoundFeatures): Classification {
  const scores = categoryScores(f);
  const ranked = [...SAMPLE_CATEGORIES].sort((a, c) => scores[c] - scores[a]);
  const top = ranked[0] as SampleCategory;
  const second = ranked[1] as SampleCategory;
  const best = scores[top];
  if (best < 0.25 || f.peak < 1e-4) return { category: null, confidence: Math.round(best * 100) / 100, scores };
  const margin = ramp(best - scores[second], 0, 0.35);
  const confidence = Math.min(1, best) * (0.5 + 0.5 * margin);
  return { category: top, confidence: Math.round(confidence * 100) / 100, scores };
}

/** Pairs of categories the sound alone cannot tell apart for sure (a shaker and a hat, an 808 and a long kick): a name decides between them. */
const CONFUSABLE: readonly (readonly [SampleCategory, SampleCategory])[] = [
  ['hat', 'perc'],
  ['open-hat', 'perc'],
  ['hat', 'open-hat'],
  ['open-hat', 'cymbal'],
  ['hat', 'cymbal'],
  ['kick', '808'],
  ['snare', 'clap'],
  ['snare', 'perc'],
  ['clap', 'perc'],
  ['tom', 'perc'],
  ['tom', 'kick'],
  ['tom', 'tonal'],
  ['tonal', 'vocal'],
  ['tonal', '808'],
  ['tonal', 'perc'],
  ['fx', 'cymbal'],
  ['fx', 'vocal'],
  ['fx', '808'],
  ['fx', 'tonal'],
  ['perc', 'fx'],
];
const confusable = (a: SampleCategory, b: SampleCategory) =>
  CONFUSABLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * The classification with what the file's name says: the name agreeing makes the answer surer; the name wins when the
 * sound was unsure, found nothing, or is one of the pairs it cannot tell apart (a "Shaker" that looks like a hat); a
 * clear sound that the name contradicts outright (a snare named "Kick") stays what it sounds like.
 */
export function applyHint(
  c: Classification,
  hint: { category?: SampleCategory; folderCategory?: SampleCategory },
): Classification & { basis: 'signal' | 'name' | 'both' } {
  const hinted = hint.category ?? hint.folderCategory;
  if (!hinted) return { ...c, basis: 'signal' };
  const strength = hint.category ? 0.85 : 0.7;
  if (c.category === hinted)
    return { ...c, confidence: Math.round(Math.max(c.confidence, strength) * 100) / 100, basis: 'both' };
  if (c.category === null || c.confidence < 0.5 || confusable(c.category, hinted) || c.scores[hinted] >= 0.3)
    return { ...c, category: hinted, confidence: Math.round(strength * 0.9 * 100) / 100, basis: 'name' };
  return { ...c, basis: 'signal' };
}
