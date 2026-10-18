/**
 * "Make a kit from these": which Drum Pads pad each one-shot goes on. The pads follow the General MIDI layout the
 * Drum Pads start with (pad 1 kick, 3 snare, 4 clap, 7 closed hat, 11 open hat, 14 crash…), so a kit made from a folder of
 * sounds plays like the default kit: a kick on pad 1, the snares on 3 and 5, hats on 7 and 9 (they choke each other),
 * toms from low to high up the left side. Whatever has no named pad fills the free ones. Pure.
 */
import type { SampleCategory } from './types';
import type { SampleRow } from './query';

export const PAD_COUNT = 16;

/** The pads each category prefers, best first. */
export const PAD_PREFERENCE: Readonly<Record<SampleCategory, readonly number[]>> = {
  kick: [1, 2],
  '808': [2, 1],
  snare: [3, 5],
  clap: [4, 5],
  hat: [7, 9],
  'open-hat': [11, 13],
  tom: [6, 8, 10, 12],
  cymbal: [14, 16],
  perc: [12, 15, 13, 16, 10],
  fx: [16, 15],
  vocal: [15, 16],
  tonal: [13, 15, 16],
};

export interface KitPlan {
  /** Entry on each pad 1…16 (index 0 is pad 1), or null for a pad left with its built-in sound. */
  pads: (SampleRow | null)[];
  /** Rows that could not be used: loops and long files, files not yet analyzed, and what did not fit on 16 pads. */
  skipped: { row: SampleRow; why: string }[];
}

/** Where sounds without a pad of their own go once the preferred pads are taken: the end of the kit first, the named drums last. */
const OVERFLOW = [16, 15, 13, 12, 14, 10, 8, 6, 11, 9, 7, 5, 4, 3, 2, 1] as const;

const pitchOf = (r: SampleRow): number => r.analysis?.midi ?? 0;

/**
 * Lays one-shots out on the pads. Within a category the louder-confident ones come first (they take the best pad); toms
 * go from the lowest note to the highest. Unrecognised one-shots are placed last, on free pads.
 */
export function planKit(rows: readonly SampleRow[]): KitPlan {
  const pads: (SampleRow | null)[] = Array.from({ length: PAD_COUNT }, () => null);
  const skipped: KitPlan['skipped'] = [];
  const byCategory = new Map<SampleCategory | 'none', SampleRow[]>();
  for (const r of rows) {
    const a = r.analysis;
    if (!a) {
      skipped.push({ row: r, why: 'not analyzed yet' });
      continue;
    }
    if (a.kind !== 'one-shot') {
      skipped.push({ row: r, why: a.kind === 'loop' ? 'a loop, not a one-shot' : 'too long for a pad' });
      continue;
    }
    const key = a.category ?? 'none';
    const list = byCategory.get(key) ?? [];
    list.push(r);
    byCategory.set(key, list);
  }
  const free = () => {
    const pad = OVERFLOW.find((n) => pads[n - 1] === null);
    return pad === undefined ? -1 : pad - 1;
  };
  const place = (r: SampleRow, preferred: readonly number[]) => {
    for (const n of preferred) {
      if (pads[n - 1] === null) {
        pads[n - 1] = r;
        return;
      }
    }
    const i = free();
    if (i >= 0) pads[i] = r;
    else skipped.push({ row: r, why: 'all 16 pads are taken' });
  };
  // The named drums first, so a second kick never takes the snare's pad.
  const order: SampleCategory[] = ['kick', 'snare', 'clap', 'hat', 'open-hat', 'tom', 'cymbal', '808', 'perc', 'fx', 'vocal', 'tonal'];
  for (const cat of order) {
    const list = byCategory.get(cat) ?? [];
    list.sort((x, y) => (cat === 'tom' ? pitchOf(x) - pitchOf(y) : (y.analysis?.confidence ?? 0) - (x.analysis?.confidence ?? 0)) || x.path.localeCompare(y.path));
    for (const r of list) place(r, PAD_PREFERENCE[cat]);
  }
  for (const r of (byCategory.get('none') ?? []).sort((x, y) => x.path.localeCompare(y.path))) place(r, []);
  return { pads, skipped };
}
