import type { Tick, TimeSignature } from '../model/types';

/** Ticks per quarter note. FL's maximum resolution; 1/16 = 240, 1/16 triplet = 160, 1/32 = 120. */
export const PPQ = 960;
export const TICKS_PER_STEP = PPQ / 4;

export function ticksPerBeat(ts: TimeSignature): Tick {
  return (PPQ * 4) / ts.den;
}

export function ticksPerBar(ts: TimeSignature): Tick {
  return ts.num * ticksPerBeat(ts);
}

export function stepsPerBar(ts: TimeSignature): number {
  return ticksPerBar(ts) / TICKS_PER_STEP;
}

/** Rounds up to whole bars (at least one bar). */
export function ceilToBars(ticks: Tick, ts: TimeSignature): Tick {
  const bar = ticksPerBar(ts);
  return Math.max(bar, Math.ceil(ticks / bar) * bar);
}

/** Converts between ticks and seconds. v1 has one constant tempo; this interface allows tempo automation later. */
export interface TempoMap {
  readonly bpm: number;
  secondsPerTick(tick: Tick): number;
  tickToSeconds(tick: Tick): number;
  secondsToTick(seconds: number): number;
}

export function constantTempo(bpm: number): TempoMap {
  const spt = 60 / (bpm * PPQ);
  return {
    bpm,
    secondsPerTick: () => spt,
    tickToSeconds: (tick) => tick * spt,
    secondsToTick: (seconds) => seconds / spt,
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** FL-style song position "bar:step:tick", 1-based bars and steps (e.g. "3:05:120"). */
export function formatBST(tick: Tick, ts: TimeSignature): string {
  const t = Math.max(0, Math.floor(tick));
  const bar = Math.floor(t / ticksPerBar(ts));
  const inBar = t - bar * ticksPerBar(ts);
  const step = Math.floor(inBar / TICKS_PER_STEP);
  const rest = inBar - step * TICKS_PER_STEP;
  return `${bar + 1}:${pad(step + 1, 2)}:${pad(rest, 3)}`;
}

/** Note name for a MIDI key using FL's octave numbering (MIDI 60 = C5). */
export function keyName(key: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((key % 12) + 12) % 12]}${Math.floor(key / 12)}`;
}
