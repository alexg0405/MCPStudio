// FM (phase modulation) building blocks: a sine operator and the classic 4-operator algorithms.
// Allocation-free; usable on any thread.

const SIN_BITS = 12;
const SIN_SIZE = 1 << SIN_BITS;
/** One sine cycle plus a wrap-around copy, for linear reads. */
const SIN = new Float32Array(SIN_SIZE + 1);
for (let i = 0; i <= SIN_SIZE; i++) SIN[i] = Math.sin((2 * Math.PI * i) / SIN_SIZE);

/** sin(2π·cycles) from a 4096-point table (error below 1e-6): several times faster than Math.sin. */
export function sinCycles(cycles: number): number {
  const x = (cycles - Math.floor(cycles)) * SIN_SIZE;
  const i = x | 0;
  const a = SIN[i] as number;
  return a + ((SIN[i + 1] as number) - a) * (x - i);
}

const INV_2PI = 1 / (2 * Math.PI);

/**
 * A sine operator for FM synthesis: `next(inc, pm, amp)` returns `amp · sin(2π·phase + pm)` and
 * advances the phase by `inc` cycles. `pm` is the phase modulation in radians (the sum of the
 * operators that modulate this one). `feedback(inc, amount, amp)` modulates the operator with its
 * own output (the average of its last two samples, as Yamaha's chips do, so it stays smooth).
 */
export class FmOperator {
  /** Phase in cycles (0–1). */
  phase = 0;
  /** The last output. */
  out = 0;
  private prev = 0;

  next(inc: number, pm: number, amp: number): number {
    const y = amp * sinCycles(this.phase + pm * INV_2PI);
    let ph = this.phase + inc;
    if (ph >= 1) ph -= Math.floor(ph);
    this.phase = ph;
    this.prev = this.out;
    this.out = y;
    return y;
  }

  /**
   * Self-modulation: `amount` 0–1 (up to 1.5 radians per unit of output, where it is sawtooth-like;
   * much more turns it into noise), plus any other `pm`.
   */
  feedback(inc: number, amount: number, amp: number, pm = 0): number {
    return this.next(inc, pm + amount * 0.75 * (this.out + this.prev), amp);
  }

  reset(phase = 0): void {
    this.phase = phase;
    this.out = 0;
    this.prev = 0;
  }
}

/** How four operators connect: who modulates whom, and which ones you hear. */
export interface FmAlgorithm {
  /** The routing in words, e.g. "4→3→2→1" (an arrow means "modulates"). */
  readonly label: string;
  /** A plain description for hints. */
  readonly description: string;
  /**
   * For each operator (index 0 = operator 1 … 3 = operator 4), the operators that modulate it.
   * Modulators always have higher numbers, so computing operator 4 first, then 3, 2 and 1 sees
   * every modulator's output of the same sample.
   */
  readonly modulators: readonly (readonly number[])[];
  /** The operators that are heard (index 0 = operator 1). */
  readonly carriers: readonly number[];
}

/**
 * The eight classic 4-operator algorithms (Yamaha DX21, DX27, DX100, TX81Z), operators numbered
 * 1–4 with 4 at the top. Operator 4 is the one with feedback.
 */
export const FM_ALGORITHMS: readonly FmAlgorithm[] = [
  {
    label: '4→3→2→1',
    description: 'One stack: each operator modulates the next; only 1 is heard. Rich, brassy, bass.',
    modulators: [[1], [2], [3], []],
    carriers: [0],
  },
  {
    label: '(3+4)→2→1',
    description: '3 and 4 both modulate 2, which modulates 1; only 1 is heard.',
    modulators: [[1], [2, 3], [], []],
    carriers: [0],
  },
  {
    label: '(4 + 3→2)→1',
    description: '4, and the pair 3→2, both modulate 1; only 1 is heard.',
    modulators: [[1, 3], [2], [], []],
    carriers: [0],
  },
  {
    label: '(4→3 + 2)→1',
    description: 'The pair 4→3, and 2, both modulate 1; only 1 is heard.',
    modulators: [[1, 2], [], [3], []],
    carriers: [0],
  },
  {
    label: '2→1, 4→3',
    description: 'Two pairs: 2 modulates 1 and 4 modulates 3; 1 and 3 are heard. Electric pianos, bells.',
    modulators: [[1], [], [3], []],
    carriers: [0, 2],
  },
  {
    label: '4→(1, 2, 3)',
    description: '4 modulates 1, 2 and 3, which are all heard. Organs, pads.',
    modulators: [[3], [3], [3], []],
    carriers: [0, 1, 2],
  },
  {
    label: '4→3, 2, 1',
    description: '4 modulates 3; 1, 2 and 3 are heard.',
    modulators: [[], [], [3], []],
    carriers: [0, 1, 2],
  },
  {
    label: '1, 2, 3, 4',
    description: 'No modulation: four sines added together (additive). Drawbar organs.',
    modulators: [[], [], [], []],
    carriers: [0, 1, 2, 3],
  },
];
