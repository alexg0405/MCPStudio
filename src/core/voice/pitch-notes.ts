/**
 * Sung-pitch analysis for the pitch editor: the YIN track of a recording (`trackPitch`), cleaned
 * (octave slips and short dropouts repaired), cut into notes with the pitch they were sung at, how
 * much each drifts and how much vibrato it has. Pure, no DOM; runs in a Worker or in Node.
 *
 * Notes: a run of voiced frames is one note until its (median-filtered) pitch leaves the note's
 * running centre by 65 cents and settles on a new level for 50 ms; the boundary is put where the
 * glide began. Unvoiced gaps of 30 ms or more (a consonant, a breath) end a note. Pieces under
 * 40 ms join their neighbour, notes under 30 ms of pitched sound are dropped. Thresholds are in
 * `PITCH_NOTE_THRESHOLDS`.
 */
import { repairOctaveSlips } from './octave';
import { hzToMidi, trackPitch } from './pitch';

/** The pitch track at a fixed frame spacing. */
export interface PitchFrames {
  /** Time (seconds, on the timeline of the recording) of frame 0's centre. */
  t0: number;
  /** Seconds between frames. */
  hop: number;
  /** Fundamental in Hz per frame; 0 where unvoiced. */
  f0: Float32Array;
  /** 0..1 how periodic each frame is. */
  conf: Float32Array;
}

export interface PitchNote {
  /** Seconds on the recording's timeline. */
  from: number;
  to: number;
  /** The pitch it was sung at: the median, as a MIDI note (60 = C4, fractions are cents). */
  pitch: number;
  /** How far its slow pitch line wanders from start to end, cents (peak to peak). */
  drift: number;
  /** Vibrato depth in cents, peak to peak (0 when there is none). */
  vibratoDepth: number;
  /** Vibrato rate in Hz (0 when there is none). */
  vibratoRate: number;
}

export interface PitchAnalysis extends PitchFrames {
  notes: PitchNote[];
}

/**
 * The version of the analysis (tracker, cleaning, octave repair, segmentation): stored analyses carry it in their key, so a
 * change that can alter a result bumps it and old entries are ignored and deleted. 1: first release; 2: octave repair.
 */
export const PITCH_ANALYSIS_VERSION = 2;

export const PITCH_NOTE_THRESHOLDS = {
  /** A note ends when the pitch is this far (cents) from its centre and settles elsewhere. */
  splitCents: 65,
  /** The new level must hold this long (seconds). */
  settleSec: 0.05,
  /** Unvoiced gaps this long end a note (seconds). */
  gapSec: 0.03,
  /** A piece shorter than this joins its neighbour (seconds of pitched sound). */
  minPieceSec: 0.04,
  /** Notes with less pitched sound than this are dropped. */
  minNoteSec: 0.03,
  /** The slow pitch line is a moving average this long (about one vibrato period), seconds. */
  slowSec: 0.17,
  /** Vibrato needs at least this depth (cents, peak to peak) and a rate in this range (Hz). */
  vibratoMinDepth: 25,
  vibratoRate: [3.5, 9.5] as const,
};

/** Frames of an unvoiced dropout that are bridged by interpolation. */
const BRIDGE_FRAMES = 2;
/** Shortest voiced run kept, frames. */
const MIN_RUN_FRAMES = 4;

const centsOf = (hz: number) => (hz > 0 ? 100 * hzToMidi(hz) : Number.NaN);
const hzOf = (cents: number) => 440 * Math.pow(2, (cents / 100 - 69) / 12);

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : 0.5 * ((s[m - 1] as number) + (s[m] as number));
}

/**
 * Repairs a raw YIN track: octave slips (a frame an octave off its neighbours moves back; an
 * isolated outlier goes unvoiced), dropouts of up to two frames are bridged, runs under 20 ms
 * dropped. Returns new arrays.
 */
