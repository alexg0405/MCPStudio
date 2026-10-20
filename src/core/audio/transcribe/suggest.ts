/**
 * Which mode fits a recording: a quick look at the first half minute, for the dialog's starting choice. Four
 * measurements decide it: how much of the sound has a clear single pitch (a voice, a lead, a bass), how low its energy sits,
 * how many kinds of drum hit it has and how often (found with the drum listener: a kick alone is a bass, hats alone are not
 * a voice), and how many pitch classes sound at once (chords) with how sure its key is. Each mode gets a score and the best wins, with a plain reason. Pure and deterministic.
 */
import { chromagram } from '../../dj/chroma';
import { estimateKey } from '../../dj/key';
import { butterworth, filterInPlace } from '../../voice/filters';
import { trackPitch } from '../../voice/pitch';
import { detectDrums } from './drums';
import { levelCurveDb } from './levels';
import { MODE_LABELS, type TranscribeMode } from './types';

/** Seconds of the recording that are looked at. */
const LOOK_SEC = 30;
/** Frames within this many dB of the loudest are "sounding" (the pitch share is counted over them). */
const ACTIVE_DB = 40;
/** A pitch track below this median (Hz) with this share of its energy under 250 Hz is a bass. */
const BASS_MEDIAN_HZ = 160;
const BASS_LOW_SHARE = 0.65;
/** A key this sure marks tonal, harmonic material. */
const KEY_SURE = 0.35;

/** What the quick look found and what it suggests. */
export interface ModeSuggestion {
  mode: TranscribeMode;
  /** 0..1: how clearly the best mode beats the next. */
  confidence: number;
  /** A plain sentence for the dialog. */
  reason: string;
  /** Every mode's score (0..1). */
  scores: Record<TranscribeMode, number>;
  /** The numbers behind it. */
  measured: { pitchedShare: number; medianHz: number; lowShare: number; hitsPerSec: number; classes: number; keyConfidence: number };
}

/** The share of energy under 250 Hz. */
function lowEnergyShare(mono: Float32Array, sampleRate: number): number {
  const low = Float32Array.from(mono);
  filterInPlace(low, butterworth('lowpass', 4, 250, sampleRate));
  let all = 0;
  let under = 0;
  for (let i = 0; i < mono.length; i++) {
    all += (mono[i] as number) * (mono[i] as number);
    under += (low[i] as number) * (low[i] as number);
  }
  return all > 0 ? Math.min(1, under / all) : 0;
}

/** The share of the sounding 10 ms blocks that have one clear pitch, and the median pitch (Hz) of those. */
function pitchShare(mono: Float32Array, sampleRate: number): { share: number; medianHz: number } {
  const hop = Math.round(sampleRate * 0.01);
  const track = trackPitch(mono, sampleRate, { minHz: 40, maxHz: 1000, hop });
  const levels = levelCurveDb(mono, sampleRate);
  let top = -200;
  for (const l of levels) top = Math.max(top, l);
  let active = 0;
  const voiced: number[] = [];
  for (let i = 0; i < track.f0.length; i++) {
    if ((levels[Math.min(levels.length - 1, i)] as number) < top - ACTIVE_DB) continue;
    active++;
    if ((track.f0[i] as number) > 0) voiced.push(track.f0[i] as number);
  }
  voiced.sort((a, b) => a - b);
  return { share: active > 0 ? voiced.length / active : 0, medianHz: voiced.length ? (voiced[voiced.length >> 1] as number) : 0 };
}

/** Frames of the chromagram that are this loud against the loudest (energy share) count for the polyphony. */
const SOUNDING_SHARE = 0.2;
/** A pitch class is "sounding" in a frame when it is this share of the frame's strongest. */
const CLASS_SHARE = 0.4;

/** The median number of pitch classes sounding at once, and how sure the recording's key is, from one chromagram. */
function harmonyOf(mono: Float32Array, sampleRate: number): { classes: number; keyConfidence: number } {
  const chroma = chromagram(mono, sampleRate);
  let loudest = 0;
  for (let f = 0; f < chroma.frames; f++) loudest = Math.max(loudest, chroma.energy[f] as number);
  const counts: number[] = [];
  for (let f = 0; f < chroma.frames; f++) {
    if ((chroma.energy[f] as number) < SOUNDING_SHARE * loudest) continue;
    const strengths: number[] = [];
    for (let k = 0; k < 12; k++) strengths.push((chroma.treble[f * 12 + k] as number) + (chroma.bass[f * 12 + k] as number));
    const top = Math.max(...strengths);
    counts.push(strengths.filter((v) => v >= CLASS_SHARE * top).length);
  }
  counts.sort((x, y) => x - y);
  const key = estimateKey(chroma);
  return { classes: counts.length ? (counts[counts.length >> 1] as number) : 0, keyConfidence: key ? key.confidence : 0 };
}

