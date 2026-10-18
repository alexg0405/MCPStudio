/**
 * Finding samples: the tags a file shows, text search over names and tags, the filters (category, loop or one-shot, tempo
 * range, key, favorites, recently used, your own tags), sorting and the nearest sounds to one. Pure functions over
 * `SampleRow`s, so the window, the AI's listing and the tests all agree.
 */
import { PITCH_NAMES } from '../dj/key';
import { distance } from './similarity';
import { CATEGORY_LABELS, SAMPLE_CATEGORIES, type SampleAnalysis, type SampleCategory } from './types';

/** A file as the browser lists it: where it is, what the analysis found, and what you added. */
export interface SampleRow {
  id: string;
  /** The file name without extension. */
  name: string;
  /** Folder (as you added it) and path inside it, with `/`. */
  folder: string;
  path: string;
  analysis: SampleAnalysis | null;
  favorite: boolean;
  userTags: readonly string[];
  /** When it was last used (ms since 1970); 0 = never. */
  lastUsed: number;
}

export interface SampleFilter {
  /** Words that must all appear in the name, path, tags, key or tempo ("kick punchy", "128", "a minor"). */
  text: string;
  /** One-shot categories to show (empty: all). Loops are not in a category. */
  categories: readonly SampleCategory[];
  kind: 'any' | 'one-shot' | 'loop';
  /** Loops in this tempo range (BPM; a half or double of the range counts when `halfDouble`). Null: any. */
  bpm: readonly [number, number] | null;
  halfDouble: boolean;
  /** Pitch classes (0 = C) to show, for sounds with a note or key (empty: any). */
  keys: readonly number[];
  favorites: boolean;
  recent: boolean;
  /** Your own tags: all of them must be on the sample. */
  tags: readonly string[];
  /** Only files under this folder: `<folder>` or `<folder>/<subfolders>` (null: everywhere). */
  under: string | null;
}

export const NO_FILTER: SampleFilter = { text: '', categories: [], kind: 'any', bpm: null, halfDouble: false, keys: [], favorites: false, recent: false, tags: [], under: null };

export type SampleSort = 'name' | 'bpm' | 'key' | 'length' | 'recent' | 'category' | 'loudness';
export const SORT_LABELS: Readonly<Record<SampleSort, string>> = {
  name: 'Name',
  bpm: 'Tempo',
  key: 'Key',
  length: 'Length',
  recent: 'Recently used',
  category: 'Type',
  loudness: 'Loudness',
};

export const keyLabel = (root: number): string => PITCH_NAMES[((root % 12) + 12) % 12] as string;

/** "A minor", "C♯" (a one-shot's note), or null. */
export function keyText(a: SampleAnalysis | null): string | null {
  if (!a || a.root === undefined) return null;
  return a.mode ? `${keyLabel(a.root)} ${a.mode}` : keyLabel(a.root);
}

const brightnessWord = (hz: number): string => (hz < 700 ? 'dark' : hz < 3500 ? 'warm' : 'bright');

/** The tags shown on a row (not the ones you typed): what the analysis found, in words. */
export function analysisTags(a: SampleAnalysis | null): string[] {
  if (!a) return [];
  const tags: string[] = [];
  if (a.kind === 'loop') {
    tags.push('loop');
    if (a.loopKind) tags.push(`${a.loopKind} loop`);
    if (a.bpm) tags.push(`${Math.round(a.bpm)} bpm`);
    if (a.bars) tags.push(`${a.bars} bar${a.bars === 1 ? '' : 's'}`);
  } else if (a.kind === 'long') {
    tags.push('long');
  } else {
    tags.push('one-shot');
    if (a.category) tags.push(CATEGORY_LABELS[a.category].toLowerCase());
    if (a.category === 'kick' || a.category === '808') tags.push('low');
    if (a.durationSec < 0.25) tags.push('short');
    else if (a.durationSec > 2) tags.push('long');
  }
  const key = keyText(a);
  if (key) tags.push(key.toLowerCase());
  if (a.brightness > 0) tags.push(brightnessWord(a.brightness));
  return tags;
}

/** The haystack a text search looks in. */
function haystack(r: SampleRow): string {
  return [r.folder, r.path, ...analysisTags(r.analysis), ...r.userTags, r.favorite ? 'favorite' : ''].join(' ').toLowerCase();
}

/** Words of a search, lower case. A word with a leading "-" must be absent. */
export function searchWords(text: string): { has: string[]; not: string[] } {
  const has: string[] = [];
  const not: string[] = [];
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w.length > 1 && w.startsWith('-')) not.push(w.slice(1));
    else has.push(w);
  }
  return { has, not };
}

/** Whether a row's file is in the folder `under` names (`<folder>` or `<folder>/<subfolders>`). */
export function isUnder(r: Pick<SampleRow, 'folder' | 'path'>, under: string): boolean {
  const full = `${r.folder}/${r.path}`;
  return full === under || full.startsWith(under.endsWith('/') ? under : `${under}/`);
}

const inRange = (bpm: number, [lo, hi]: readonly [number, number]) => bpm >= lo && bpm <= hi;

