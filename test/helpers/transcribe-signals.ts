/**
 * Synthetic recordings with known contents for the Convert to MIDI tests: drum loops built from the Drum Pads' own sounds
 * (kick, snare, clap, hats, toms, crash), basslines under a kit, chord pads, and a clip timeline for the planner. Every
 * helper returns the truth next to the audio, so a test compares what was heard with what was played. Deterministic.
 */
import { PPQ, constantTempo } from '../../src/core/time/ppq';
import { playbackMode } from '../../src/core/audio/playback';
import type { ClipTimeline } from '../../src/core/audio/transcribe/timeline';
import type { DrumKind } from '../../src/core/audio/transcribe/types';
import { sing, type SungNote } from './sung';
import { builtinSound } from '../../src/plugins/builtin/drum-pads/sounds.kernel';
import type { SoundId } from '../../src/plugins/builtin/drum-pads/params';

/** The rate the recordings are made at. */
export const TRANSCRIBE_RATE = 44100;

/** One drum hit that was played: when (seconds), what, and how hard (0..1). */
export interface TruthHit {
  timeSec: number;
  kind: DrumKind;
  gain: number;
  /** Which of the Drum Pads' sounds played it. */
  sound: SoundId;
}

/** A hit in a pattern: beats from the start of the loop, the sound, and how hard. */
export type PatternHit = [beat: number, sound: SoundId, gain?: number];

/** The kind of hit each of the Drum Pads' sounds is. */
const KIND_OF: Partial<Record<SoundId, DrumKind>> = {
  kick: 'kick',
  kick808: 'kick',
  kickHard: 'kick',
  snare: 'snare',
  snare2: 'snare',
  clap: 'clap',
  hatClosed: 'hat',
  hatPedal: 'hat',
  hatOpen: 'open-hat',
  crash: 'cymbal',
  ride: 'cymbal',
  tomLow: 'tom',
  tomMid: 'tom',
  tomHigh: 'tom',
  rim: 'perc',
  cowbell: 'perc',
};

/** The beats of a bar of 16ths: positions 0, 0.25, 0.5 … 3.75. */
const sixteenths = (): number[] => Array.from({ length: 16 }, (_, i) => i / 4);

/** Well-known one-bar patterns (4/4). Beats count from 0. */
export const BEATS: Readonly<Record<string, PatternHit[]>> = {
  house: [
    ...[0, 1, 2, 3].map((b): PatternHit => [b, 'kick', 1]),
    [1, 'clap', 0.9],
    [3, 'clap', 0.9],
    ...[0.5, 1.5, 2.5].map((b): PatternHit => [b, 'hatClosed', 0.6]),
    [3.5, 'hatOpen', 0.7],
  ],
  boomBap: [
    [0, 'kick', 1],
    [1.5, 'kick', 0.8],
    [2.5, 'kick', 0.9],
    [1, 'snare', 0.95],
    [3, 'snare', 0.95],
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b): PatternHit => [b, 'hatClosed', b % 1 === 0 ? 0.7 : 0.5]),
  ],
  trap: [
    [0, 'kick', 1],
    [1.75, 'kick', 0.8],
    [2.25, 'kick', 0.85],
    [2, 'snare', 0.95],
    ...sixteenths().map((b): PatternHit => [b, 'hatClosed', b % 0.5 === 0 ? 0.6 : 0.4]),
  ],
  rock: [
    [0, 'kick', 1],
    [2, 'kick', 1],
    [2.5, 'kick', 0.8],
    [1, 'snare', 1],
    [3, 'snare', 1],
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b): PatternHit => [b, 'hatClosed', 0.6]),
  ],
  fill: [
    [0, 'kick', 1],
    [1, 'snare', 0.95],
    [2, 'kick', 1],
    [3, 'tomHigh', 0.9],
    [3.25, 'tomHigh', 0.85],
    [3.5, 'tomMid', 0.9],
    [3.75, 'tomLow', 0.95],
  ],
};

/** A drum loop and the hits that were played in it. */
export interface DrumLoop {
  mono: Float32Array;
  hits: TruthHit[];
  rate: number;
}

