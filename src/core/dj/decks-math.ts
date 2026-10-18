/**
 * The math of DJ live decks, pure (no DOM, no audio): crossfader and fader curves, the EQ and filter
 * knobs' mapping, tempo and beat-phase sync (half/double-time aware), loops and beat jumps on the beat
 * grid, the CDJ cue rules and the jog wheel's speeds. The deck engine (`app/dj/decks.ts`), the audio
 * thread kernel and the UI all use these, so a number means the same everywhere.
 *
 * Units: seconds of the song file, BPM, pitch as a fraction (+0.08 = 8 % faster), dB, filter −1…1.
 */

export type CrossfaderCurve = 'smooth' | 'sharp';
/** Which side of the crossfader a deck sits on, or "thru" for a deck the crossfader does not touch. */
export type CrossSide = 'A' | 'B' | 'thru';

/**
 * The beat grid the decks use: a fixed tempo from the first downbeat (`TrackAnalysis.grid`), or, for a song whose tempo
 * drifts (a live drummer, an old record: the analysis tracked its `beats`), the tracked beats as a `BeatMap`, from which
 * loops, jumps, cues and sync read the local beat. Without a map everything is the fixed grid.
 */
export interface DeckGrid {
  bpm: number;
  /** Source seconds of beat 1 of a bar. */
  firstDownbeat: number;
  /** The tracked beats (seconds) as a clock, when the song has enough of them (`beats` is what it was made from). */
  map?: BeatMap;
  beats?: readonly number[];
}

/** Fewest tracked beats worth following (a handful says nothing about a drift). */
export const MIN_TRACKED_BEATS = 8;

/** A grid for a song: the fixed one, with the tracked beats when the analysis has enough of them. */
export function deckGridOf(grid: { bpm: number; firstDownbeat: number; beats?: readonly number[] }): DeckGrid {
  const out: DeckGrid = { bpm: grid.bpm, firstDownbeat: grid.firstDownbeat };
  const beats = grid.beats;
  if (beats && beats.length >= MIN_TRACKED_BEATS) {
    try {
      const map = new BeatMap(beats, grid.firstDownbeat);
      if (map.count >= MIN_TRACKED_BEATS) {
        out.map = map;
        out.beats = beats;
      }
    } catch {
      /* not usable: the fixed grid it is */
    }
  }
  return out;
}

import { BeatMap } from './beat-map';

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------------------------------------
// Faders

/** Channel fader range: 1 = 0 dB, 1.25 = +3.9 dB of headroom. */
export const FADER_MAX = 1.25;

/** Linear gain of a channel fader position (0…1.25): a squared taper, so the lower half is fine control. */
export function faderGain(v: number): number {
  const x = clamp(Number.isFinite(v) ? v : 0, 0, FADER_MAX);
  return x * x;
}

/** The linear gain of a level in dB. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** Trim knob range in dB. */
export const TRIM_MIN_DB = -12;
/** The highest trim (dB). */
export const TRIM_MAX_DB = 12;
/** Keeps a trim within its range (a value that is not a number reads as 0 dB). */
export const clampTrim = (db: number): number => clamp(Number.isFinite(db) ? db : 0, TRIM_MIN_DB, TRIM_MAX_DB);

/**
 * The crossfader's gain for each side at position x (−1 = all A, +1 = all B). `smooth` is equal power (both −3 dB
 * in the middle: no dip, no bump); `sharp` keeps both at full until near the ends and cuts within the outer 10 %
 * (scratching and cutting). At −1 side B is exactly 0; at +1 side A is.
 */
export function crossfaderGains(x: number, curve: CrossfaderCurve): { a: number; b: number } {
  const p = clamp(Number.isFinite(x) ? x : 0, -1, 1);
  if (curve === 'sharp') return { a: clamp((1 - p) * 10, 0, 1), b: clamp((1 + p) * 10, 0, 1) };
  const theta = ((p + 1) * Math.PI) / 4;
  // cos(π/2) is 6e-17: make the ends exact.
  return { a: p >= 1 ? 0 : Math.cos(theta), b: p <= -1 ? 0 : Math.sin(theta) };
}

