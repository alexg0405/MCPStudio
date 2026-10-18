/**
 * What a file's name and folders say about it: producers name their sounds ("Kick_Hard_03", "808 Bass C#1", "Drum Loop 128
 * bpm Am"), and a folder called "Snares" is a strong hint. Used as a nudge for the classifier and to read a tempo or key
 * the file says. Pure.
 */
import { PITCH_NAMES } from '../dj/key';
import type { SampleCategory } from './types';

export interface NameHint {
  /** A category the file name names. */
  category?: SampleCategory;
  /** A category a folder name names (weaker). */
  folderCategory?: SampleCategory;
  /** The name says "loop" / "one shot". */
  kind?: 'loop' | 'one-shot';
  /** A tempo the name says ("128bpm", "bpm128", "_128_" next to the word loop). */
  bpm?: number;
  /** A key the name says ("Am", "F#min", "C# minor"): tonic pitch class and mode when it says one. */
  root?: number;
  mode?: 'major' | 'minor';
}

const WORDS: readonly [SampleCategory, readonly string[]][] = [
  ['open-hat', ['openhat', 'openhihat', 'ophat', 'oh', 'ohh', 'ohat', 'openhh', 'hatopen', 'hihatopen', 'hhopen', 'open']],
  ['hat', ['hat', 'hats', 'hihat', 'hihats', 'hh', 'hhat', 'closedhat', 'chh', 'ch', 'closed']],
  ['cymbal', ['crash', 'ride', 'cymbal', 'cymbals', 'cym', 'splash', 'china']],
  ['kick', ['kick', 'kicks', 'bd', 'bassdrum', 'kik', 'kck', 'kicksub']],
  ['snare', ['snare', 'snares', 'sd', 'snr', 'rimshot', 'snaredrum']],
  ['clap', ['clap', 'claps', 'clp', 'handclap']],
  ['tom', ['tom', 'toms', 'floortom']],
  ['perc', ['perc', 'percs', 'percussion', 'shaker', 'tamb', 'tambourine', 'conga', 'bongo', 'rim', 'cowbell', 'clave', 'snap', 'woodblock', 'block', 'triangle', 'cabasa', 'guiro', 'maracas']],
  ['808', ['808', '808s', 'sub', 'bass', 'bassline', 'reese', '909bass']],
  ['fx', ['fx', 'sfx', 'riser', 'risers', 'sweep', 'sweeps', 'impact', 'downlifter', 'uplifter', 'whoosh', 'noise', 'texture', 'transition', 'crash fx', 'effect', 'effects', 'glitch', 'reverse']],
  ['vocal', ['vox', 'vocal', 'vocals', 'acapella', 'acappella', 'chant', 'shout', 'voice', 'adlib', 'adlibs', 'choir', 'hook']],
  ['tonal', ['synth', 'lead', 'pad', 'pads', 'pluck', 'plucks', 'chord', 'chords', 'keys', 'piano', 'guitar', 'stab', 'stabs', 'arp', 'bell', 'bells', 'organ', 'string', 'strings', 'brass', 'flute', 'melody', 'note']],
];

/** Lower-case words of a name: split on anything that isn't a letter or digit, and at camelCase and letter/digit joins. */
export function nameTokens(text: string): string[] {
  const spaced = text
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9#♯]+/)
    .filter(Boolean);
}

function categoryOf(tokens: string[]): SampleCategory | undefined {
  const has = (w: string) => tokens.includes(w);
  const hatWord = ['hat', 'hats', 'hihat', 'hihats', 'hh', 'hhat'].some(has);
  // Two-word names: "open hat", "hi hat open", "bass drum".
  if (hatWord && ['open', 'opened', 'oh', 'ohh'].some(has)) return 'open-hat';
  if (['openhat', 'ophat', 'ohat', 'openhh', 'openhihat', 'ohh'].some(has)) return 'open-hat';
  if (has('hi') && has('hat')) return has('open') ? 'open-hat' : 'hat';
  if (has('bass') && has('drum')) return 'kick';
  if (has('rim') && has('shot')) return 'snare';
  for (const [cat, words] of WORDS) {
    if (cat === 'open-hat') continue;
    // "open", "closed", "ch" and "oh" alone mean little: only beside a hat word (above).
    for (const w of words) {
      if (w === 'open' || w === 'closed' || w === 'ch' || w === 'oh') continue;
      if (has(w)) return cat;
    }
  }
  return undefined;
}

