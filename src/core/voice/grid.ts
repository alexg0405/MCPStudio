/**
 * Putting analysed voice events on a step grid: quantization (with swing and 1/32 resolution),
 * tempo estimation, and a compact text summary for people and for an AI prompt.
 */
import type { VoiceEvent, VoiceKind } from './analyze';

export interface Grid {
  bpm: number;
  /** Where bar 1 beat 1 is in the audio (seconds). */
  startSec: number;
  /** Events at or beyond this many bars are dropped (default: no limit). */
  bars?: number;
  /** Default 4. */
  beatsPerBar?: number;
  /** Default 4 (1/16 steps). */
  stepsPerBeat?: number;
}

export interface GridEvent extends VoiceEvent {
  /** Steps from bar 1 beat 1; a multiple of `resolution`. */
  step: number;
  /** Length in steps, a multiple of `resolution` and at least one resolution unit. */
  lengthSteps: number;
  /** Timing deviation from the grid position before quantizing (ms, positive = late). */
  offsetMs: number;
}

export interface QuantizeOptions {
  /** Grid unit in steps: 1 (default) or 0.5 (1/32 at 1/16 steps, for hat rolls). */
  resolution?: 0.5 | 1;
  /**
   * 0..1, the project's swing: the grid's odd steps sit later by swing × half a step (as the
   * engine plays them), so a swung performance quantizes onto the steps it meant.
   */
  swing?: number;
}

const KIND_ORDER: Record<VoiceKind, number> = { kick: 0, snare: 1, hat: 2, tonal: 3 };

/**
 * Quantizes events to the grid. Events more than half a step before bar 1 are dropped, as are
 * events at or after `grid.bars`. Two events of the same kind on the same step resolve to one:
 * drums keep the stronger, tonal events merge into one note (the longer one's pitch, spanning
 * both). Different kinds may share a step (a kick and a hat). Sorted by step, then kind.
 */
export function quantizeToGrid(events: readonly VoiceEvent[], grid: Grid, opts: QuantizeOptions = {}): GridEvent[] {
  if (!(grid.bpm > 0) || !Number.isFinite(grid.bpm)) throw new RangeError(`quantizeToGrid: invalid bpm ${grid.bpm}.`);
  const stepsPerBeat = Math.max(1, grid.stepsPerBeat ?? 4);
  const stepSec = 60 / grid.bpm / stepsPerBeat;
  const r = opts.resolution === 0.5 ? 0.5 : 1;
  const swing = Math.min(1, Math.max(0, opts.swing ?? 0));
  const total = grid.bars === undefined ? Infinity : grid.bars * Math.max(1, grid.beatsPerBar ?? 4) * stepsPerBeat;

  /** Where grid position g (in steps) is played. */
  const played = (g: number) => (Number.isInteger(g) && Math.abs(g % 2) === 1 ? g + swing / 2 : g);
  /** Nearest grid position to x (steps); ties go to the earlier one. */
  const nearest = (x: number): number => {
    let best = Math.floor(x / r) * r - r;
    let bestDist = Infinity;
    for (let g = best; g <= x + 2 * r; g += r) {
      const d = Math.abs(x - played(g));
      if (d < bestDist - 1e-9) {
        bestDist = d;
        best = g;
      }
    }
    return best;
  };

  const out: GridEvent[] = [];
  for (const e of events) {
    const x = (e.time - grid.startSec) / stepSec;
    if (!Number.isFinite(x) || x < -0.5) continue;
    const step = Math.max(0, nearest(x));
    if (step >= total) continue;
    const end = Math.min(total, nearest((e.time + Math.max(0, e.duration) - grid.startSec) / stepSec));
    out.push({
      ...e,
      step,
      lengthSteps: Math.max(r, end - step),
      offsetMs: (x - played(step)) * stepSec * 1000,
    });
  }
  out.sort((a, b) => a.step - b.step || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.time - b.time);

  // Same kind on the same step: keep the stronger drum, merge tonal notes.
  const resolved: GridEvent[] = [];
  for (const e of out) {
    const i = resolved.findIndex((o) => o.step === e.step && o.kind === e.kind);
    const prev = resolved[i];
    if (!prev) {
      resolved.push(e);
      continue;
    }
    if (e.kind !== 'tonal') {
      if (e.strength > prev.strength) resolved[i] = e;
      continue;
    }
    const [first, second] = prev.time <= e.time ? [prev, e] : [e, prev];
    const main = second.duration > first.duration ? second : first;
    const endSec = Math.max(first.time + first.duration, second.time + second.duration);
    resolved[i] = {
      ...main,
      time: first.time,
      duration: endSec - first.time,
      strength: Math.max(first.strength, second.strength),
      confidence: Math.max(first.confidence, second.confidence),
      pitchEnd: second.pitchEnd ?? main.pitchEnd,
      step: first.step,
      lengthSteps: Math.max(first.step + first.lengthSteps, second.step + second.lengthSteps) - first.step,
      offsetMs: first.offsetMs,
    };
  }
  return resolved;
}

