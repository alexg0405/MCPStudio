/**
 * The song's harmony: a stock progression chosen for the style and mood (a different one for each seed), and the four-bar
 * chord loops each kind of section plays: the verse and intro on the progression, the chorus on it or on a second one,
 * the build on the progression turned around so it ends leaning into the chorus, the break on yet another turn of it.
 */
import { chordPitchClasses, mod12, sameChord, type ChordSymbol } from '../harmony/chord';
import { PROGRESSIONS, progressionChords, withSeventh, type Progression } from '../harmony/progressions';
import { FOUR_FLOOR, type Style } from '../beat/style';
import { PROFILES } from './profiles';
import { streamFor, type Rng } from './rng';
import type { PlacedChord, SongKey, SongRequest } from './types';

/** Steps in a bar and bars in a pattern: every progression the song uses is laid out as one four-bar loop. */
export const STEPS_PER_BAR = 16;
export const PATTERN_BARS = 4;
export const PATTERN_STEPS = STEPS_PER_BAR * PATTERN_BARS;

/** The chord loops of each kind of section. */
export type HarmonyKind = 'verse' | 'chorus' | 'build' | 'break';

/** The song's chords. */
export interface SongHarmony {
  progression: Progression;
  /** The second progression the chorus uses when it is not the first (the same one otherwise). */
  chorusProgression: Progression;
  /** One four-bar chord loop per kind of section. */
  loops: Record<HarmonyKind, PlacedChord[]>;
}

/** One chord per bar of a progression laid out over `PATTERN_BARS` bars; null when its length does not fit them. */
function chordsPerBar(progression: Progression, key: SongKey, sevenths: boolean): ChordSymbol[] | null {
  const scale = key.minor ? 'minor' : 'major';
  const slots = progressionChords(progression, { root: key.root, scale });
  const bars: ChordSymbol[] = [];
  for (const slot of slots) {
    const chord = sevenths ? withSeventh(slot.chord, { root: key.root, scale }) : slot.chord;
    for (let bar = 0; bar < slot.bars; bar++) bars.push(chord);
  }
  const length = bars.length;
  if (length === 0 || PATTERN_BARS % length !== 0) return null;
  return Array.from({ length: PATTERN_BARS }, (_, bar) => bars[bar % length] as ChordSymbol);
}

/** Bars of chords turned into placed chords: neighbours that are the same chord become one long chord. */
function placeChords(perBar: readonly ChordSymbol[]): PlacedChord[] {
  const placed: PlacedChord[] = [];
  perBar.forEach((chord, bar) => {
    const last = placed[placed.length - 1];
    if (last && sameChord(last.chord, chord)) last.length += STEPS_PER_BAR;
    else placed.push({ step: bar * STEPS_PER_BAR, length: STEPS_PER_BAR, chord });
  });
  return placed;
}

/** The bars of a loop started `bars` later (the loop turned around). */
const rotated = (perBar: readonly ChordSymbol[], bars: number): ChordSymbol[] =>
  perBar.map((_, bar) => perBar[(bar + bars) % perBar.length] as ChordSymbol);

/** How well a progression suits the request: its mood and genre tags, with a seeded nudge so seeds differ. */
function scoreOf(progression: Progression, request: SongRequest, random: Rng): number {
  const profile = PROFILES[request.style];
  let score = random.next() * 1.5;
  if ((progression.moods as readonly string[]).includes(request.mood)) score += 4;
  for (const mood of profile.moods) if ((progression.moods as readonly string[]).includes(mood)) score += 0.8;
  for (const genre of profile.genres) if ((progression.genres as readonly string[]).includes(genre)) score += 1.6;
  return score;
}

/** The progressions that fit four bars in the song's mode, best first (for this request and seed). */
export function rankedProgressions(request: SongRequest): Progression[] {
  const mode = request.key.minor ? 'minor' : 'major';
  const random = streamFor(request.seed, 'progression');
  return PROGRESSIONS.filter((p) => p.mode === mode && chordsPerBar(p, request.key, false) !== null)
    .map((progression) => ({ progression, score: scoreOf(progression, request, random) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.progression);
}

/** A choice among the best few, so the best fit does not win every seed. */
function pickFrom(ranked: readonly Progression[], random: Rng): Progression {
  const top = ranked.slice(0, 4);
  return random.weighted(top.map((item, index) => ({ item, weight: 4 - index })));
}

/** Whether the chorus plays a second progression: dance music keeps one loop, songs often change it. */
function chorusChangesChords(style: Style, random: Rng): boolean {
  return random.chance(FOUR_FLOOR.has(style) ? 0.15 : 0.45);
}

/** The chords of the whole song for a request. */
export function chooseHarmony(request: SongRequest): SongHarmony {
  const random = streamFor(request.seed, 'harmony');
  const ranked = rankedProgressions(request);
  const progression = pickFrom(ranked, random);
  const others = ranked.filter((p) => p.id !== progression.id);
  const chorusProgression =
    others.length > 0 && chorusChangesChords(request.style, random) ? pickFrom(others, random) : progression;
  const sevenths = random.chance(PROFILES[request.style].seventhsShare);
  const verse = chordsPerBar(progression, request.key, sevenths) as ChordSymbol[];
  const chorus = chordsPerBar(chorusProgression, request.key, sevenths) as ChordSymbol[];
  return {
    progression,
    chorusProgression,
    loops: {
      verse: placeChords(verse),
      chorus: placeChords(chorus),
      build: placeChords(rotated(verse, 2)),
      break: placeChords(rotated(verse, random.chance(0.5) ? 1 : 3)),
    },
  };
}

/** The chord sounding at a step of a loop (the last one for a step past its end). */
export function chordAtStep(chords: readonly PlacedChord[], step: number): ChordSymbol {
  const found = chords.find((entry) => step >= entry.step && step < entry.step + entry.length);
  return (found ?? (chords[chords.length - 1] as PlacedChord)).chord;
}

/** The chord's notes as pitch classes (root first). */
export const tonesOfChord = (chord: ChordSymbol): number[] => chordPitchClasses(chord);

/** The root of a chord as a pitch class, or its slash bass. */
export const bassPitchClass = (chord: ChordSymbol): number => mod12(chord.bass ?? chord.root);