/** The crossfader's gain for one deck (a deck on `thru` is not affected). */
export function crossfaderGainFor(side: CrossSide, x: number, curve: CrossfaderCurve): number {
  if (side === 'thru') return 1;
  const g = crossfaderGains(x, curve);
  return side === 'A' ? g.a : g.b;
}

/** Crossfader position `t` (0…1) of the way through a fade from `from` to `to`. */
export const crossfadeAt = (from: number, to: number, t: number): number => from + (to - from) * clamp(t, 0, 1);

// ---------------------------------------------------------------------------------------------
// EQ and filter

export const EQ_MIN_DB = -26;
/** The highest an EQ band can be turned up (dB). */
export const EQ_MAX_DB = 6;
/**
 * The three bands: a low shelf, a mid bell and a high shelf. The shelves' corners sit where a DJ mixer's do (the
 * knob's dB is what the far end of the band gets): at −26 dB 60 Hz is down 22 dB and 12 kHz down 23 dB, and the
 * mid bell takes 1 kHz down the full 26.
 */
export const EQ_BANDS = {
  low: { type: 'lowshelf', hz: 120, q: 0.707 },
  mid: { type: 'peaking', hz: 1000, q: 0.6 },
  high: { type: 'highshelf', hz: 7000, q: 0.707 },
} as const;
/** Keeps an EQ knob within its range (a value that is not a number reads as 0 dB). */
export const clampEq = (db: number): number => clamp(Number.isFinite(db) ? db : 0, EQ_MIN_DB, EQ_MAX_DB);

/** Below this the filter knob counts as centered (off). */
export const FILTER_DEAD_ZONE = 0.02;
/** Filter resonance as a Q factor (Butterworth: no peak). */
export const FILTER_Q = Math.SQRT1_2;

/**
 * The one-knob filter: below 0 a low-pass closes from fully open to about 80 Hz, above 0 a high-pass opens from
 * 20 Hz to about 6 kHz, both exponentially (an even sweep to the ear). `open` is where a stage rests when off.
 */
export function filterCutoffs(v: number, sampleRate: number): { lowpassHz: number; highpassHz: number } {
  const open = Math.min(20000, sampleRate * 0.45);
  const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
  if (Math.abs(x) < FILTER_DEAD_ZONE) return { lowpassHz: open, highpassHz: 20 };
  if (x < 0) return { lowpassHz: open * Math.pow(80 / open, -x), highpassHz: 20 };
  return { lowpassHz: open, highpassHz: 20 * Math.pow(6000 / 20, x) };
}

// ---------------------------------------------------------------------------------------------
// Pitch and tempo

export const PITCH_RANGES = [0.08, 0.16, 0.5] as const;
/** One of the pitch fader's ranges (a fraction: 0.08 is ±8 %). */
export type PitchRange = (typeof PITCH_RANGES)[number];

/** Keeps a pitch within ± the fader's range (a value that is not a number reads as 0). */
export const clampPitch = (pitch: number, range: number): number => clamp(Number.isFinite(pitch) ? pitch : 0, -range, range);

/** The smallest pitch range that holds `pitch`, or null when even ±50 % doesn't. */
export function rangeFor(pitch: number): PitchRange | null {
  for (const r of PITCH_RANGES) if (Math.abs(pitch) <= r + 1e-9) return r;
  return null;
}

/** Tempo the deck plays at (BPM) for a song tempo and pitch. */
export const playingBpm = (baseBpm: number, pitch: number): number => baseBpm * (1 + pitch);

// ---------------------------------------------------------------------------------------------
// Sync

/**
 * Which multiple of a song's tempo (½, 1 or 2) is closest to the master's tempo, so a 70 BPM song locks to a
 * 140 BPM master as half time and a 174 BPM one to 87.
 */