export interface BpmOptions {
  /** Default 70. */
  min?: number;
  /** Default 180. */
  max?: number;
}

/**
 * Tempo from the onsets: an autocorrelation of the onset train (pairs weighted by strength) is
 * scored at each candidate tempo's 1/16, 1/8, beat, 2 beats and bar (plus triplet lags at lower
 * weight), with a mild preference for ~110 BPM to settle double/half-time ties, then refined by a
 * least-squares fit of the onsets to that tempo's 1/16 grid. Null with fewer than three onsets or
 * no periodicity in range.
 */
export function estimateBpm(events: readonly VoiceEvent[], opts: BpmOptions = {}): number | null {
  const min = Math.max(1, opts.min ?? 70);
  const max = Math.max(min, opts.max ?? 180);
  const ev = events
    .filter((e) => Number.isFinite(e.time))
    .map((e) => ({ t: e.time, w: 0.25 + Math.min(1, Math.max(0, e.strength)) }))
    .sort((a, b) => a.t - b.t);
  if (ev.length < 3) return null;

  // Autocorrelation A(lag), 1 ms bins up to 4.2 s, Gaussian kernel σ = 8 ms.
  const res = 0.001;
  const maxLag = 4.2;
  const A = new Float64Array(Math.ceil(maxLag / res) + 1);
  const sigma = 0.008;
  const reach = Math.ceil((3 * sigma) / res);
  for (let i = 0; i < ev.length; i++) {
    const a = ev[i] as { t: number; w: number };
    for (let j = i + 1; j < ev.length; j++) {
      const b = ev[j] as { t: number; w: number };
      const lag = b.t - a.t;
      if (lag > maxLag - 3 * sigma) break;
      if (lag < 0.04) continue;
      const c = Math.round(lag / res);
      for (let k = Math.max(0, c - reach); k <= Math.min(A.length - 1, c + reach); k++) {
        const d = (k * res - lag) / sigma;
        A[k] = (A[k] as number) + a.w * b.w * Math.exp(-0.5 * d * d);
      }
    }
  }
  const at = (lag: number): number => {
    const x = lag / res;
    const k = Math.floor(x);
    if (k < 0 || k + 1 >= A.length) return 0;
    return (A[k] as number) + (x - k) * ((A[k + 1] as number) - (A[k] as number));
  };
  // Lags in 1/16 notes and their weights: beat-level structure counts most.
  const lags: [number, number][] = [
    [1, 0.25],
    [2, 0.5],
    [4, 1],
    [8, 0.7],
    [16, 0.5],
    [3, 0.1],
    [6, 0.2],
    [12, 0.2],
  ];
  let best = 0;
  let bestScore = 0;
  for (let bpm = min; bpm <= max + 1e-9; bpm += 0.05) {
    const sixteenth = 60 / bpm / 4;
    let s = 0;
    for (const [m, w] of lags) s += w * at(m * sixteenth);
    s *= Math.exp(-0.5 * (Math.log2(bpm / 110) / 1) ** 2);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  if (!(bestScore > 1e-6)) return null;

  // Octave check: when the winner's off-beat 8ths are as many and as strong as its beats, there is
  // no accent to say which are the beats (a steady pulse, unaccented hats): take double time.
  if (best * 2 <= max + 0.5) {
    const eighth = 60 / best / 2;
    const phase = circularPhase(ev, eighth);
    const groups = [
      { n: 0, s: 0 },
      { n: 0, s: 0 },
    ];
    for (const e of events) {
      const x = (e.time - phase) / eighth;
      const k = Math.round(x);
      if (!Number.isFinite(x) || Math.abs(x - k) > 0.2) continue;
      const g = groups[k & 1] as { n: number; s: number };
      g.n++;
      g.s += Math.min(1, Math.max(0, e.strength));
    }
    const [on, off] = [...groups].sort((a, b) => b.s / Math.max(1, b.n) - a.s / Math.max(1, a.n)) as [
      { n: number; s: number },
      { n: number; s: number },
    ];
    if (off.n > 0 && off.n >= 0.75 * on.n && off.s / off.n >= 0.8 * (on.s / Math.max(1, on.n))) best *= 2;
  }

  // Refine: least-squares fit of onset times to integer 1/16 indices at the best tempo.
  const u = 60 / best / 4;
  const phase = circularPhase(ev, u);
  let n = 0;
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  for (const e of ev) {
    const k = Math.round((e.t - phase) / u);
    n += e.w;
    sk += e.w * k;
    st += e.w * e.t;
    skk += e.w * k * k;
    skt += e.w * k * e.t;
  }
  const den = n * skk - sk * sk;
  if (den > 0) {
    const slope = (n * skt - sk * st) / den;
    const refined = 60 / (4 * slope);
    if (Math.abs(refined - best) / best < 0.03 && refined >= min - 1 && refined <= max + 1) best = refined;
  }
  return Math.round(best * 10) / 10;
}

/** Weighted circular mean of the onset times modulo `period`, in [0, period). */
function circularPhase(ev: readonly { t: number; w: number }[], period: number): number {
  let cx = 0;
  let cy = 0;
  for (const e of ev) {
    const a = (2 * Math.PI * e.t) / period;
    cx += e.w * Math.cos(a);
    cy += e.w * Math.sin(a);
  }
  return ((((Math.atan2(cy, cx) / (2 * Math.PI)) * period) % period) + period) % period;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Scientific pitch name of a MIDI note (rounded): 60 → C4, 36 → C2, 39 → D#2. */
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** A legend for `describeEvents` output, ready to paste into a prompt next to it. */
export const VOICE_SUMMARY_LEGEND =
  'Each bar line lists events as POSITION KIND: POSITION is beat.sixteenth, 1-based ("2" = beat 2, ' +
  '"2.3" = its third 1/16, "+" = one 1/32 later). kick/snare/hat(strength 0–1), "?" = unsure kind. ' +
  'tonal NOTE len STEPS (1 step = 1/16) slide→NOTE = the pitch glides there. Notes: C4 = MIDI 60. ' +
  '"-" = empty bar.';

export interface DescribeOptions {
  /** Default 16. */
  stepsPerBar?: number;
  /** Default 4 (positions are beat.sixteenth). */
  stepsPerBeat?: number;
}

/**
 * A compact, human- and LLM-readable summary of quantized events. Format:
 *
 * ```
 * 9 events (2 kick, 2 snare, 3 hat, 2 tonal), 2 bars of 16 steps, pitch C2–D#2 (MIDI 36–39)
 * bar 1: 1 kick(0.9) | 1.3 hat(0.4) | 2 snare(0.8) | 2.3 hat(0.4) | 3 kick(1.0) | 3.3 hat?(0.3) | 4 snare(0.7)
 * bar 2: 1 tonal C2 len 3 slide→D#2 | 1.4 tonal D#2 len 5
 * ```
 *
 * - Header: event count, count per kind, bars spanned, pitch range of tonal notes (with MIDI numbers
 *   so the octave convention is unambiguous; names are scientific pitch, C4 = MIDI 60).
 * - One line per bar from bar 1 to the last bar with events; an empty bar is `bar N: -`.
 * - Position = beat.sixteenth, both 1-based; `.1` is omitted (`2` = beat 2, `2.3` = beat 2's third
 *   1/16); a trailing `+` means one 1/32 later (0.5-step resolution).
 * - Drums: `kind(strength)` with strength to one decimal; `kind?` when the confidence is under 0.5.
 * - Tonal: `tonal NOTE len STEPS`, plus `slide→NOTE` when the note ends on a different pitch; `?`
 *   instead of NOTE when no pitch was found.
 *
 * `VOICE_SUMMARY_LEGEND` explains the format in one paragraph for a prompt.
 */
export function describeEvents(events: readonly GridEvent[], opts: DescribeOptions = {}): string {
  const stepsPerBar = Math.max(1, opts.stepsPerBar ?? 16);
  const stepsPerBeat = Math.max(1, opts.stepsPerBeat ?? 4);
  const sorted = [...events].sort((a, b) => a.step - b.step || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const counts = (['kick', 'snare', 'hat', 'tonal'] as const)
    .map((k) => [k, sorted.filter((e) => e.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let header = plural(sorted.length, 'event');
  if (sorted.length === 0) return header;
  const bars = Math.floor((sorted[sorted.length - 1] as GridEvent).step / stepsPerBar) + 1;
  header += ` (${counts.join(', ')}), ${plural(bars, 'bar')} of ${stepsPerBar} steps`;
  const notes = sorted
    .filter((e) => e.kind === 'tonal')
    .flatMap((e) => [e.pitch, e.pitchEnd])
    .filter((p): p is number => p !== null && Number.isFinite(p))
    .map((p) => Math.round(p));
  if (notes.length > 0) {
    const lo = Math.min(...notes);
    const hi = Math.max(...notes);
    header +=
      lo === hi ? `, pitch ${noteName(lo)} (MIDI ${lo})` : `, pitch ${noteName(lo)}–${noteName(hi)} (MIDI ${lo}–${hi})`;
  }

  const position = (step: number): string => {
    const inBar = step - Math.floor(step / stepsPerBar) * stepsPerBar;
    const beat = Math.floor(inBar / stepsPerBeat) + 1;
    const sub = inBar - (beat - 1) * stepsPerBeat;
    const whole = Math.floor(sub + 1e-9);
    const half = sub - whole > 0.25 ? '+' : '';
    return whole === 0 && !half ? `${beat}` : `${beat}.${whole + 1}${half}`;
  };
  const describe = (e: GridEvent): string => {
    const pos = position(e.step);
    if (e.kind !== 'tonal') return `${pos} ${e.kind}${e.confidence < 0.5 ? '?' : ''}(${e.strength.toFixed(1)})`;
    const note = e.pitch === null ? '?' : noteName(e.pitch);
    const len = Number.isInteger(e.lengthSteps) ? `${e.lengthSteps}` : e.lengthSteps.toFixed(1);
    const slide =
      e.pitch !== null && e.pitchEnd !== null && Math.round(e.pitchEnd) !== Math.round(e.pitch)
        ? ` slide→${noteName(e.pitchEnd)}`
        : '';
    return `${pos} tonal ${note} len ${len}${slide}`;
  };
  const lines = [header];
  for (let bar = 0; bar < bars; bar++) {
    const inBar = sorted.filter((e) => Math.floor(e.step / stepsPerBar) === bar);
    lines.push(`bar ${bar + 1}: ${inBar.length > 0 ? inBar.map(describe).join(' | ') : '-'}`);
  }
  return lines.join('\n');
}
