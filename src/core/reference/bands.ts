/**
 * Tonal balance, coarse: how a song's energy spreads over eight bands, and how two songs' balances
 * differ. The reference's numbers and the musician's mix are measured the same way (`app/reference/spectrum.ts`
 * splits at `TONE_CROSSOVERS`), then compared here. Pure.
 *
 * A balance is stored as each band's share of the energy in dB under the total (0 dB = all of it in
 * that band; a typical bass-heavy song has its lows around −3 and its air around −35). Shares, not
 * levels, so two songs compare at any loudness.
 */
import type { ReferenceSection, ReferenceTrack } from '../model/types';

/** One of the eight tonal bands: its id, how it is written and spoken about, and what in the mix changes it. */
export interface ToneBand {
  id: string;
  /** "Bass (60–150 Hz)". */
  label: string;
  /** "60–150 Hz". */
  range: string;
  /** How a sentence names it: "the bass". */
  name: string;
  /** What to touch to change it. */
  where: string;
}

/** The eight tonal bands, from the sub-bass up to the air, in order. */
export const TONE_BANDS: readonly ToneBand[] = [
  { id: 'sub', label: 'Sub-bass (below 60 Hz)', range: 'below 60 Hz', name: 'the sub-bass', where: 'the 808 or sub and a low shelf at 60 Hz' },
  { id: 'bass', label: 'Bass (60–150 Hz)', range: '60–150 Hz', name: 'the low end', where: 'the kick and bass levels or an EQ band around 100 Hz' },
  { id: 'lowMid', label: 'Low mids (150–400 Hz)', range: '150–400 Hz', name: 'the low mids (body)', where: 'an EQ band around 250 Hz' },
  { id: 'mid', label: 'Mids (400 Hz–1 kHz)', range: '400 Hz–1 kHz', name: 'the mids', where: 'an EQ band around 700 Hz' },
  { id: 'upperMid', label: 'Upper mids (1–2.5 kHz)', range: '1–2.5 kHz', name: 'the upper mids', where: 'an EQ band around 1.8 kHz' },
  { id: 'presence', label: 'Presence (2.5–5 kHz)', range: '2.5–5 kHz', name: 'the presence', where: 'an EQ band around 3.5 kHz (snares and leads live here)' },
  { id: 'highs', label: 'Highs (5–10 kHz)', range: '5–10 kHz', name: 'the highs', where: 'the hats and a high shelf at 6 kHz' },
  { id: 'air', label: 'Air (above 10 kHz)', range: 'above 10 kHz', name: 'the air', where: 'a high shelf at 10 kHz' },
];

/** Where the bands split (Hz): one fewer than the bands. */
export const TONE_CROSSOVERS: readonly number[] = [60, 150, 400, 1000, 2500, 5000, 10000];

/** The lowest share kept (dB): bands emptier than this read as −60. */
export const SHARE_FLOOR_DB = -60;

/** A band's energy over the total as dB, from raw energies. */
export function shareDb(energies: ArrayLike<number>): number[] {
  let total = 0;
  for (let i = 0; i < energies.length; i++) total += energies[i]!;
  const out: number[] = [];
  for (let i = 0; i < energies.length; i++) {
    const e = energies[i]!;
    const db = total > 0 && e > 0 ? 10 * Math.log10(e / total) : SHARE_FLOOR_DB;
    out.push(Math.round(Math.max(SHARE_FLOOR_DB, db) * 10) / 10);
  }
  return out;
}

const linear = (db: number) => Math.pow(10, db / 10);

/** Balances averaged by weight (as energy, then back to dB). */
export function mixShares(items: readonly { bands: readonly number[]; weight: number }[]): number[] {
  const n = TONE_BANDS.length;
  const sum = new Array<number>(n).fill(0);
  let w = 0;
  for (const it of items) {
    if (it.bands.length !== n || !(it.weight > 0)) continue;
    w += it.weight;
    for (let i = 0; i < n; i++) sum[i] = sum[i]! + it.weight * linear(it.bands[i]!);
  }
  return w > 0 ? shareDb(sum) : new Array<number>(n).fill(SHARE_FLOOR_DB);
}