/** Settings of `drumLoop`. */
export interface DrumLoopOptions {
  bpm: number;
  /** One pattern per bar, repeated to fill `bars`. */
  patterns: readonly PatternHit[][];
  bars: number;
  rate?: number;
  /** Delay of every odd 16th, as a share of half a step (0..1): a swung groove. */
  swing?: number;
  /** Random timing error of each hit (ms, ± this, seeded). */
  jitterMs?: number;
  /** Other sound mixed in (e.g. a bass), same length. */
  under?: Float32Array;
}

/** A small seeded random generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a beat position plays once the odd 16ths are late by `swing`. */
function swungBeat(beat: number, swing: number): number {
  const step = beat * 4;
  const nearest = Math.round(step);
  return Math.abs(step - nearest) < 1e-9 && nearest % 2 === 1 ? beat + (swing * 0.5) / 4 : beat;
}

/** Renders a drum loop from the Drum Pads' own sounds. */
export function drumLoop(options: DrumLoopOptions): DrumLoop {
  const rate = options.rate ?? TRANSCRIBE_RATE;
  const secPerBeat = 60 / options.bpm;
  const total = Math.round(options.bars * 4 * secPerBeat * rate) + Math.round(1.2 * rate);
  const mono = new Float32Array(total);
  if (options.under) mono.set(options.under.subarray(0, total));
  const rnd = random(77);
  const jitter = options.jitterMs ?? 0;
  const hits: TruthHit[] = [];
  const cache = new Map<SoundId, Float32Array>();
  for (let bar = 0; bar < options.bars; bar++) {
    const pattern = options.patterns[bar % options.patterns.length] as PatternHit[];
    for (const [beat, sound, gain = 1] of pattern) {
      const sample = cache.get(sound) ?? (builtinSound(sound, rate) as Float32Array);
      cache.set(sound, sample);
      const played = swungBeat(beat, options.swing ?? 0);
      const timeSec = (bar * 4 + played) * secPerBeat + ((rnd() * 2 - 1) * jitter) / 1000;
      const at = Math.max(0, Math.round(timeSec * rate));
      for (let i = 0; i < sample.length && at + i < total; i++) mono[at + i] = (mono[at + i] as number) + gain * (sample[i] as number);
      hits.push({ timeSec: at / rate, kind: KIND_OF[sound] as DrumKind, gain, sound });
    }
  }
  return { mono, hits, rate };
}

/** A clip timeline for the planner: a clip at `start` ticks playing from `offsetSec`, at a constant tempo, no follow. */
export function timelineOf(
  options: { bpm?: number; start?: number; length?: number; offsetSec?: number; swing?: number; follow?: { sourceBpm: number; stretch: 'resample' | 'stretch' } } = {},
): ClipTimeline {
  const bpm = options.bpm ?? 120;
  const mode = playbackMode(
    options.follow ? { pitch: 0, reverse: false, stretch: options.follow.stretch, sourceBpm: options.follow.sourceBpm } : { pitch: 0, reverse: false },
  );
  return {
    clip: { start: options.start ?? 0, length: options.length ?? PPQ * 4 * 8, offsetSec: options.offsetSec ?? 0 },
    mode,
    tempo: constantTempo(bpm),
    beatTicks: PPQ,
    barTicks: PPQ * 4,
    songSwing: options.swing ?? 0,
  };
}

/** How a list of heard hits compares with the hits that were played. */
export interface HitScore {
  played: number;
  heard: number;
  /** Played hits with a heard hit of the same kind within the tolerance. */
  rightKind: number;
  /** Played hits with a heard hit of any kind within the tolerance. */
  found: number;
  /** Heard hits that match no played hit of their kind. */
  extra: number;
  /** The timing error of every right-kind hit (ms). */
  errorsMs: number[];
  /** Plain lines about every miss and extra, for a failure message. */
  problems: string[];
}

