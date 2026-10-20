/**
 * What each style sounds like to the song generator: the moods and genres its chord progressions come from, how its bass
 * moves, which sounds play its chords and lead, the register and rhythm of its melody. General genre conventions only (a
 * trap 808 follows the kick, trance has an offbeat bass, house a rolling one); no real song is reproduced.
 */
import type { BeatSound } from '../beat/spec';
import type { Style } from '../beat/style';
import type { Genre, Mood } from '../harmony/progressions';

/** How the bass line moves. */
export type BassRule =
  /** An 808 on the chord's root at each kick hit, held to the next one, sliding at the end of a phrase. */
  | 'eight08'
  /** A bass on each kick hit: the root, now and then the fifth or octave. */
  | 'sub-kick'
  /** A walking line: quarter notes through the chord's tones. */
  | 'walking'
  /** Rolling 16ths in the gaps between the kicks, an octave jump on the last 16th of each beat. */
  | 'rolling'
  /** The offbeat 8th between each pair of kicks (trance, big room, EDM). */
  | 'offbeat'
  /** A syncopated, groovy figure (tech house). */
  | 'groove'
  /** Eighth notes alternating root and fifth (pop). */
  | 'pop'
  /** Long root notes, one or two a bar (future bass, melodic dubstep). */
  | 'long-sub'
  /** A sub on the roots with a growl answering the kick and snare (dubstep). */
  | 'growl'
  /** A reese following the two-step kick (drum & bass). */
  | 'reese';

/** The rhythm family the melody's cells come from. */
export type RhythmFamily = 'plain' | 'bounce' | 'laid' | 'driving';

/** How a chord part is struck inside a bar. */
export type CompShape = 'held' | 'half' | 'push' | 'lazy' | 'two' | 'stabs' | 'offbeat' | 'tech' | 'dembow';

/** What fills the high-energy sections on top of the lead: an arpeggio of the chord, a counter-melody, or nothing. */
export type Colour = 'arp' | 'counter' | 'none';

/** One chord part of a style (a pad, keys): its sound, name and how it is played in each kind of section. */
export interface ChordPart {
  name: string;
  sound: BeatSound;
  /** The middle of the voiced chord (MIDI key). */
  center: number;
  /** How it is played in the verse (groove), the chorus (peak) and the intro, break and build (lite) bands. */
  groove: CompShape;
  peak: CompShape;
  lite: CompShape;
}

/** Everything the generator knows about a style. */
export interface StyleProfile {
  genres: readonly Genre[];
  /** The moods a song in this style leans to when the request names none. */
  moods: readonly Mood[];
  /** The chance (0 to 1) that a song is in a minor key when nothing in the request says. */
  minorShare: number;
  /** The chance (0 to 1) that the chords are the key's seventh chords. */
  seventhsShare: number;
  bass: BassRule;
  bassName: string;
  bassSound: BeatSound;
  chordParts: readonly ChordPart[];
  lead: { sound: BeatSound; low: number; high: number; family: RhythmFamily };
  colour: Colour;
  /** The arpeggio's sound and how many 1/16 steps lie between its notes. */
  arp: { sound: BeatSound; every: 1 | 2 };
}

const pad = (center: number, groove: CompShape, peak: CompShape, lite: CompShape = 'held'): ChordPart => ({
  name: 'Pad',
  sound: 'pad',
  center,
  groove,
  peak,
  lite,
});
const keys = (center: number, groove: CompShape, peak: CompShape, lite: CompShape = 'held'): ChordPart => ({
  name: 'Keys',
  sound: 'keys',
  center,
  groove,
  peak,
  lite,
});