export function cleanF0(f0: Float32Array, conf: Float32Array): { f0: Float32Array; conf: Float32Array } {
  const n = f0.length;
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = centsOf(f0[i] as number);
  const fixed = Float64Array.from(c);
  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(c[i] as number)) continue;
    // Up to three voiced frames on each side: a glitch differs from both and they agree with each other.
    before.length = 0;
    after.length = 0;
    for (let j = i - 1; j >= Math.max(0, i - 4) && before.length < 3; j--) if (!Number.isNaN(c[j] as number)) before.push(c[j] as number);
    for (let j = i + 1; j <= Math.min(n - 1, i + 4) && after.length < 3; j++) if (!Number.isNaN(c[j] as number)) after.push(c[j] as number);
    // At the very start or end of a run only one side exists: the tracker's last wild frames as a
    // voice dies away are compared with the three before them.
    const oneSided = (before.length >= 3 && after.length < 2) || (after.length >= 3 && before.length < 2);
    if (!oneSided && (before.length < 2 || after.length < 2)) continue;
    const l = before.length >= 2 ? median(before) : median(after);
    const r = after.length >= 2 ? median(after) : l;
    if (Math.abs(l - r) > 250) continue;
    const m = 0.5 * (l + r);
    const d = (c[i] as number) - m;
    if (Math.abs(d) > 450) {
      const k = Math.round(d / 1200);
      if (k !== 0 && Math.abs(d - 1200 * k) < 250) fixed[i] = (c[i] as number) - 1200 * k;
      else fixed[i] = Number.NaN;
    }
  }
  const outConf = Float32Array.from(conf);
  // Bridge short dropouts (linear in cents).
  let i = 0;
  while (i < n) {
    if (!Number.isNaN(fixed[i] as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && Number.isNaN(fixed[j] as number)) j++;
    if (i > 0 && j < n && j - i <= BRIDGE_FRAMES) {
      const a = fixed[i - 1] as number;
      const b = fixed[j] as number;
      if (Math.abs(a - b) < 200)
        for (let k = i; k < j; k++) {
          fixed[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
          outConf[k] = Math.min(conf[i - 1] as number, conf[j] as number, 0.6);
        }
    }
    i = j;
  }
  // Drop runs that are too short.
  i = 0;
  while (i < n) {
    if (Number.isNaN(fixed[i] as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !Number.isNaN(fixed[j] as number)) j++;
    if (j - i < MIN_RUN_FRAMES) for (let k = i; k < j; k++) fixed[k] = Number.NaN;
    i = j;
  }
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = fixed[k] as number;
    out[k] = Number.isNaN(v) ? 0 : hzOf(v);
    if (Number.isNaN(v)) outConf[k] = 0;
  }
  return { f0: out, conf: outConf };
}

/** Cents of every frame (NaN where unvoiced). */
export function framesToCents(f0: Float32Array): Float64Array {
  const c = new Float64Array(f0.length);
  for (let i = 0; i < f0.length; i++) c[i] = centsOf(f0[i] as number);
  return c;
}

/**
 * The slow pitch line of frames [i0, i1]: a moving average (`win` frames, centred, clipped to the
 * range) of the voiced frames; NaN where unvoiced. It follows glides and drift but not vibrato.
 */
export function slowLine(cents: Float64Array, i0: number, i1: number, win: number): Float64Array {
  const len = i1 - i0 + 1;
  const sum = new Float64Array(len + 1);
  const cnt = new Int32Array(len + 1);
  for (let k = 0; k < len; k++) {
    const v = cents[i0 + k] as number;
    sum[k + 1] = (sum[k] as number) + (Number.isNaN(v) ? 0 : v);
    cnt[k + 1] = (cnt[k] as number) + (Number.isNaN(v) ? 0 : 1);
  }
  const half = Math.max(1, Math.round(win / 2));
  const out = new Float64Array(len);
  for (let k = 0; k < len; k++) {
    if (Number.isNaN(cents[i0 + k] as number)) {
      out[k] = Number.NaN;
      continue;
    }
    // The window may not be wider than the note itself on either side of the frame (it shrinks at the ends).
    const reach = Math.min(half, k, len - 1 - k);
    const lo = k - Math.max(1, reach);
    const hi = Math.min(len, k + Math.max(1, reach) + 1);
    const l = Math.max(0, lo);
    const c = (cnt[hi] as number) - (cnt[l] as number);
    out[k] = c > 0 ? ((sum[hi] as number) - (sum[l] as number)) / c : (cents[i0 + k] as number);
  }
  return out;
}

/** Splits one run of voiced frames (indices into the track) at pitch changes. Returns [from, to] frame ranges. */
function splitRun(cents: Float64Array, voiced: number[], hop: number): Array<[number, number]> {
  const T = PITCH_NOTE_THRESHOLDS;
  const n = voiced.length;
  if (n === 0) return [];
  // Median-filtered pitch of each voiced frame (±4 frames).
  const sm = new Float64Array(n);
  const win: number[] = [];
  for (let k = 0; k < n; k++) {
    win.length = 0;
    for (let j = Math.max(0, k - 4); j <= Math.min(n - 1, k + 4); j++) win.push(cents[voiced[j] as number] as number);
    sm[k] = median(win);
  }
  const settle = Math.max(4, Math.round(T.settleSec / hop));
  const pieces: Array<[number, number]> = [];
  let start = 0;
  let ref = sm[0] as number;
  for (let k = 1; k < n; k++) {
    const dev = Math.abs((sm[k] as number) - ref);
    if (dev > T.splitCents) {
      const end = Math.min(n, k + settle);
      let stable = end - k >= Math.min(settle, 4) && (end - k >= settle || end === n);
      for (let j = k; j < end && stable; j++) if (Math.abs((sm[j] as number) - (sm[k] as number)) > 0.8 * T.splitCents) stable = false;
      if (stable) {
        // Back to where the glide began: the first frame already moving away from the old level.
        let b = k;
        while (b - 1 > start && Math.abs((sm[b - 1] as number) - ref) > 0.5 * T.splitCents) b--;
        pieces.push([start, b - 1]);
        start = b;
        ref = median(Array.from(sm.subarray(k, end)));
        k = end - 1;
        continue;
      }
    } else ref += ((sm[k] as number) - ref) * 0.08;
  }
  pieces.push([start, n - 1]);
  // Short pieces join the neighbour with the nearest pitch.
  const minPiece = Math.max(2, Math.round(T.minPieceSec / hop));
  for (let guard = 0; guard < 64 && pieces.length > 1; guard++) {
    let shortest = -1;
    for (let p = 0; p < pieces.length; p++) {
      const [a, b] = pieces[p] as [number, number];
      if (b - a + 1 < minPiece && (shortest < 0 || b - a < (pieces[shortest] as [number, number])[1] - (pieces[shortest] as [number, number])[0])) shortest = p;
    }
    if (shortest < 0) break;
    const [a, b] = pieces[shortest] as [number, number];
    const mid = median(Array.from(sm.subarray(a, b + 1)));
    const prev = pieces[shortest - 1];
    const next = pieces[shortest + 1];
    const dist = (p: [number, number] | undefined) => (p ? Math.abs(median(Array.from(sm.subarray(p[0], p[1] + 1))) - mid) : Infinity);
    // A sliver at the very start or end of a run that is far from its neighbour is not part of the
    // note (the tracker's last wild frames as a voice dies away): it is dropped.
    if ((!prev || !next) && Math.min(dist(prev), dist(next)) > 250) {
      pieces.splice(shortest, 1);
      continue;
    }
    if (dist(prev) <= dist(next) && prev) {
      prev[1] = b;
      pieces.splice(shortest, 1);
    } else if (next) {
      next[0] = a;
      pieces.splice(shortest, 1);
    } else break;
  }
  return pieces.map(([a, b]) => [voiced[a] as number, voiced[b] as number]);
}

/** Statistics of one note over frames [i0, i1] of a track. */
export function noteStats(
  f0: Float32Array,
  cents: Float64Array,
  i0: number,
  i1: number,
  hop: number,
): Pick<PitchNote, 'pitch' | 'drift' | 'vibratoDepth' | 'vibratoRate'> {
  const T = PITCH_NOTE_THRESHOLDS;
  const voiced: number[] = [];
  for (let i = i0; i <= i1; i++) if ((f0[i] as number) > 0) voiced.push(cents[i] as number);
  const pitch = voiced.length ? median(voiced) / 100 : 0;
  const slow = slowLine(cents, i0, i1, Math.round(T.slowSec / hop));
  // Drift is measured away from the ends, where the window is short (vibrato leaks through) and the
  // note glides in; a note too short for that has no measurable drift.
  const half = Math.max(1, Math.round(Math.round(T.slowSec / hop) / 2));
  const long = i1 - i0 + 1 >= 2 * half + 12;
  const lead = long ? half : 0;
  const edge = long ? half : 0;
  const slowVals: number[] = [];
  const dev: number[] = [];
  for (let k = long ? lead : 0; k < slow.length - edge; k++) {
    const s = slow[k] as number;
    if (Number.isNaN(s)) continue;
    slowVals.push(s);
    dev.push((cents[i0 + k] as number) - s);
  }
  let lo = Infinity;
  let hi = -Infinity;
  if (long && slowVals.length >= 8) {
    const sv = slowVals.slice().sort((a, b) => a - b);
    lo = sv[Math.floor(0.03 * (sv.length - 1))] as number;
    hi = sv[Math.ceil(0.97 * (sv.length - 1))] as number;
  }
  const drift = Number.isFinite(lo) ? hi - lo : 0;
  let vibratoDepth = 0;
  let vibratoRate = 0;
  if (dev.length >= 12) {
    const sorted = dev.slice().sort((a, b) => a - b);
    const p5 = sorted[Math.floor(0.05 * (sorted.length - 1))] as number;
    const p95 = sorted[Math.ceil(0.95 * (sorted.length - 1))] as number;
    const depth = p95 - p5;
    // Rate from the zero crossings of the deviation (with a dead band against wobble).
    const band = 0.15 * depth;
    let crossings = 0;
    let state = 0;
    let firstAt = 0;
    let lastAt = 0;
    for (let k = 0; k < dev.length; k++) {
      const d = dev[k] as number;
      const s = d > band ? 1 : d < -band ? -1 : 0;
      if (s !== 0 && s !== state) {
        if (state !== 0) {
          if (crossings === 0) firstAt = k;
          lastAt = k;
          crossings++;
        }
        state = s;
      }
    }
    // Half a cycle between neighbouring crossings: measured from the first to the last one.
    const rate = lastAt > firstAt ? (crossings - 1) / (2 * (lastAt - firstAt) * hop) : 0;
    if (depth >= T.vibratoMinDepth && crossings >= 3 && rate >= T.vibratoRate[0] && rate <= T.vibratoRate[1]) {
      vibratoDepth = depth;
      vibratoRate = rate;
    }
  }
  return { pitch, drift, vibratoDepth, vibratoRate };
}

/** Cuts a (cleaned) pitch track into notes. */
export function segmentNotes(frames: PitchFrames): PitchNote[] {
  const T = PITCH_NOTE_THRESHOLDS;
  const { f0, hop, t0 } = frames;
  const cents = framesToCents(f0);
  const gapFrames = Math.max(1, Math.round(T.gapSec / hop));
  const notes: PitchNote[] = [];
  const n = f0.length;
  let i = 0;
  while (i < n) {
    if (!((f0[i] as number) > 0)) {
      i++;
      continue;
    }
    // One run: voiced frames, joined across gaps shorter than gapSec.
    const voiced: number[] = [];
    let gap = 0;
    let j = i;
    for (; j < n; j++) {
      if ((f0[j] as number) > 0) {
        voiced.push(j);
        gap = 0;
      } else if (++gap >= gapFrames) break;
    }
    for (const [a, b] of splitRun(cents, voiced, hop)) {
      let count = 0;
      for (let k = a; k <= b; k++) if ((f0[k] as number) > 0) count++;
      if (count * hop < T.minNoteSec) continue;
      notes.push({
        from: t0 + (a - 0.5) * hop,
        to: t0 + (b + 0.5) * hop,
        ...noteStats(f0, cents, a, b, hop),
      });
    }
    i = j;
  }
  return notes;
}

export interface AnalyzeOptions {
  /** Where the first sample of the audio is on the recording's timeline, seconds (default 0). */
  start?: number;
  /** The range of voices to look for, Hz (default 65–1100). */
  minHz?: number;
  maxHz?: number;
  /** Repair notes the tracker read an octave or more high (default true; tests turn it off to measure the tracker alone). */
  repairOctaves?: boolean;
}

/** What `trackVoicePitch` makes of a mono signal. */
export interface VoicePitch {
  /** Cleaned and octave-repaired fundamental per frame, Hz (0 = unvoiced). */
  f0: Float32Array;
  conf: Float32Array;
  /** Seconds between frames. */
  hop: number;
  /** Frames moved down because the tracker read them an octave (or more) above the sound's fundamental. */
  repaired: number;
}

/**
 * The pitch track the editor and the renderer both use: YIN (`trackPitch`), cleaned (`cleanF0`), then notes whose
 * fundamental the tracker read an octave (or an octave and a fifth) high are moved down where a short-window spectrum
 * shows the lower fundamental's lines (`octave.ts`). Deterministic.
 */
export function trackVoicePitch(
  mono: Float32Array,
  sampleRate: number,
  opts: { minHz?: number; maxHz?: number; repairOctaves?: boolean } = {},
): VoicePitch {
  const hop = Math.max(1, Math.round(0.005 * sampleRate));
  const track = trackPitch(mono, sampleRate, { minHz: opts.minHz ?? 65, maxHz: opts.maxHz ?? 1100, hop });
  const clean = cleanF0(track.f0, track.confidence);
  const hopSec = hop / sampleRate;
  const repaired = opts.repairOctaves === false ? 0 : repairOctaveSlips(mono, sampleRate, clean.f0, hop);
  return { f0: clean.f0, conf: clean.conf, hop: hopSec, repaired };
}

/** Tracks and segments the pitch of a mono recording. */
export function analyzePitch(mono: Float32Array, sampleRate: number, opts: AnalyzeOptions = {}): PitchAnalysis {
  const v = trackVoicePitch(mono, sampleRate, opts);
  const frames: PitchFrames = { t0: opts.start ?? 0, hop: v.hop, f0: v.f0, conf: v.conf };
  return { ...frames, notes: segmentNotes(frames) };
}