/** A key in a name: "Am", "F#min", "C# minor", "Dmaj": the tokens after the letters, joined with the mode word. */
function keyOf(tokens: string[]): { root: number; mode?: 'major' | 'minor' } | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    // "FM" and "DM" are synthesis and drum machines, not F minor and D minor.
    if (t === 'fm' || t === 'dm') continue;
    const next = tokens[i + 1];
    const m = /^([a-g])([#♯]?)(m|min|minor|maj|major)?$/.exec(t);
    if (!m) continue;
    const letter = m[1] as string;
    const sharp = m[2] ? 1 : 0;
    let mode: 'major' | 'minor' | undefined = m[3] ? (m[3].startsWith('maj') ? 'major' : 'minor') : undefined;
    if (!mode && (next === 'min' || next === 'minor')) mode = 'minor';
    if (!mode && (next === 'maj' || next === 'major')) mode = 'major';
    // A bare letter ("a", "e") is a word; a key needs a mode or a sharp.
    if (!mode && !sharp) continue;
    const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[letter] as number;
    return { root: (base + sharp) % 12, ...(mode ? { mode } : {}) };
  }
  return undefined;
}

/** Hints from a file's path (folders joined with `/`). */
export function nameHint(path: string): NameHint {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.pop() ?? '';
  const folders = parts.slice(-2);
  const tokens = nameTokens(file);
  const out: NameHint = {};
  const category = categoryOf(tokens);
  if (category) out.category = category;
  for (const folder of folders.reverse()) {
    const c = categoryOf(nameTokens(folder));
    if (c) {
      out.folderCategory = c;
      break;
    }
  }
  if (tokens.includes('loop') || tokens.includes('loops')) out.kind = 'loop';
  else if (tokens.includes('oneshot') || (tokens.includes('one') && tokens.includes('shot')) || tokens.includes('shot') || tokens.includes('oneshots')) out.kind = 'one-shot';
  // "128 bpm", "bpm 128", "128bpm"
  const joined = ` ${nameTokens(file).join(' ')} `;
  const bpm = /\b(\d{2,3})\s*bpm\b/.exec(joined) ?? /\bbpm\s*(\d{2,3})\b/.exec(joined);
  if (bpm) {
    const v = Number(bpm[1]);
    if (v >= 50 && v <= 220) out.bpm = v;
  } else if (out.kind === 'loop') {
    // A bare number near the word loop ("Drum Loop 128 Am").
    const n = tokens.map((t) => Number(t)).find((v) => Number.isInteger(v) && v >= 70 && v <= 200);
    if (n !== undefined) out.bpm = n;
  }
  const key = keyOf(tokens);
  if (key) {
    out.root = key.root;
    if (key.mode) out.mode = key.mode;
  } else {
    // A note name ("808 C#1", "Bass A2", "Lead Eb3"): an upper-case letter, a sharp or flat, an octave.
    const m = /(?:^|[^A-Za-z])([A-G])([#♯b]?)(-?\d)(?![0-9A-Za-z])/.exec(file.replace(/\.[A-Za-z0-9]{2,5}$/, ''));
    if (m) {
      const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as string] as number;
      out.root = (base + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
    }
  }
  return out;
}

/** "C♯" for a pitch class. */
export const pitchName = (root: number): string => PITCH_NAMES[((root % 12) + 12) % 12] as string;