/** The profile of each style. */
export const PROFILES: Record<Style, StyleProfile> = {
  trap: {
    genres: ['trap', 'hiphop'],
    moods: ['dark', 'sad', 'dramatic'],
    minorShare: 0.95,
    seventhsShare: 0.1,
    bass: 'eight08',
    bassName: '808',
    bassSound: '808',
    chordParts: [pad(57, 'held', 'held')],
    lead: { sound: 'lead', low: 67, high: 84, family: 'bounce' },
    colour: 'arp',
    arp: { sound: 'bell', every: 2 },
  },
  drill: {
    genres: ['trap', 'cinematic'],
    moods: ['dark', 'tense', 'dramatic'],
    minorShare: 1,
    seventhsShare: 0,
    bass: 'eight08',
    bassName: '808',
    bassSound: '808',
    chordParts: [pad(57, 'held', 'held')],
    lead: { sound: 'lead', low: 65, high: 81, family: 'bounce' },
    colour: 'counter',
    arp: { sound: 'bell', every: 2 },
  },
  boombap: {
    genres: ['hiphop', 'rnb', 'lofi'],
    moods: ['nostalgic', 'smooth', 'sad', 'chill'],
    minorShare: 0.75,
    seventhsShare: 0.6,
    bass: 'sub-kick',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [keys(60, 'lazy', 'two')],
    lead: { sound: 'lead', low: 62, high: 79, family: 'laid' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
  lofi: {
    genres: ['lofi', 'rnb', 'jazz'],
    moods: ['chill', 'nostalgic', 'dreamy', 'smooth'],
    minorShare: 0.6,
    seventhsShare: 0.9,
    bass: 'walking',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [keys(60, 'lazy', 'lazy'), pad(55, 'held', 'held')],
    lead: { sound: 'lead', low: 62, high: 77, family: 'laid' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
  house: {
    genres: ['house', 'edm', 'pop'],
    moods: ['uplifting', 'happy', 'smooth', 'driving'],
    minorShare: 0.4,
    seventhsShare: 0.35,
    bass: 'rolling',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held'), keys(64, 'push', 'stabs')],
    lead: { sound: 'lead', low: 67, high: 84, family: 'driving' },
    colour: 'arp',
    arp: { sound: 'pluck', every: 2 },
  },
  edm: {
    genres: ['edm', 'pop'],
    moods: ['uplifting', 'epic', 'happy', 'emotional'],
    minorShare: 0.5,
    seventhsShare: 0.1,
    bass: 'offbeat',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held'), keys(64, 'push', 'stabs')],
    lead: { sound: 'lead', low: 69, high: 84, family: 'plain' },
    colour: 'arp',
    arp: { sound: 'pluck', every: 2 },
  },
  reggaeton: {
    genres: ['pop', 'trap'],
    moods: ['happy', 'driving', 'smooth'],
    minorShare: 0.7,
    seventhsShare: 0.1,
    bass: 'eight08',
    bassName: '808',
    bassSound: '808',
    chordParts: [keys(62, 'dembow', 'dembow', 'held')],
    lead: { sound: 'lead', low: 64, high: 79, family: 'laid' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
  afro: {
    genres: ['pop', 'rnb'],
    moods: ['happy', 'smooth', 'uplifting'],
    minorShare: 0.45,
    seventhsShare: 0.35,
    bass: 'sub-kick',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [keys(62, 'offbeat', 'offbeat', 'held'), pad(55, 'held', 'held')],
    lead: { sound: 'lead', low: 64, high: 79, family: 'laid' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
  pop: {
    genres: ['pop', 'rock'],
    moods: ['uplifting', 'happy', 'emotional', 'nostalgic'],
    minorShare: 0.35,
    seventhsShare: 0.1,
    bass: 'pop',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [keys(62, 'two', 'two'), pad(55, 'held', 'held')],
    lead: { sound: 'lead', low: 64, high: 81, family: 'plain' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
  bigroom: {
    genres: ['edm'],
    moods: ['uplifting', 'epic', 'happy'],
    minorShare: 0.5,
    seventhsShare: 0,
    bass: 'offbeat',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held')],
    lead: { sound: 'lead', low: 67, high: 84, family: 'plain' },
    colour: 'arp',
    arp: { sound: 'pluck', every: 2 },
  },
  proghouse: {
    genres: ['edm', 'house'],
    moods: ['emotional', 'uplifting', 'dreamy', 'driving'],
    minorShare: 0.7,
    seventhsShare: 0.5,
    bass: 'rolling',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held'), keys(62, 'push', 'push')],
    lead: { sound: 'lead', low: 67, high: 84, family: 'driving' },
    colour: 'arp',
    arp: { sound: 'pluck', every: 2 },
  },
  futurebass: {
    genres: ['edm', 'pop', 'rnb'],
    moods: ['uplifting', 'emotional', 'dreamy', 'happy'],
    minorShare: 0.5,
    seventhsShare: 0.6,
    bass: 'long-sub',
    bassName: 'Sub',
    bassSound: 'bass',
    chordParts: [pad(57, 'half', 'half'), keys(64, 'held', 'two')],
    lead: { sound: 'lead', low: 69, high: 84, family: 'bounce' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
  dubstep: {
    genres: ['edm', 'trap', 'cinematic'],
    moods: ['dark', 'tense', 'dramatic'],
    minorShare: 1,
    seventhsShare: 0,
    bass: 'growl',
    bassName: 'Growl',
    bassSound: 'bass',
    chordParts: [pad(55, 'held', 'held')],
    lead: { sound: 'lead', low: 67, high: 81, family: 'bounce' },
    colour: 'none',
    arp: { sound: 'pluck', every: 2 },
  },
  melodicdub: {
    genres: ['edm', 'cinematic'],
    moods: ['emotional', 'epic', 'sad', 'dramatic'],
    minorShare: 0.85,
    seventhsShare: 0.1,
    bass: 'long-sub',
    bassName: 'Sub',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held'), keys(62, 'held', 'push')],
    lead: { sound: 'lead', low: 69, high: 84, family: 'plain' },
    colour: 'arp',
    arp: { sound: 'keys', every: 2 },
  },
  techhouse: {
    genres: ['house', 'jazz'],
    moods: ['smooth', 'driving', 'chill'],
    minorShare: 0.7,
    seventhsShare: 0.6,
    bass: 'groove',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [pad(55, 'held', 'held'), keys(64, 'tech', 'tech')],
    lead: { sound: 'lead', low: 65, high: 79, family: 'driving' },
    colour: 'none',
    arp: { sound: 'pluck', every: 2 },
  },
  trance: {
    genres: ['edm', 'cinematic'],
    moods: ['uplifting', 'epic', 'emotional'],
    minorShare: 0.8,
    seventhsShare: 0,
    bass: 'offbeat',
    bassName: 'Bass',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held')],
    lead: { sound: 'lead', low: 67, high: 84, family: 'plain' },
    colour: 'arp',
    arp: { sound: 'pluck', every: 1 },
  },
  dnb: {
    genres: ['edm', 'rnb', 'jazz'],
    moods: ['emotional', 'dreamy', 'smooth', 'dark'],
    minorShare: 0.8,
    seventhsShare: 0.7,
    bass: 'reese',
    bassName: 'Reese',
    bassSound: 'bass',
    chordParts: [pad(57, 'held', 'held'), keys(62, 'push', 'push')],
    lead: { sound: 'lead', low: 67, high: 84, family: 'plain' },
    colour: 'counter',
    arp: { sound: 'pluck', every: 2 },
  },
};

/** A chord part's hits inside one bar: [start step, length in steps, velocity 0..1]. */
export type BarHits = readonly (readonly [number, number, number])[];

/** The hits of each way a chord part is struck. */
export const COMP_HITS: Record<CompShape, BarHits> = {
  held: [[0, 16, 0.7]],
  half: [
    [0, 8, 0.72],
    [8, 8, 0.66],
  ],
  push: [
    [0, 6, 0.74],
    [6, 2, 0.6],
    [8, 7, 0.68],
  ],
  lazy: [
    [0, 10, 0.72],
    [10, 6, 0.58],
  ],
  two: [
    [0, 7, 0.76],
    [8, 7, 0.66],
  ],
  stabs: [
    [2, 1.5, 0.72],
    [5, 1, 0.6],
    [10, 1.5, 0.68],
    [13, 1, 0.58],
  ],
  offbeat: [
    [2, 2, 0.72],
    [6, 2, 0.66],
    [10, 2, 0.7],
    [14, 2, 0.62],
  ],
  tech: [
    [3, 1.5, 0.72],
    [10, 1, 0.62],
  ],
  dembow: [
    [0, 3, 0.76],
    [6, 2, 0.62],
    [11, 3, 0.68],
  ],
};