export function octaveMultiple(masterBpm: number, baseBpm: number): 0.5 | 1 | 2 {
  if (!(masterBpm > 0) || !(baseBpm > 0)) return 1;
  let best: 0.5 | 1 | 2 = 1;
  let bestErr = Infinity;
  for (const m of [1, 2, 0.5] as const) {
    const err = Math.abs(Math.log((baseBpm * m) / masterBpm));
    if (err < bestErr - 1e-9) {
      bestErr = err;
      best = m;
    }
  }
  return best;
}

/** How a deck matches a master's tempo: the pitch and the tempo multiple to use. */
export interface SyncPlan {
  /** Pitch that makes the song's (multiplied) tempo equal the master's. */
  pitch: number;
  /** The tempo multiple matched (½: the song is double time against the master; 2: half time). */
  multiple: 0.5 | 1 | 2;
  /** Seconds of the song per beat of the master, at pitch 0 (one effective beat). */
  beatSec: number;
}

/** Tempo sync of a song with `baseBpm` to a master playing at `masterBpm`. */
export function syncPlan(masterBpm: number, baseBpm: number): SyncPlan {
  const multiple = octaveMultiple(masterBpm, baseBpm);
  return { pitch: masterBpm / (baseBpm * multiple) - 1, multiple, beatSec: 60 / (baseBpm * multiple) };
}

/** Position within the beat (0 ≤ x < 1), counted from the first downbeat; `beatSec` is the song's seconds per beat. */
export function beatPhase(positionSec: number, firstDownbeat: number, beatSec: number): number {
  const x = (positionSec - firstDownbeat) / beatSec;
  return x - Math.floor(x);
}

/** The shortest signed distance from phase `b` to phase `a` (−0.5 ≤ x < 0.5): positive when `a` is ahead. */
export function phaseDiff(a: number, b: number): number {
  const d = a - b;
  return d - Math.round(d);
}

/**
 * Seconds to move a follower (in its own song time) so its beat falls with the master's: the master is at
 * `masterPhase` of its beat, the follower at `followerPhase`.
 */
export function phaseJumpSec(masterPhase: number, followerPhase: number, followerBeatSec: number): number {
  return -phaseDiff(followerPhase, masterPhase) * followerBeatSec;
}

/**
 * The seconds a follower's position moves to line up with the master (at the same instant), given both
 * grids and positions. Null when either has no grid.
 */
export function alignOffsetSec(
  master: { grid: DeckGrid; positionSec: number; multiple?: number },
  follower: { grid: DeckGrid; positionSec: number; multiple: number },
): number | null {
  const mBeat = 60 / (master.grid.bpm * (master.multiple ?? 1));
  const fBeat = 60 / (follower.grid.bpm * follower.multiple);
  return phaseJumpSec(
    beatPhase(master.positionSec, master.grid.firstDownbeat, mBeat),
    beatPhase(follower.positionSec, follower.grid.firstDownbeat, fBeat),
    fBeat,
  );
}

// ---------------------------------------------------------------------------------------------
// Beat grid, loops and jumps

/** Seconds per beat of a song (120 BPM when it has no grid); with tracked beats, the beat around `atSec`. */
export const beatSecOf = (grid: DeckGrid | null, atSec = 0): number =>
  grid?.map ? grid.map.lenAt(atSec) : 60 / (grid?.bpm ?? 120);

/** `beats` beats after `sec` (before it when negative): the local beat length with tracked beats, the fixed one without. */
export function addBeats(sec: number, beats: number, grid: DeckGrid | null): number {
  if (grid?.map) return grid.map.posAt(grid.map.beatAt(sec) + beats);
  return sec + beats * beatSecOf(grid);
}

/**
 * `sec` moved onto the grid in steps of `unitBeats` beats (nearest, or the step before it). No grid: unchanged.
 */
