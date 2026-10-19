import { KIND_ORDER, type GridEvent } from './quantize';

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

/** A drum whose kind is less sure than this is marked with a "?". */
const UNSURE_CONFIDENCE = 0.5;
/** A position this far (in steps) past a whole step is a 1/32 later ("+"). */
const HALF_STEP_THRESHOLD = 0.25;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "9 events (2 kick, 3 hat, 1 tonal), 2 bars of 16 steps, pitch C2–D#2 (MIDI 36–39)". */
function headerOf(sorted: readonly GridEvent[], stepsPerBar: number): string {
  const counts = (['kick', 'snare', 'hat', 'tonal'] as const)
    .map((k) => [k, sorted.filter((e) => e.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
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
    const range = lo === hi ? `${noteName(lo)} (MIDI ${lo})` : `${noteName(lo)}–${noteName(hi)} (MIDI ${lo}–${hi})`;
    header += `, pitch ${range}`;
  }
  return header;
}

/** The position of a step in its bar as beat.sixteenth ("2" = beat 2, "2.3" = its third 1/16, "+" = a 1/32 later). */
function positionOf(step: number, stepsPerBar: number, stepsPerBeat: number): string {
  const inBar = step - Math.floor(step / stepsPerBar) * stepsPerBar;
  const beat = Math.floor(inBar / stepsPerBeat) + 1;
  const sub = inBar - (beat - 1) * stepsPerBeat;
  const whole = Math.floor(sub + 1e-9);
  const half = sub - whole > HALF_STEP_THRESHOLD ? '+' : '';
  return whole === 0 && !half ? `${beat}` : `${beat}.${whole + 1}${half}`;
}

/** One event: "2 snare(0.8)", "1 hat?(0.3)" or "1 tonal C2 len 3 slide→D#2". */
function describeOne(e: GridEvent, stepsPerBar: number, stepsPerBeat: number): string {
  const pos = positionOf(e.step, stepsPerBar, stepsPerBeat);
  if (e.kind !== 'tonal')
    return `${pos} ${e.kind}${e.confidence < UNSURE_CONFIDENCE ? '?' : ''}(${e.strength.toFixed(1)})`;
  const note = e.pitch === null ? '?' : noteName(e.pitch);
  const len = Number.isInteger(e.lengthSteps) ? `${e.lengthSteps}` : e.lengthSteps.toFixed(1);
  const glidesAway = e.pitch !== null && e.pitchEnd !== null && Math.round(e.pitchEnd) !== Math.round(e.pitch);
  const slide = glidesAway ? ` slide→${noteName(e.pitchEnd as number)}` : '';
  return `${pos} tonal ${note} len ${len}${slide}`;
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
  const header = headerOf(sorted, stepsPerBar);
  if (sorted.length === 0) return header;
  const bars = Math.floor((sorted[sorted.length - 1] as GridEvent).step / stepsPerBar) + 1;
  const lines = [header];
  for (let bar = 0; bar < bars; bar++) {
    const inBar = sorted.filter((e) => Math.floor(e.step / stepsPerBar) === bar);
    const text = inBar.length > 0 ? inBar.map((e) => describeOne(e, stepsPerBar, stepsPerBeat)).join(' | ') : '-';
    lines.push(`bar ${bar + 1}: ${text}`);
  }
  return lines.join('\n');
}
