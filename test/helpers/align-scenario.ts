/**
 * A lead and a double for vocal-alignment tests: the same ten syllables, the double with each start moved by up to
 * `jitterSec` either way, each length changed by up to `stretch` (a share) and each pitch a little off, so the
 * correct alignment is known. The lead has vibrato; the double has none.
 */
import { mulberry32 } from '../../src/core/voice/test-signals';
import { singSyllables, type Syllable } from './syllables';

/** The pitches of the ten syllables (MIDI). */
const MELODY = [60, 62, 64, 62, 60, 65, 64, 62, 67, 60];
/** Seconds between syllable starts in the lead, and how long each lasts. */
const SPACING_SEC = 0.55;
const SYLLABLE_SEC = 0.3;
const FIRST_START_SEC = 0.35;

/** How the double differs from the lead. */
export interface ScenarioOptions {
  sampleRate: number;
  seed?: number;
  /** Each syllable of the double starts this much earlier or later at most, seconds. */
  jitterSec?: number;
  /** Each syllable of the double is this share longer or shorter at most (0.15 = ±15 %). */
  stretch?: number;
  /** Each syllable of the double is sung this many cents off at most. */
  detuneCents?: number;
  /** The whole double comes this much later (negative: earlier), seconds, on top of the jitter. */
  offsetSec?: number;
  /** Number of syllables (default all ten). */
  syllables?: number;
}

/** The two voices and the true syllable starts. */
export interface Scenario {
  lead: Float32Array;
  double: Float32Array;
  leadStarts: number[];
  doubleStarts: number[];
  seconds: number;
}

/** Builds the lead and the double. */
export function makeScenario(opts: ScenarioOptions): Scenario {
  const random = mulberry32(opts.seed ?? 3);
  const count = opts.syllables ?? MELODY.length;
  const jitter = opts.jitterSec ?? 0.08;
  const stretch = opts.stretch ?? 0.15;
  const detune = opts.detuneCents ?? 0;
  const seconds = FIRST_START_SEC + count * SPACING_SEC + 0.4 + Math.max(0, opts.offsetSec ?? 0);
  const lead: Syllable[] = [];
  const double: Syllable[] = [];
  for (let k = 0; k < count; k++) {
    const midi = MELODY[k % MELODY.length] as number;
    const start = FIRST_START_SEC + k * SPACING_SEC;
    lead.push({ startSec: start, durationSec: SYLLABLE_SEC, midi: (t) => midi + 0.25 * Math.sin(2 * Math.PI * 5.5 * t) });
    const moved = start + (opts.offsetSec ?? 0) + (random() * 2 - 1) * jitter;
    const length = SYLLABLE_SEC * (1 + (random() * 2 - 1) * stretch);
    const off = ((random() * 2 - 1) * detune) / 100;
    double.push({ startSec: moved, durationSec: length, midi: midi + off, level: 0.22 });
  }
  return {
    lead: singSyllables(lead, opts.sampleRate, seconds),
    double: singSyllables(double, opts.sampleRate, seconds, 8),
    leadStarts: lead.map((s) => s.startSec),
    doubleStarts: double.map((s) => s.startSec),
    seconds,
  };
}