/** Sections at least this energetic stand for "the song at full tilt". */
export const FULL_ENERGY = 0.6;

/**
 * The tone to compare a mix with: the reference's loud parts (sections at energy ≥ 0.6, by length), since
 * an intro or a break is not what the mix is trying to sound like; the whole song when it has none.
 */
export function mainTone(ref: Pick<ReferenceTrack, 'bands' | 'sections'>): number[] {
  const loud = ref.sections.filter((s: ReferenceSection) => s.energy >= FULL_ENERGY && s.bands.length === TONE_BANDS.length);
  if (!loud.length) return [...ref.bands];
  return mixShares(loud.map((s) => ({ bands: s.bands, weight: Math.max(0.1, s.endSec - s.startSec) })));
}

/**
 * How one band differs between the mix and the reference: each one's level and the difference (dB) after the overall
 * offset is taken out.
 */
export interface ToneDifference {
  band: ToneBand;
  index: number;
  mixDb: number;
  refDb: number;
  /** Mix minus reference after taking out the overall offset (+ = the mix has more there). */
  diffDb: number;
}

/**
 * The comparison of two tonal balances: every band, the bands that are too far off, and the overall offset and
 * threshold used (dB).
 */
export interface ToneComparison {
  /** Every band, in order. */
  bands: ToneDifference[];
  /** Bands more than the threshold off, the biggest first. */
  off: ToneDifference[];
  /** The offset taken out (the median of the raw differences): where the two songs' overall levels sit. */
  offsetDb: number;
  thresholdDb: number;
}

/** How far a band must differ from the reference, in dB, before it is called off. */
export const TONE_THRESHOLD_DB = 3;

const median = (v: readonly number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * How the mix's balance differs from the reference's, band by band. Shares add up to a constant, so one
 * heavy band makes every other band's share look lower; the median difference is taken out first so that
 * only the bands that stand out from the rest are named.
 */
export function compareTone(mix: readonly number[], ref: readonly number[], thresholdDb = TONE_THRESHOLD_DB): ToneComparison {
  const raw = TONE_BANDS.map((_, i) => (mix[i] ?? SHARE_FLOOR_DB) - (ref[i] ?? SHARE_FLOOR_DB));
  const offset = median(raw);
  const bands = TONE_BANDS.map(
    (band, index): ToneDifference => ({
      band,
      index,
      mixDb: mix[index] ?? SHARE_FLOOR_DB,
      refDb: ref[index] ?? SHARE_FLOOR_DB,
      diffDb: Math.round((raw[index]! - offset) * 10) / 10,
    }),
  );
  // Bands with next to nothing in both (the air of a dark song) say nothing.
  const off = bands
    .filter((b) => Math.abs(b.diffDb) > thresholdDb && Math.max(b.mixDb, b.refDb) > -45)
    .sort((a, b) => Math.abs(b.diffDb) - Math.abs(a.diffDb));
  return { bands, off, offsetDb: Math.round(offset * 10) / 10, thresholdDb };
}

/** "4 dB" (whole dB, at least 1). */
const dbText = (x: number) => `${Math.max(1, Math.round(Math.abs(x)))} dB`;

/** A sentence for one band that is off: what is different and what to do about it. */
export function toneAdvice(d: ToneDifference): string {
  const name = d.band.name;
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  if (d.diffDb < 0)
    return `${cap} (${d.band.range}) is ${dbText(d.diffDb)} lighter than the reference: bring it up about ${dbText(d.diffDb)} with ${d.band.where}.`;
  return `${cap} (${d.band.range}) is ${dbText(d.diffDb)} heavier than the reference: take it down about ${dbText(d.diffDb)} with ${d.band.where}.`;
}

/** The comparison in plain words, one line per band that is off (a single line when none is). */
export function toneLines(c: ToneComparison): string[] {
  if (!c.off.length) return [`The tonal balance is within ${c.thresholdDb} dB of the reference in every band.`];
  return c.off.map(toneAdvice);
}
