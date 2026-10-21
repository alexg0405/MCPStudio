/**
 * Word-by-word matching shared by everything that looks things up by what a person typed: the action search
 * (Mod+K), the Help window, and Studio's guess of which plugins and commands a request needs. Pure: no DOM, no app.
 *
 * An entry is matched word by word. A word matches a part of the entry (label, keywords, menu path, hint) and the
 * part decides how well: the start of the label counts most, a word inside the hint least. A word also matches
 * through its synonyms (what newcomers call things), at a lower weight than the word itself.
 */

/** What an entry offers to be matched against. */
export interface SearchEntry {
  label: string;
  /** Where it lives ("Options", "Count-in"), or the kind and category of a plugin. */
  path: readonly string[];
  hint?: string;
  /** Extra words people might type for it ("bpm" for tempo). */
  keywords?: readonly string[];
}

/** Words mapped to other words that mean the same to a newcomer. */
export type Synonyms = Readonly<Record<string, readonly string[]>>;

/** Words newcomers use for the things AGstudio names differently. */
export const SYNONYMS: Synonyms = {
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

/** An entry with its parts lower-cased and joined, ready to be matched (do it once per entry, not once per word). */
export interface PreparedEntry {
  label: string;
  path: string;
  hint: string;
  keywords: string;
}

/** Lower-cases, and drops the punctuation that menu labels carry (the ellipsis and quotes). */
export const normalizeText = (text: string): string => text.toLowerCase().replace(/[…‘’“”"]/g, '').trim();

export function prepareEntry(entry: SearchEntry): PreparedEntry {
  return {
    label: normalizeText(entry.label),
    path: normalizeText(entry.path.join(' ')),
    hint: normalizeText(entry.hint ?? ''),
    keywords: normalizeText((entry.keywords ?? []).join(' ')),
  };
}

/** Whether `word` starts a word inside `text` (not just appears in the middle of one). */
function startsAWord(text: string, word: string): boolean {
  let at = text.indexOf(word);
  while (at >= 0) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

/** How well the word `w` itself matches the entry (0 = not at all; 10 = the start of the label). */
function partScore(e: PreparedEntry, w: string): number {
  if (e.label.startsWith(w)) return 10;
  if (startsAWord(e.label, w)) return 8;
  if (e.label.includes(w)) return 5;
  if (startsAWord(e.keywords, w)) return 6;
  if (startsAWord(e.path, w)) return 4;
  if (startsAWord(e.hint, w)) return 3;
  if (e.path.includes(w) || e.hint.includes(w) || e.keywords.includes(w)) return 1;
  return 0;
}

/** The weight of a match through a synonym, against 1 for the typed word itself. */
const SYNONYM_WEIGHT = 0.7;

/** How well one typed word matches one entry (0 = not at all), counting its synonyms. */
export function wordScore(e: PreparedEntry, word: string, synonyms: Synonyms = SYNONYMS): number {
  let best = 0;
  for (const w of [word, ...(synonyms[word] ?? [])]) {
    const weight = w === word ? 1 : SYNONYM_WEIGHT;
    best = Math.max(best, partScore(e, w) * weight);
  }
  return best;
}