/** Matches each played hit with the nearest unused heard hit of its kind (then any kind) within `toleranceSec`. */
export function scoreHits(played: readonly { timeSec: number; kind: string }[], heard: readonly { timeSec: number; kind: string }[], toleranceSec = 0.015): HitScore {
  const used = new Set<number>();
  const score: HitScore = { played: played.length, heard: heard.length, rightKind: 0, found: 0, extra: 0, errorsMs: [], problems: [] };
  const nearest = (hit: { timeSec: number; kind: string }, sameKind: boolean): number => {
    let best = -1;
    heard.forEach((h, i) => {
      if (used.has(i) || (sameKind && h.kind !== hit.kind)) return;
      if (Math.abs(h.timeSec - hit.timeSec) > toleranceSec) return;
      if (best < 0 || Math.abs(h.timeSec - hit.timeSec) < Math.abs((heard[best] as { timeSec: number }).timeSec - hit.timeSec)) best = i;
    });
    return best;
  };
  for (const hit of played) {
    const same = nearest(hit, true);
    if (same >= 0) {
      used.add(same);
      score.rightKind++;
      score.found++;
      score.errorsMs.push(Math.abs((heard[same] as { timeSec: number }).timeSec - hit.timeSec) * 1000);
      continue;
    }
    const any = nearest(hit, false);
    if (any >= 0) {
      used.add(any);
      score.found++;
      score.problems.push(`${hit.timeSec.toFixed(3)} ${hit.kind} heard as ${(heard[any] as { kind: string }).kind}`);
    } else score.problems.push(`${hit.timeSec.toFixed(3)} ${hit.kind} missed`);
  }
  heard.forEach((h, i) => {
    if (used.has(i)) return;
    score.extra++;
    score.problems.push(`${h.timeSec.toFixed(3)} extra ${h.kind}`);
  });
  return score;
}

/** One note that was played: seconds, MIDI key (60 = C4) and level. */
export interface TruthNote {
  fromSec: number;
  toSec: number;
  midi: number;
  level: number;
}

/** A bass note in a pattern: beats from the start of the bar, length in beats, MIDI key. */
export type BassStep = [beat: number, lengthBeats: number, midi: number];

/** A bassline: one list of steps per bar (repeated to fill the bars), played with a sine and two overtones. */
export function bassLine(options: { bpm: number; bars: number; steps: readonly (readonly BassStep[])[]; rate?: number; level?: number; seconds?: number }): { mono: Float32Array; notes: TruthNote[] } {
  const rate = options.rate ?? TRANSCRIBE_RATE;
  const secPerBeat = 60 / options.bpm;
  const total = Math.round((options.seconds ?? options.bars * 4 * secPerBeat + 1.2) * rate);
  const mono = new Float32Array(total);
  const notes: TruthNote[] = [];
  const level = options.level ?? 0.5;
  for (let bar = 0; bar < options.bars; bar++) {
    const steps = options.steps[bar % options.steps.length] as readonly BassStep[];
    for (const [beat, length, midi] of steps) {
      const fromSec = (bar * 4 + beat) * secPerBeat;
      const toSec = fromSec + length * secPerBeat;
      const hz = 440 * Math.pow(2, (midi - 69) / 12);
      const a = Math.round(fromSec * rate);
      const b = Math.min(total, Math.round(toSec * rate));
      for (let i = a; i < b; i++) {
        const t = (i - a) / rate;
        const attack = Math.min(1, t / 0.006);
        const release = Math.min(1, (b - i) / (0.02 * rate));
        const shape = attack * release * Math.exp(-t / 0.45);
        const phase = 2 * Math.PI * hz * t;
        mono[i] = (mono[i] as number) + level * shape * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)) * 0.6;
      }
      notes.push({ fromSec, toSec, midi, level });
    }
  }
  return { mono, notes };
}

/** The sum of recordings of the same rate (shorter ones end early). */
export function mixSignals(...parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const part of parts) for (let i = 0; i < part.length; i++) out[i] = (out[i] as number) + (part[i] as number);
  return out;
}

/** A chord played: its root (MIDI), the semitones above it, where it starts (beats) and how long it lasts (beats). */
export interface PlayedChord {
  root: number;
  notes: readonly number[];
  fromBeat: number;
  beats: number;
  /** The name `parseChord` reads, for comparing with what was found. */
  name: string;
}

/** Chords as soft pads: each note a few harmonics with a slow attack, several notes together. */
export function chordPads(options: { bpm: number; chords: readonly PlayedChord[]; rate?: number; level?: number; seconds?: number }): Float32Array {
  const rate = options.rate ?? TRANSCRIBE_RATE;
  const secPerBeat = 60 / options.bpm;
  const last = options.chords.reduce((m, c) => Math.max(m, c.fromBeat + c.beats), 0);
  const total = Math.round((options.seconds ?? last * secPerBeat + 0.5) * rate);
  const out = new Float32Array(total);
  const level = options.level ?? 0.12;
  for (const chord of options.chords) {
    const a = Math.round(chord.fromBeat * secPerBeat * rate);
    const b = Math.min(total, Math.round((chord.fromBeat + chord.beats) * secPerBeat * rate));
    for (const interval of chord.notes) {
      const hz = 440 * Math.pow(2, (chord.root + interval - 69) / 12);
      for (let i = a; i < b; i++) {
        const t = (i - a) / rate;
        const env = Math.min(1, t / 0.03) * Math.min(1, (b - i) / (0.04 * rate));
        let v = 0;
        for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * hz * h * t) / h;
        out[i] = (out[i] as number) + level * env * v;
      }
    }
  }
  return out;
}

