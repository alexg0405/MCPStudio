/**
 * Reading a song request ("a sad trap song at 140", "uplifting house, about 2 minutes") into what the generator needs:
 * a style, tempo, key, mood and length. What the words leave open comes from the seed, so the same words with another seed
 * give another song, and the same seed always gives the same one.
 */
import { hashString } from '../arrange/random';
import { parsePrompt } from '../beat/local/prompt';
import { TEMPO, type Style } from '../beat/style';
import type { Mood } from '../harmony/progressions';
import { PROFILES } from './profiles';
import { makeRng, streamFor } from './rng';
import type { SongKey, SongRequest } from './types';

/** Words that ask for a whole song rather than one loop. */
const SONG_WORDS =
  /\bsongs?\b|\b(?:full|whole|complete)\s+(?:track|beat|tune)\b|\bverses?\b|\bchorus\b|\bintro\b|\boutro\b|\bsections?\b|\b\d{2,3}\s*-?\s*bars\b|\b\d+(?:\.\d+)?\s*-?\s*(?:minutes?|mins?)\b|\binstrumental\b/;

/** Whether a request asks for a whole song (sections, a length) instead of a beat. */
export function isSongRequest(prompt: string): boolean {
  return SONG_WORDS.test(prompt.toLowerCase());
}

/** Words that name a mood, in the order they are looked for. */
const MOOD_WORDS: readonly (readonly [RegExp, Mood])[] = [
  [/\bsad\b|\bmelanchol|\bheartbreak|\blonely\b|\bblue\b|\bsorrow/, 'sad'],
  [/\bdark\b|\bevil\b|\bmenac|\baggressive\b|\bangry\b|\bscary\b|\bhaunt|\beerie\b|\bgritty\b/, 'dark'],
  [/\buplift|\bhopeful\b|\beuphori|\btriumph|\banthem/, 'uplifting'],
  [/\bhappy\b|\bjoy|\bfun\b|\bbright\b|\bsunny\b|\bcheerful\b|\bparty\b/, 'happy'],
  [/\bemotional\b|\bheartfelt\b|\bbittersweet\b|\bromantic\b/, 'emotional'],
  [/\bepic\b|\bcinematic\b|\bhuge\b|\bmassive\b|\bheroic\b/, 'epic'],
  [/\bdream|\bethereal\b|\bfloaty\b|\bairy\b/, 'dreamy'],
  [/\bchill\b|\brelax|\bmellow\b|\bcalm\b|\bcozy\b|\blaid[- ]?back\b/, 'chill'],
  [/\btense\b|\bsuspens|\banxious\b|\bnervous\b/, 'tense'],
  [/\bnostalg|\bretro\b|\bvintage\b/, 'nostalgic'],
  [/\bdramatic\b/, 'dramatic'],
  [/\bsmooth\b|\bsilky\b|\bsexy\b|\bgroovy\b/, 'smooth'],
  [/\bdriving\b|\benergetic\b|\bpowerful\b|\bintense\b/, 'driving'],
];

/** The mode a mood leans to (the others leave it to the style and the seed). */
const MOOD_MODE: Partial<Record<Mood, 'major' | 'minor'>> = {
  sad: 'minor',
  dark: 'minor',
  tense: 'minor',
  dramatic: 'minor',
  happy: 'major',
  uplifting: 'major',
};

/** The mood a request names, if any. */
function moodIn(text: string): Mood | undefined {
  return MOOD_WORDS.find(([pattern]) => pattern.test(text))?.[1];
}

/** "minor" or "major" said on its own ("a minor key trap song"), when the request names no key. */
function modeIn(text: string): 'major' | 'minor' | undefined {
  if (/\bminor\b/.test(text)) return 'minor';
  if (/\bmajor\b/.test(text)) return 'major';
  return undefined;
}

/** The length asked for in bars ("32 bars", "about 2 minutes", "90 seconds"), or undefined. */
function barsIn(text: string, bpm: number): number | undefined {
  const bars = /(\d{2,3})\s*-?\s*bars?\b/.exec(text);
  if (bars) return Number(bars[1]);
  const secondsPerBar = 240 / bpm;
  const minutes = /(\d+(?:\.\d+)?)\s*-?\s*(?:minutes?|mins?)\b/.exec(text);
  if (minutes) return Math.round((Number(minutes[1]) * 60) / secondsPerBar);
  const seconds = /(\d{2,3})\s*-?\s*(?:seconds?|secs?)\b/.exec(text);
  if (seconds) return Math.round(Number(seconds[1]) / secondsPerBar);
  if (/\bshort\b|\bquick\b|\bradio edit\b/.test(text)) return Math.round(75 / secondsPerBar);
  if (/\blong\b|\bextended\b|\bfull[- ]length\b/.test(text)) return Math.round(210 / secondsPerBar);
  return undefined;
}

/** The shortest and longest song the generator writes (bars). */
export const MIN_SONG_BARS = 24;
export const MAX_SONG_BARS = 160;

/** The styles a song request with no style word picks from, by seed. */
const OPEN_STYLES: readonly Style[] = ['trap', 'pop', 'house', 'lofi', 'edm', 'boombap', 'drill'];

/** A tempo inside the style's range, leaning to its usual one (so no two songs of a style are at the exact same speed). */
function tempoFor(style: Style, seed: number): number {
  const { min, max, default: usual } = TEMPO[style];
  const spread = streamFor(seed, 'tempo').next();
  return Math.round((usual + (min + spread * (max - min))) / 2);
}

/** The key's root and mode: named in the words, else a mode from the mood or the style, and a root from the seed. */
function keyFor(text: string, style: Style, mood: Mood | undefined, named: SongKey | undefined, seed: number): SongKey {
  if (named) return named;
  const random = streamFor(seed, 'key');
  const root = random.int(12);
  const mode = modeIn(text) ?? (mood ? MOOD_MODE[mood] : undefined);
  if (mode) return { root, minor: mode === 'minor' };
  return { root, minor: random.chance(PROFILES[style].minorShare) };
}

/** The seed a request gets when none is given: the words themselves, so the same words are the same song. */
export function seedOf(prompt: string, variation = 0): number {
  return (hashString(prompt.toLowerCase().replace(/\s+/g, ' ').trim()) + variation * 7919) >>> 0;
}

/** Reads a request. The tempo comes from the words or the style, never from the project: a song sets its own. */
export function readSongRequest(prompt: string, options: { seed?: number; variation?: number } = {}): SongRequest {
  const text = prompt.toLowerCase();
  const seed = options.seed ?? seedOf(prompt, options.variation ?? 0);
  const info = parsePrompt(prompt);
  const open = makeRng(seed ^ 0x51ed);
  const style: Style = info.style ?? (info.wants808 ? 'trap' : open.pick(OPEN_STYLES));
  const bpm = info.bpm ?? tempoFor(style, seed);
  const mood = moodIn(text);
  const key = keyFor(text, style, mood, info.key, seed);
  const request: SongRequest = {
    style,
    bpm,
    key,
    mood: mood ?? streamFor(seed, 'mood').pick(PROFILES[style].moods),
    seed,
    density: info.density,
    noHats: info.noHats,
  };
  const bars = barsIn(text, bpm);
  if (bars !== undefined) request.bars = Math.max(MIN_SONG_BARS, Math.min(MAX_SONG_BARS, bars));
  return request;
}