/** Whether a row passes the filter. */
export function matches(r: SampleRow, f: SampleFilter): boolean {
  const a = r.analysis;
  if (f.favorites && !r.favorite) return false;
  if (f.recent && r.lastUsed <= 0) return false;
  if (f.tags.length > 0 && !f.tags.every((t) => r.userTags.includes(t))) return false;
  if (f.under !== null && !isUnder(r, f.under)) return false;
  if (f.kind !== 'any' && a?.kind !== f.kind) return false;
  if (f.categories.length > 0 && !(a?.category && f.categories.includes(a.category))) return false;
  if (f.bpm) {
    const bpm = a?.kind === 'loop' ? a.bpm : undefined;
    if (bpm === undefined) return false;
    const ok = inRange(bpm, f.bpm) || (f.halfDouble && (inRange(bpm * 2, f.bpm) || inRange(bpm / 2, f.bpm)));
    if (!ok) return false;
  }
  if (f.keys.length > 0 && !(a?.root !== undefined && f.keys.includes(a.root))) return false;
  if (f.text.trim()) {
    const { has, not } = searchWords(f.text);
    const hay = haystack(r);
    if (!has.every((w) => hay.includes(w))) return false;
    if (not.some((w) => hay.includes(w))) return false;
  }
  return true;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Ascending order of a number key with the rows that lack it last, whichever the direction. */
function byNumber(get: (r: SampleRow) => number | undefined, dir: 1 | -1) {
  return (x: SampleRow, y: SampleRow): number => {
    const a = get(x);
    const b = get(y);
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return (a - b) * dir;
  };
}

/** Sorted copy. `recent` puts the last used first by default; every other sort is ascending unless `descending`. */
export function sortRows(rows: readonly SampleRow[], sort: SampleSort, descending = false): SampleRow[] {
  const dir: 1 | -1 = descending ? -1 : 1;
  const byName = (x: SampleRow, y: SampleRow) => collator.compare(x.path, y.path);
  let cmp: (x: SampleRow, y: SampleRow) => number;
  switch (sort) {
    case 'name':
      cmp = (x, y) => byName(x, y) * dir;
      break;
    case 'bpm':
      cmp = byNumber((r) => r.analysis?.bpm, dir);
      break;
    case 'key':
      // By note, minor after major of the same note; sounds without a key last.
      cmp = byNumber((r) => (r.analysis?.root !== undefined ? r.analysis.root * 2 + (r.analysis.mode === 'minor' ? 1 : 0) : undefined), dir);
      break;
    case 'length':
      cmp = byNumber((r) => r.analysis?.durationSec, dir);
      break;
    case 'recent':
      cmp = byNumber((r) => (r.lastUsed > 0 ? r.lastUsed : undefined), descending ? 1 : -1);
      break;
    case 'category':
      cmp = byNumber((r) => (r.analysis?.category ? SAMPLE_CATEGORIES.indexOf(r.analysis.category) : r.analysis?.kind === 'loop' ? SAMPLE_CATEGORIES.length : undefined), dir);
      break;
    case 'loudness':
      cmp = byNumber((r) => r.analysis?.loudnessDb, dir);
      break;
  }
  return [...rows].sort((x, y) => cmp(x, y) || byName(x, y));
}

/** Filter, then sort. */
export function browse(rows: readonly SampleRow[], filter: SampleFilter, sort: SampleSort, descending = false): SampleRow[] {
  return sortRows(
    rows.filter((r) => matches(r, filter)),
    sort,
    descending,
  );
}

/** The sounds nearest to `target` (same kind), closest first, without the target itself. */
export function similarTo(rows: readonly SampleRow[], target: SampleRow, count = 20): { row: SampleRow; distance: number }[] {
  const a = target.analysis;
  if (!a) return [];
  const out: { row: SampleRow; distance: number }[] = [];
  for (const r of rows) {
    if (r.id === target.id || !r.analysis || r.analysis.kind !== a.kind) continue;
    let d = distance(a.vec, r.analysis.vec);
    // The same kind of sound (a kick for a kick) comes first among near ties.
    if (a.category && r.analysis.category !== a.category) d += 0.35;
    out.push({ row: r, distance: d });
  }
  out.sort((x, y) => x.distance - y.distance || collator.compare(x.row.path, y.row.path));
  return out.slice(0, count);
}

/** Pitch classes of the major and minor scale on `root`. */
function scaleSet(root: number, minor: boolean): ReadonlySet<number> {
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return new Set(steps.map((s) => (root + s) % 12));
}

/** Whether a sample fits a song key (the song's `scale` id says minor or major): a note inside the scale, a loop in the key or its relative. */
export function fitsKey(a: SampleAnalysis | null, key: { root: number; scale: string } | undefined): boolean {
  if (!a || a.root === undefined || !key) return false;
  const minor = /minor|aeolian|dorian|phrygian|locrian/.test(key.scale);
  const scale = scaleSet(key.root, minor);
  if (a.kind === 'loop') {
    const own = scaleSet(a.root, a.mode === 'minor');
    // Same notes: the same key or its relative.
    return [...own].every((p) => scale.has(p));
  }
  return scale.has(a.root);
}

/** The shift in semitones (−6…+5) that moves a note's pitch class onto the key's tonic, the smallest turn. */
export function semitonesToKey(root: number, tonic: number): number {
  return ((((tonic - root) % 12) + 18) % 12) - 6;
}

/** Counts per category (and loops) in a set of rows, for the chips. */
export function countByCategory(rows: readonly SampleRow[]): { byCategory: Map<SampleCategory, number>; loops: number; oneShots: number; analyzed: number } {
  const byCategory = new Map<SampleCategory, number>();
  let loops = 0;
  let oneShots = 0;
  let analyzed = 0;
  for (const r of rows) {
    const a = r.analysis;
    if (!a) continue;
    analyzed++;
    if (a.kind === 'loop') loops++;
    if (a.kind === 'one-shot') oneShots++;
    if (a.category) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1);
  }
  return { byCategory, loops, oneShots, analyzed };
}

/** User tags: trimmed, lower case, no empty ones, no duplicates, at most 24 characters. */
export function cleanTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 24);
}