/** A progression of chords of equal length from names such as "Am", "F", "C", "G7": one chord per `beatsEach` beats. */
export function progression(names: readonly string[], options: { rootOctave?: number; beatsEach?: number } = {}): PlayedChord[] {
  const shapes: Record<string, readonly number[]> = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7] };
  const pitchClass: Record<string, number> = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
  const beatsEach = options.beatsEach ?? 4;
  return names.map((name, i) => {
    const match = /^([A-G][b#]?)(.*)$/.exec(name) as RegExpExecArray;
    const root = (options.rootOctave ?? 4) * 12 + 12 + (pitchClass[match[1] as string] as number);
    return { root, notes: shapes[match[2] as string] as readonly number[], fromBeat: i * beatsEach, beats: beatsEach, name };
  });
}

/** A sung line: [midi, seconds, rest after in seconds, level] per note, with vibrato, from a start time. */
export type SungStep = [midi: number, seconds: number, restAfter?: number, level?: number];

/** A sung melody (the pitch-correction tests' synthetic voice) with its truth: every note starts on its own pitch. */
export function sungMelody(options: { steps: readonly SungStep[]; start?: number; vibratoCents?: number; rate?: number; tail?: number }): { mono: Float32Array; notes: TruthNote[] } {
  const rate = options.rate ?? TRANSCRIBE_RATE;
  const vibrato = (options.vibratoCents ?? 25) / 100;
  const notes: TruthNote[] = [];
  const sung: SungNote[] = [];
  let t = options.start ?? 0.2;
  for (const [midi, seconds, rest = 0, level = 0.3] of options.steps) {
    sung.push({ from: t, to: t + seconds, midi: (tt) => midi + vibrato * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, tt * 4), level });
    notes.push({ fromSec: t, toSec: t + seconds, midi, level });
    t += seconds + rest;
  }
  return { mono: sing(sung, rate, t + (options.tail ?? 0.5)), notes };
}

/** How a list of heard notes compares with the notes that were played. */
export interface NoteScore {
  played: number;
  heard: number;
  /** Played notes with a heard note within the onset tolerance and the pitch tolerance (semitones). */
  right: number;
  /** Heard notes that match no played note. */
  extra: number;
  /** Onset error of every right note (ms). */
  errorsMs: number[];
  problems: string[];
}

/** Matches each played note with the nearest unused heard note within `onsetSec` whose pitch is within `semitones`. */
export function scoreNotes(
  played: readonly { fromSec: number; midi: number }[],
  heard: readonly { fromSec: number; pitch: number }[],
  onsetSec = 0.02,
  semitones = 0.5,
): NoteScore {
  const used = new Set<number>();
  const score: NoteScore = { played: played.length, heard: heard.length, right: 0, extra: 0, errorsMs: [], problems: [] };
  for (const note of played) {
    let best = -1;
    heard.forEach((h, i) => {
      if (used.has(i) || Math.abs(h.fromSec - note.fromSec) > onsetSec || Math.abs(h.pitch - note.midi) >= semitones) return;
      if (best < 0 || Math.abs(h.fromSec - note.fromSec) < Math.abs((heard[best] as { fromSec: number }).fromSec - note.fromSec)) best = i;
    });
    if (best >= 0) {
      used.add(best);
      score.right++;
      score.errorsMs.push(Math.abs((heard[best] as { fromSec: number }).fromSec - note.fromSec) * 1000);
    } else score.problems.push(`${note.fromSec.toFixed(3)} s, note ${note.midi}, not found`);
  }
  heard.forEach((h, i) => {
    if (used.has(i)) return;
    score.extra++;
    score.problems.push(`${h.fromSec.toFixed(3)} s, pitch ${h.pitch.toFixed(2)}, extra`);
  });
  return score;
}
