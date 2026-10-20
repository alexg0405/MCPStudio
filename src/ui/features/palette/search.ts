/**
 * Ranking for the action search (Mod+K). Pure: entries come from menus, commands and providers.
 * Every query word has to match somewhere (label, menu path, hint or keywords); matches at the start
 * of a word count more, the label counts most, and recently used actions float up.
 */
import type { ActionEntry } from '../../shell/actions';

export type { ActionEntry };

/** Words newcomers use for the things AGstudio names differently. */
const SYNONYMS: Record<string, string[]> = {
  bpm: ['tempo'],
  tempo: ['bpm'],
  remove: ['delete', 'clear'],
  delete: ['remove', 'clear'],
  erase: ['delete', 'clear', 'remove'],
  new: ['add', 'create'],
  add: ['new', 'create', 'insert'],
  create: ['new', 'add'],
  make: ['new', 'add', 'create', 'write'],
  click: ['metronome'],
  metronome: ['click'],
  instrument: ['channel', 'plugin', 'synth'],
  synth: ['instrument', 'channel', 'plugin'],
  sound: ['channel', 'sample', 'instrument'],
  effect: ['fx', 'plugin', 'insert'],
  effects: ['fx', 'plugin', 'insert'],
  fx: ['effect'],
  track: ['insert', 'channel', 'lane'],
  arrange: ['playlist', 'song'],
  arrangement: ['playlist', 'song'],
  song: ['playlist'],
  beat: ['pattern', 'drum', 'step'],
  drums: ['kit', 'pattern', 'step'],
  melody: ['piano roll', 'notes'],
  notes: ['piano roll', 'note'],
  keys: ['piano', 'keyboard'],
  export: ['render', 'save'],
  render: ['export'],
  bounce: ['export', 'render'],
  mp3: ['export'],
  wav: ['export'],
  open: ['show', 'load'],
  show: ['open', 'view'],
  hide: ['show', 'view'],
  ai: ['assistant', 'claude', 'chatgpt', 'codex', 'studio'],
  help: ['getting started', 'tour', 'shortcuts'],
  shortcuts: ['keyboard'],
  record: ['arm', 'recording'],
  midi: ['controller', 'keyboard'],
  volume: ['level', 'gain'],
  loud: ['volume'],
  louder: ['volume'],
  quieter: ['volume'],
};

const wordStart = (hay: string, w: string) => {
  let i = hay.indexOf(w);
  while (i >= 0) {
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1]!)) return true;
    i = hay.indexOf(w, i + 1);
  }
  return false;
};

/** How well one word matches one entry (0 = not at all). */
function wordScore(e: Prepared, word: string): number {
  let best = 0;
  for (const w of [word, ...(SYNONYMS[word] ?? [])]) {
    const exact = w === word ? 1 : 0.7;
    let s = 0;
    if (e.label.startsWith(w)) s = 10;
    else if (wordStart(e.label, w)) s = 8;
    else if (e.label.includes(w)) s = 5;
    else if (wordStart(e.keywords, w)) s = 6;
    else if (wordStart(e.path, w)) s = 4;
    else if (wordStart(e.hint, w)) s = 3;
    else if (e.path.includes(w) || e.hint.includes(w) || e.keywords.includes(w)) s = 1;
    best = Math.max(best, s * exact);
  }
  return best;
}

interface Prepared {
  entry: ActionEntry;
  label: string;
  path: string;
  hint: string;
  keywords: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[…‘’“”"]/g, '').trim();

/** Entries matching `query`, best first. An empty query lists recent actions first, then everything. */
export function searchActions(entries: readonly ActionEntry[], query: string, recent: readonly string[] = []): ActionEntry[] {
  const rank = new Map(recent.map((k, i) => [k, i]));
  const recency = (e: ActionEntry) => {
    const i = rank.get(e.key);
    return i === undefined ? 0 : Math.max(0, 6 - i * 0.5);
  };
  const q = norm(query);
  if (!q) {
    return [...entries].sort((a, b) => {
      const ra = rank.get(a.key) ?? Infinity;
      const rb = rank.get(b.key) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.path.join(' ').localeCompare(b.path.join(' ')) || a.label.localeCompare(b.label);
    });
  }
  const words = q.split(/\s+/);
  const scored: { entry: ActionEntry; score: number }[] = [];
  for (const entry of entries) {
    const p: Prepared = {
      entry,
      label: norm(entry.label),
      path: norm(entry.path.join(' ')),
      hint: norm(entry.hint ?? ''),
      keywords: norm((entry.keywords ?? []).join(' ')),
    };
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = wordScore(p, w);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (p.label === q) score += 20;
    score += recency(entry) + (entry.boost ?? 0);
    if (entry.disabled) score -= 4;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.map((s) => s.entry);
}

/** Keeps the recent-actions list short, most recent first. */
export function pushRecent(recent: readonly string[], key: string, max = 20): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, max);
}