/** Hits of a kind need this many (and this share of all hits) to count as a drum the recording has. */
const MIN_KIND_HITS = 4;
const MIN_KIND_SHARE = 0.15;
const DRUM_KINDS_THAT_COUNT: readonly string[] = ['kick', 'snare', 'clap', 'hat', 'open-hat', 'tom', 'cymbal'];

/** How many different kinds of drum the recording has, among the hits the listener is sure of. */
function drumKindsOf(hits: readonly { kind: string; confidence: number }[]): number {
  const sure = hits.filter((h) => h.confidence >= 0.6 && DRUM_KINDS_THAT_COUNT.includes(h.kind));
  const kinds = new Set(sure.map((h) => (h.kind === 'open-hat' ? 'hat' : h.kind === 'clap' ? 'snare' : h.kind)));
  let kept = 0;
  for (const kind of kinds) {
    const n = sure.filter((h) => (h.kind === 'open-hat' ? 'hat' : h.kind === 'clap' ? 'snare' : h.kind) === kind).length;
    if (n >= Math.max(MIN_KIND_HITS, MIN_KIND_SHARE * sure.length)) kept++;
  }
  return kept;
}

/** The score of each mode from the measurements. */
function scoresOf(m: ModeSuggestion['measured'], drumKinds: number): Record<TranscribeMode, number> {
  const isLow = m.medianHz > 0 && m.medianHz < BASS_MEDIAN_HZ && m.lowShare >= BASS_LOW_SHARE;
  const pitched = m.pitchedShare;
  const poly = Math.max(0, Math.min(1, (m.classes - 1.5) / 1.5));
  const pulse = Math.min(1, m.hitsPerSec / 1.5);
  const drums = drumKinds >= 2 ? pulse : drumKinds === 1 ? 0.6 * Math.min(1, m.hitsPerSec / 2) * (1 - pitched) : 0;
  const tonal = Math.min(1, m.keyConfidence / KEY_SURE);
  return {
    melody: (isLow ? pitched * 0.35 : pitched) * (1 - 0.8 * poly) * (1 - 0.5 * drums),
    bass: (isLow ? pitched : pitched * 0.1) * (1 - 0.5 * poly) * (1 - 0.5 * drums),
    drums,
    chords: poly * (0.4 + 0.6 * tonal) * (1 - 0.7 * drums),
  };
}

/** The sentence for a mode and the numbers. */
function reasonFor(mode: TranscribeMode, m: ModeSuggestion['measured']): string {
  switch (mode) {
    case 'melody':
      return 'It is mostly one clear note at a time, like a voice or a lead.';
    case 'bass':
      return 'It is one low line (under about 160 Hz), like a bass.';
    case 'drums':
      return `It has ${m.hitsPerSec.toFixed(1)} drum hits a second and little that holds a pitch.`;
    case 'chords':
      return 'It has several notes sounding together in a clear key, like keys or pads.';
  }
}

/** Looks at a recording and suggests the mode that fits it. */
export function suggestMode(mono: Float32Array, sampleRate: number): ModeSuggestion {
  const slice = mono.length > LOOK_SEC * sampleRate ? mono.subarray(0, Math.round(LOOK_SEC * sampleRate)) : mono;
  const seconds = Math.max(1e-3, slice.length / sampleRate);
  const { share, medianHz } = pitchShare(slice, sampleRate);
  const drums = detectDrums(slice, sampleRate);
  const harmony = harmonyOf(slice, sampleRate);
  const measured = {
    pitchedShare: Math.round(share * 100) / 100,
    medianHz: Math.round(medianHz),
    lowShare: Math.round(lowEnergyShare(slice, sampleRate) * 100) / 100,
    hitsPerSec: Math.round((drums.hits.filter((h) => h.confidence >= 0.6).length / seconds) * 10) / 10,
    classes: harmony.classes,
    keyConfidence: Math.round(harmony.keyConfidence * 100) / 100,
  };
  const scores = scoresOf(measured, drumKindsOf(drums.hits));
  const ranked = (Object.keys(scores) as TranscribeMode[]).sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0] as TranscribeMode;
  const confidence = Math.max(0, Math.min(1, scores[best] - scores[ranked[1] as TranscribeMode]) + 0.2 * scores[best]);
  return { mode: best, confidence: Math.round(confidence * 100) / 100, reason: `${MODE_LABELS[best].label}: ${reasonFor(best, measured)}`, scores, measured };
}
