/** An attack in the input: its frame and how strong it is. */
export interface Onset {
  at: number;
  strength: number;
}

/** Fills `dst[0..n)` with the mono mix from frame `from` (zeros outside the signal). */
export type MonoReader = (dst: Float32Array, from: number, n: number) => void;

/** Energies are measured on hops of 1/375 s (2.7 ms), at least 32 frames. */
const HOPS_PER_SECOND = 375;
const MIN_HOP_FRAMES = 32;
/** Fewer hops than this is too short to hold an attack. */
const MIN_HOPS = 16;
/** The energy before a hop is the mean of this many hops (~20 ms)… */
const HOPS_BEFORE = 8;
/** …and the energy after it is the mean of this many (~10 ms). */
const HOPS_AFTER = 4;
/** Attacks must be within 40 dB (energy 1e-4) of the loudest moment. */
const GATE_ENERGY_RATIO = 1e-4;
/** The energy must rise at least 9 dB (a factor of 8 in energy) over what came before. */
const RISE_ENERGY_RATIO = 8;
/** Keeps the comparison finite when the signal before an attack is digital silence. */
const ENERGY_FLOOR = 1e-12;
/** Where the attack starts: the first frame that reaches this share of the window's peak. */
const ATTACK_START_SHARE = 0.3;
/** The reader's block (frames), so any signal is read a few thousand frames at a time. */
const READ_BLOCK_FRAMES = 4096;

/**
 * Attacks in a mono signal: frames where the energy of the next ~10 ms jumps by 9 dB or more over
 * the ~20 ms before, and is within 40 dB of the loudest moment. Cheap (energy per 128-frame hop).
 */
export function detectOnsets(mono: Float32Array, sampleRate: number): Onset[] {
  return detectOnsetsLazy(mono.length, (dst, from, n) => dst.set(mono.subarray(from, from + n)), sampleRate);
}

/** `detectOnsets` for a mix that isn't in memory as one array: the energies are read a hop at a time. */
export function detectOnsetsLazy(length: number, read: MonoReader, sampleRate: number): Onset[] {
  const hop = Math.max(MIN_HOP_FRAMES, Math.round(sampleRate / HOPS_PER_SECOND));
  const hops = Math.floor(length / hop);
  if (hops < MIN_HOPS) return [];
  const energies = hopEnergies(read, hop, hops);
  const runs = risingRuns(energies, hop, hops);
  const window = new Float32Array((HOPS_AFTER + 2) * hop + hop);
  return runs.map((run) => withAttackStart(run, length, hop, read, window));
}

/** Mean square of every hop of the signal. */
function hopEnergies(read: MonoReader, hop: number, hops: number): Float64Array {
  const block = new Float32Array(Math.max(hop, READ_BLOCK_FRAMES));
  const energies = new Float64Array(hops);
  for (let k0 = 0; k0 < hops;) {
    const k1 = Math.min(hops, k0 + Math.floor(block.length / hop));
    read(block, k0 * hop, (k1 - k0) * hop);
    for (let k = k0; k < k1; k++) {
      let sum = 0;
      for (let i = (k - k0) * hop, end = i + hop; i < end; i++) {
        const v = block[i] as number;
        sum += v * v;
      }
      energies[k] = sum / hop;
    }
    k0 = k1;
  }
  return energies;
}

/** The mean energy of the `count` hops from `from`. */
function meanEnergy(energies: Float64Array, from: number, count: number): number {
  let sum = 0;
  for (let j = 0; j < count; j++) sum += energies[from + j] as number;
  return sum / count;
}

/**
 * The strongest hop of every run of consecutive hops where the energy rises sharply: one onset per
 * attack, however many hops its rise spans.
 */
function risingRuns(energies: Float64Array, hop: number, hops: number): Onset[] {
  let loud = 0;
  for (let k = 0; k + HOPS_AFTER <= hops; k++) loud = Math.max(loud, meanEnergy(energies, k, HOPS_AFTER));
  const gate = loud * GATE_ENERGY_RATIO;
  const onsets: Onset[] = [];
  let runBest: Onset | null = null;
  for (let k = HOPS_BEFORE; k + HOPS_AFTER <= hops; k++) {
    let pre = 0;
    for (let j = 1; j <= HOPS_BEFORE; j++) pre += energies[k - j] as number;
    pre /= HOPS_BEFORE;
    const post = meanEnergy(energies, k, HOPS_AFTER);
    const isRising = post > gate && post > RISE_ENERGY_RATIO * pre + ENERGY_FLOOR;
    if (isRising) {
      const strength = Math.sqrt(post) - Math.sqrt(pre);
      if (!runBest || strength > runBest.strength) runBest = { at: k * hop, strength };
    } else if (runBest) {
      onsets.push(runBest);
      runBest = null;
    }
  }
  if (runBest) onsets.push(runBest);
  return onsets;
}

/** The start of the attack: the first sample of the jump's window (read into `window`) that reaches 30 % of its peak. */
function withAttackStart(onset: Onset, length: number, hop: number, read: MonoReader, window: Float32Array): Onset {
  const from = Math.max(0, onset.at - hop);
  const to = Math.min(length, onset.at + (HOPS_AFTER + 1) * hop);
  read(window, from, to - from);
  let peak = 0;
  for (let i = 0; i < to - from; i++) peak = Math.max(peak, Math.abs(window[i] as number));
  let at = from;
  while (at < to && Math.abs(window[at - from] as number) < ATTACK_START_SHARE * peak) at++;
  return { at, strength: onset.strength };
}
