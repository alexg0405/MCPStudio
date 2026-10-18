/**
 * The sample library as the AI (and MCP) reads it: the sounds of the musician's sample folders with what the analysis found,
 * filtered the way the window filters (`core/samples/query`). Compact JSON in the units the actions take; a sound's `id` is
 * what `place_sample` and `make_kit` accept (so are its path and file name).
 */
import { keyText, NO_FILTER, browse, countByCategory, fitsKey, similarTo, SORT_LABELS, type SampleFilter, type SampleSort } from '@core/samples/query';
import { PITCH_NAMES } from '@core/dj/key';
import { SAMPLE_CATEGORIES, type SampleCategory } from '@core/samples/types';
import type { SongKey } from '@core/model/types';
import type { BrowserRow, SampleBrowser } from './browser';

export const SAMPLE_SORTS = Object.keys(SORT_LABELS) as SampleSort[];
const MAX_LIMIT = 200;

/** "A minor", "Am", "C#", "Db", "F♯ major": a pitch class and the mode when it says one. */
export function parseSampleKey(text: string): { root: number; mode?: 'major' | 'minor' } | null {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|maj|major)?\s*$/.exec(text);
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[(m[1] as string).toLowerCase()] as number;
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  // A bare "b" is the note B; "bb" is B flat.
  const mode = m[3] ? (m[3].startsWith('maj') ? 'major' : 'minor') : undefined;
  return { root: (base + accidental + 12) % 12, ...(mode ? { mode } : {}) };
}

const isCategory = (v: unknown): v is SampleCategory => typeof v === 'string' && (SAMPLE_CATEGORIES as readonly string[]).includes(v);
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/** One sound for the listing. */
export function sampleLine(r: BrowserRow, distance?: number): Record<string, unknown> {
  const a = r.analysis;
  const type = !a ? (r.state === 'failed' ? 'not audio' : 'not analyzed yet') : a.kind === 'one-shot' ? (a.category ?? 'one-shot') : a.kind;
  const key = keyText(a);
  return {
    id: r.id,
    path: `${r.folder}/${r.path}`,
    type,
    ...(a?.kind === 'one-shot' && a.category ? { confidence: round(a.confidence) } : {}),
    ...(a?.bpm ? { bpm: round(a.bpm, 1) } : {}),
    ...(a?.bars ? { bars: a.bars } : {}),
    ...(a?.kind === 'loop' && a.loopKind ? { loop_of: a.loopKind } : {}),
    ...(key ? { key } : {}),
    ...(a ? { length_s: round(a.durationSec) } : {}),
    ...(a && a.kind !== 'long' && a.loudnessDb > -100 ? { loudness_db: round(a.loudnessDb, 1), brightness_hz: a.brightness } : {}),
    ...(r.favorite ? { favorite: true } : {}),
    ...(r.userTags.length ? { tags: [...r.userTags] } : {}),
    ...(distance !== undefined ? { distance: round(distance) } : {}),
  };
}

export function listSamples(
  browser: Pick<SampleBrowser, 'store' | 'find'>,
  args: Record<string, unknown>,
  song: { bpm: number; key?: SongKey | undefined },
): Record<string, unknown> {
  const st = browser.store.getState();
  const rows = st.rows as BrowserRow[];
  if (rows.length === 0)
    return {
      samples: [],
      note: 'No sample folders have been added (or they are empty): the musician adds a folder in the Sample browser window (View → Sample browser → Add folder…) and the sounds are listed here once analyzed.',
    };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const warnings: string[] = [];
  const filter: { -readonly [K in keyof SampleFilter]: SampleFilter[K] } = { ...NO_FILTER };
  const text = str(args.text);
  if (text) filter.text = text;
  if (args.category !== undefined) {
    if (isCategory(args.category)) filter.categories = [args.category];
    else warnings.push(`category must be one of: ${SAMPLE_CATEGORIES.join(', ')}`);
  }
  if (args.kind === 'one-shot' || args.kind === 'loop') filter.kind = args.kind;
  const lo = num(args.bpm_min);
  const hi = num(args.bpm_max);
  if (lo !== undefined || hi !== undefined) filter.bpm = [lo ?? 0, hi ?? 999];
  if (args.half_double === true) filter.halfDouble = true;
  let mode: 'major' | 'minor' | undefined;
  const keyArg = str(args.key);
  if (keyArg) {
    const k = parseSampleKey(keyArg);
    if (k) {
      filter.keys = [k.root];
      mode = k.mode;
    } else warnings.push(`key "${keyArg}" is not a note ("A", "C#", "A minor")`);
  }
  if (args.favorites === true) filter.favorites = true;
  if (args.recent === true) filter.recent = true;
  const tag = str(args.tag);
  if (tag) filter.tags = [tag.toLowerCase()];
  const folder = str(args.folder);
  if (folder) filter.under = folder;
  const sortArg = str(args.sort);
  const sort: SampleSort = sortArg && (SAMPLE_SORTS as string[]).includes(sortArg) ? (sortArg as SampleSort) : 'name';
  if (sortArg && sort !== sortArg) warnings.push(`sort must be one of: ${SAMPLE_SORTS.join(', ')}`);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(num(args.limit) ?? 40)));

  let matched: { row: BrowserRow; distance?: number }[];
  const similar = str(args.similar_to);
  if (similar) {
    const target = browser.find(similar);
    if (!target) return { error: `there is no sample "${similar}" (list_samples shows ids and paths)` };
    matched = similarTo(rows, target, limit).map((x) => ({ row: x.row as BrowserRow, distance: x.distance }));
  } else {
    let list = browse(rows, filter, sort, args.descending === true) as BrowserRow[];
    if (mode) list = list.filter((r) => r.analysis?.mode === undefined || r.analysis.mode === mode);
    if (args.in_song_key === true) {
      if (!song.key) warnings.push('in_song_key: the song has no key set');
      else list = list.filter((r) => fitsKey(r.analysis, song.key));
    }
    matched = list.map((row) => ({ row }));
  }
  const counts = countByCategory(rows);
  const folders = new Map<string, number>();
  for (const r of rows) folders.set(r.folder, (folders.get(r.folder) ?? 0) + 1);
  return {
    folders: [...folders].map(([name, files]) => ({ name, files })),
    files: rows.length,
    analyzed: counts.analyzed,
    ...(st.progress.running ? { analyzing: `${st.progress.done} of ${st.progress.total} files done: results are still coming in` } : {}),
    by_type: Object.fromEntries([...counts.byCategory].map(([c, n]) => [c, n])),
    loops: counts.loops,
    song: { bpm: song.bpm, ...(song.key ? { key: `${PITCH_NAMES[song.key.root % 12]} ${/minor/.test(song.key.scale) ? 'minor' : 'major'}` } : {}) },
    matching: matched.length,
    showing: Math.min(limit, matched.length),
    samples: matched.slice(0, limit).map((m) => sampleLine(m.row, m.distance)),
    ...(warnings.length ? { warnings } : {}),
  };
}