export function snapToGrid(sec: number, grid: DeckGrid | null, unitBeats = 1, mode: 'nearest' | 'floor' = 'nearest'): number {
  if (!grid) return sec;
  if (grid.map) {
    const m = grid.map.beatAt(sec) / unitBeats;
    const j = mode === 'floor' ? Math.floor(m + 1e-6) : Math.round(m);
    return grid.map.posAt(j * unitBeats);
  }
  const unit = beatSecOf(grid) * unitBeats;
  const n = (sec - grid.firstDownbeat) / unit;
  // A hair of tolerance so a position that is already on the grid (to rounding) stays there.
  const k = mode === 'floor' ? Math.floor(n + 1e-6) : Math.round(n);
  return grid.firstDownbeat + k * unit;
}

/** The loop sizes (beats) the auto loop buttons offer. */
export const AUTO_LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
/** The shortest loop (beats): a thirty-second of a beat. */
export const MIN_LOOP_BEATS = 1 / 32;
/** The longest loop (beats). */
export const MAX_LOOP_BEATS = 32;

/** A loop as seconds of the song: where it starts and where it ends. */
export interface LoopSpan {
  startSec: number;
  endSec: number;
}

/** An auto loop of `beats` that starts on the beat (or the step of the loop's own length, if shorter) under `positionSec`. */
export function autoLoopSpan(positionSec: number, beats: number, grid: DeckGrid | null): LoopSpan {
  const b = clamp(beats, MIN_LOOP_BEATS, MAX_LOOP_BEATS);
  const start = grid ? snapToGrid(positionSec, grid, Math.min(1, b), 'floor') : positionSec;
  const from = Math.max(0, start);
  return { startSec: from, endSec: addBeats(from, b, grid) };
}

/** A loop's length in beats. */
export const loopBeats = (loop: LoopSpan, grid: DeckGrid | null): number =>
  grid?.map ? grid.map.beatAt(loop.endSec) - grid.map.beatAt(loop.startSec) : (loop.endSec - loop.startSec) / beatSecOf(grid);

/** The same start, half or twice as long (1/32 to 32 beats); the end never passes the song's. */
export function resizeLoop(loop: LoopSpan, factor: 0.5 | 2, grid: DeckGrid | null, durationSec: number): LoopSpan {
  const beats = clamp(loopBeats(loop, grid) * factor, MIN_LOOP_BEATS, MAX_LOOP_BEATS);
  const end = Math.min(durationSec, addBeats(loop.startSec, beats, grid));
  return { startSec: loop.startSec, endSec: Math.max(addBeats(loop.startSec, MIN_LOOP_BEATS, grid), end) };
}

/** A hand-set loop: from `inSec` to `outSec`, both snapped to the beat, at least 1/32 beat long. */
export function manualLoopSpan(inSec: number, outSec: number, grid: DeckGrid | null): LoopSpan {
  const a = grid ? snapToGrid(inSec, grid, 0.25) : inSec;
  let b = grid ? snapToGrid(outSec, grid, 0.25) : outSec;
  const min = addBeats(a, MIN_LOOP_BEATS, grid) - a;
  if (b < a + min) b = a + Math.max(min, grid ? addBeats(a, 0.25, grid) - a : 0.05);
  return { startSec: a, endSec: b };
}

/** Where a beat jump of `beats` (negative: back) lands: the same phase in the beat, kept inside the song. */
export function beatJumpTarget(positionSec: number, beats: number, grid: DeckGrid | null, durationSec: number): number {
  return clamp(addBeats(positionSec, beats, grid), 0, Math.max(0, durationSec));
}

/** A loop moved by `deltaSec`, kept inside the song. */
export function shiftLoop(loop: LoopSpan, deltaSec: number, durationSec: number): LoopSpan {
  const len = loop.endSec - loop.startSec;
  const start = clamp(loop.startSec + deltaSec, 0, Math.max(0, durationSec - len));
  return { startSec: start, endSec: start + len };
}

