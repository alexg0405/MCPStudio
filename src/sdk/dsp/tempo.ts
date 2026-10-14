// Tempo-synced rates and a phase clock that follows the song. Allocation-free; usable on any thread.
import type { KernelTransport } from '../worklet/kernel';

/** Note lengths for tempo-synced rates, in beats (quarter notes); a bar is 4 beats (4/4). */
export const NOTE_BEATS = {
  '8 bars': 32,
  '4 bars': 16,
  '2 bars': 8,
  '1 bar': 4,
  '1/2': 2,
  '1/2d': 3,
  '1/2t': 4 / 3,
  '1/4': 1,
  '1/4d': 1.5,
  '1/4t': 2 / 3,
  '1/8': 0.5,
  '1/8d': 0.75,
  '1/8t': 1 / 3,
  '1/16': 0.25,
  '1/16d': 0.375,
  '1/16t': 1 / 6,
  '1/32': 0.125,
} as const;

export type NoteLength = keyof typeof NOTE_BEATS;

/** Every note length, longest first (for `p.enum` options). */
export const NOTE_LENGTHS = Object.keys(NOTE_BEATS) as NoteLength[];

/** Display names: "1/8 dotted", "1/4 triplet". */
export const NOTE_LABELS: Record<NoteLength, string> = Object.fromEntries(
  NOTE_LENGTHS.map((n) => [n, n.endsWith('d') ? `${n.slice(0, -1)} dotted` : n.endsWith('t') ? `${n.slice(0, -1)} triplet` : n]),
) as Record<NoteLength, string>;

/** Beats in a note length ('1/8d' → 0.75); 0 for anything else ('off', 'free'). */
export function noteBeats(name: string): number {
  return (NOTE_BEATS as Record<string, number | undefined>)[name] ?? 0;
}

/**
 * A cycle position (`phase`, 0–1, and the whole `cycle` count) for LFOs and other repeating
 * shapes. While the song plays, a tempo-synced clock is locked to the song position, so it lands on
 * the beat on every playback and in exports; while the song is stopped (or with no sync) it runs
 * freely, so the effect keeps moving when you play live.
 *
 * ```ts
 * const phase = this.clock.next(this.transport, i, rateHz, periodBeats); // periodBeats 0 = free
 * const v = this.lfo.valueAt(phase, this.clock.cycle);
 * ```
 */
export class PhaseClock {
  phase = 0;
  cycle = 0;

  constructor(private readonly sampleRate: number) {}

  /**
   * The phase at frame `i` of the block. `periodBeats` > 0 syncs one cycle to that many beats
   * (`noteBeats('1/4')`); otherwise the clock runs at `hz`. Free-running, each call advances it by
   * `frames` samples (call it once per control step of `frames` samples, or once per sample).
   */
  next(transport: KernelTransport, i: number, hz: number, periodBeats = 0, frames = 1): number {
    if (periodBeats > 0 && transport.playing) {
      const pos = transport.beatAt(i) / periodBeats;
      const n = Math.floor(pos);
      this.cycle = n;
      this.phase = pos - n;
      return this.phase;
    }
    const rate = periodBeats > 0 ? transport.bpm / 60 / periodBeats : hz;
    let phase = this.phase + (rate * frames) / this.sampleRate;
    if (phase >= 1) {
      const whole = Math.floor(phase);
      phase -= whole;
      this.cycle += whole;
    }
    this.phase = phase;
    return phase;
  }

  reset(phase = 0): void {
    this.phase = phase;
    this.cycle = 0;
  }
}