/** The position after one render of a looping playhead: past the end it wraps back by whole loop lengths. */
export function wrapIntoLoop(positionSec: number, loop: LoopSpan): number {
  const len = loop.endSec - loop.startSec;
  if (!(len > 0) || positionSec < loop.endSec) return positionSec;
  return loop.startSec + ((positionSec - loop.startSec) % len);
}

// ---------------------------------------------------------------------------------------------
// Cue (CDJ)

export interface CueInput {
  playing: boolean;
  positionSec: number;
  cuePoint: number;
  grid: DeckGrid | null;
}

/** What pressing the cue button does (the deck applies it in this order). */
export interface CuePlan {
  /** A new main cue point (snapped to the beat). */
  setCue?: number;
  /** Jump here. */
  seek?: number;
  /** Start playing from there while the button is held (released: back to the cue and pause). */
  preview?: boolean;
  /** Stop playing. */
  pause?: boolean;
}

/** How close to the cue point counts as "on" it (seconds). */
export const CUE_EPSILON = 0.01;

/**
 * The CDJ cue rules. Playing: go back to the cue point and pause. Paused away from the cue point: set the cue
 * point here (on the beat) and preview from it while held. Paused on the cue point: preview from it while held.
 */
export function cuePressPlan(c: CueInput): CuePlan {
  if (c.playing) return { seek: c.cuePoint, pause: true };
  if (Math.abs(c.positionSec - c.cuePoint) <= CUE_EPSILON) return { preview: true };
  const at = Math.max(0, snapToGrid(c.positionSec, c.grid, 1));
  return { setCue: at, seek: at, preview: true };
}

/** A hot cue's position: where the deck is, on the beat. */
export const hotCuePosition = (positionSec: number, grid: DeckGrid | null): number => Math.max(0, snapToGrid(positionSec, grid, 1));

// ---------------------------------------------------------------------------------------------
// Jog wheel

/** Seconds of song one platter revolution moves at normal speed (33⅓ rpm). */
export const REV_SEC = 1.8;
/** Revolutions per second at normal speed. */
export const REV_PER_SEC = 1 / REV_SEC;
/** Scratch speeds are limited to this multiple of normal speed (either way). */
export const MAX_SCRATCH_RATE = 12;
/** Nudge bends the tempo by at most this fraction. */
export const MAX_NUDGE = 0.12;

/** Playback speed (1 = normal, negative = backwards) for a platter moving `deltaRev` revolutions in `dtSec`. */
export function scratchRate(deltaRev: number, dtSec: number): number {
  const dt = Math.max(0.004, dtSec);
  return clamp(deltaRev / dt / REV_PER_SEC, -MAX_SCRATCH_RATE, MAX_SCRATCH_RATE);
}

/** Temporary tempo bend (a fraction) for a nudge of `deltaRev` revolutions in `dtSec`. */
export function nudgeBend(deltaRev: number, dtSec: number): number {
  return clamp(scratchRate(deltaRev, dtSec) * 0.25, -MAX_NUDGE, MAX_NUDGE);
}

// ---------------------------------------------------------------------------------------------
// Display

/** "3:07.4" for the deck displays; negative times get a minus. */
export function formatDeckTime(sec: number): string {
  const neg = sec < 0;
  const s = Math.abs(Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${neg ? '−' : ''}${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** "+3.2%" / "−0.5%" for the pitch readout (one decimal). */
export function formatPitch(pitch: number): string {
  const pct = Math.round(pitch * 1000) / 10;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`;
}

/** "1/4", "1/2", "1", "16" for an auto loop's length in beats. */
export function loopBeatsLabel(beats: number): string {
  if (beats >= 1) return String(Math.round(beats * 100) / 100);
  const d = Math.round(1 / beats);
  return `1/${d}`;
}

/** The recording's name: "Live mix 2026-10-16 14:05" (local time). */
export function liveMixTitle(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Live mix ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
