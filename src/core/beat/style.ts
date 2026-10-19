/**
 * Musical styles and what they mean for groove and phrasing. Shared by the beat writer (accents,
 * swing), the arranger (phrase lengths, fills, transitions) and the mix setup (loudness targets).
 */
import type { ChannelId, Project } from '../model/types';
import { TICKS_PER_STEP } from '../time/ppq';

/** Every musical style the beat writer, arranger and mix setup know. */
export const STYLES = [
  'trap',
  'drill',
  'boombap',
  'lofi',
  'house',
  'edm',
  'reggaeton',
  'afro',
  'pop',
  // The EDM pack: festival and club dance music, bass music and drum & bass.
  'bigroom',
  'proghouse',
  'futurebass',
  'dubstep',
  'melodicdub',
  'techhouse',
  'trance',
  'dnb',
] as const;
/** One of `STYLES`. */
export type Style = (typeof STYLES)[number];

/** The name of each style as the UI and the AI show it. */
export const STYLE_LABELS: Record<Style, string> = {
  trap: 'Trap',
  drill: 'Drill',
  boombap: 'Boom bap',
  lofi: 'Lo-fi',
  house: 'House',
  edm: 'EDM',
  reggaeton: 'Reggaeton',
  afro: 'Afrobeats',
  pop: 'Pop',
  bigroom: 'Big room',
  proghouse: 'Progressive house',
  futurebass: 'Future bass',
  dubstep: 'Dubstep and riddim',
  melodicdub: 'Melodic dubstep',
  techhouse: 'Tech house',
  trance: 'Trance',
  dnb: 'Drum & bass',
};

/** How a style feels: its swing and the velocities (0..1) its notes get when the writer gives none. */
export interface Groove {
  /** Global swing 0..1 that suits the style (the second 1/16 of each 8th plays late by swing × half a step). */
  swing: number;
  /** Hat velocities on the four 1/16s of a beat (on the beat, e, and, a). */
  hat: readonly [number, number, number, number];
  /** Kick velocity on the bar's downbeat, on the other beats, and off the beat. */
  kickOn: number;
  kickBeat: number;
  kickOff: number;
  /** Snare/clap velocity on the backbeat (its main hits), and for ghost notes. */
  backbeat: number;
  ghost: number;
  /** Seeded velocity jitter (±) for notes written without a velocity. */
  jitter: number;
  /** Hat rolls in 1/32s or 1/24s (triplets). */
  roll: 32 | 24;
}

/**
 * The groove of each style. The accents are used when the AI leaves a velocity out (`groove.ts`);
 * swing is what the beat writer and the arranger set for the song.
 */
export const GROOVE: Record<Style, Groove> = {
  trap: { swing: 0, hat: [0.9, 0.5, 0.7, 0.5], kickOn: 1, kickBeat: 0.92, kickOff: 0.82, backbeat: 1, ghost: 0.45, jitter: 0.03, roll: 32 },
  drill: { swing: 0.1, hat: [0.85, 0.45, 0.65, 0.55], kickOn: 1, kickBeat: 0.92, kickOff: 0.82, backbeat: 1, ghost: 0.45, jitter: 0.03, roll: 24 },
  boombap: { swing: 0.35, hat: [0.85, 0.35, 0.65, 0.4], kickOn: 1, kickBeat: 0.92, kickOff: 0.8, backbeat: 1, ghost: 0.4, jitter: 0.05, roll: 32 },
  lofi: { swing: 0.45, hat: [0.7, 0.3, 0.5, 0.35], kickOn: 0.9, kickBeat: 0.85, kickOff: 0.75, backbeat: 0.85, ghost: 0.35, jitter: 0.06, roll: 32 },
  house: { swing: 0.2, hat: [0.4, 0.4, 0.9, 0.4], kickOn: 1, kickBeat: 0.95, kickOff: 0.85, backbeat: 0.95, ghost: 0.4, jitter: 0.03, roll: 32 },
  edm: { swing: 0, hat: [0.5, 0.4, 0.9, 0.4], kickOn: 1, kickBeat: 0.97, kickOff: 0.85, backbeat: 1, ghost: 0.45, jitter: 0.02, roll: 32 },
  reggaeton: { swing: 0.08, hat: [0.85, 0.45, 0.7, 0.5], kickOn: 1, kickBeat: 0.95, kickOff: 0.85, backbeat: 0.95, ghost: 0.45, jitter: 0.03, roll: 32 },
  afro: { swing: 0.25, hat: [0.8, 0.45, 0.7, 0.55], kickOn: 1, kickBeat: 0.92, kickOff: 0.85, backbeat: 0.9, ghost: 0.4, jitter: 0.05, roll: 24 },
  pop: { swing: 0.05, hat: [0.85, 0.45, 0.7, 0.5], kickOn: 1, kickBeat: 0.92, kickOff: 0.82, backbeat: 1, ghost: 0.45, jitter: 0.03, roll: 32 },
  // Big room: dead straight and hard; the offbeat hat is the accent, the kick never varies.
  bigroom: { swing: 0, hat: [0.45, 0.35, 0.9, 0.35], kickOn: 1, kickBeat: 0.98, kickOff: 0.85, backbeat: 1, ghost: 0.4, jitter: 0.015, roll: 32 },
  // Progressive house: nearly straight, a little give in the 16ths.
  proghouse: { swing: 0.08, hat: [0.45, 0.35, 0.85, 0.4], kickOn: 1, kickBeat: 0.95, kickOff: 0.85, backbeat: 0.9, ghost: 0.35, jitter: 0.035, roll: 32 },
  // Future bass: straight with triplet rolls; the snare is the one big hit of the bar.
  futurebass: { swing: 0.05, hat: [0.8, 0.45, 0.65, 0.45], kickOn: 1, kickBeat: 0.92, kickOff: 0.82, backbeat: 1, ghost: 0.4, jitter: 0.03, roll: 24 },
  // Dubstep: straight, sparse; everything is velocity-flat so the snare on 3 and the bass carry it.
  dubstep: { swing: 0, hat: [0.7, 0.4, 0.6, 0.4], kickOn: 1, kickBeat: 0.95, kickOff: 0.85, backbeat: 1, ghost: 0.4, jitter: 0.025, roll: 32 },
  melodicdub: { swing: 0.05, hat: [0.6, 0.35, 0.55, 0.35], kickOn: 1, kickBeat: 0.92, kickOff: 0.8, backbeat: 0.95, ghost: 0.35, jitter: 0.03, roll: 24 },
  // Tech house: the hats are shuffled and the off-beat accent is strong; looser velocities.
  techhouse: { swing: 0.3, hat: [0.4, 0.35, 0.9, 0.5], kickOn: 1, kickBeat: 0.95, kickOff: 0.85, backbeat: 0.9, ghost: 0.4, jitter: 0.05, roll: 32 },
  trance: { swing: 0, hat: [0.45, 0.35, 0.9, 0.35], kickOn: 1, kickBeat: 0.97, kickOff: 0.85, backbeat: 1, ghost: 0.4, jitter: 0.015, roll: 32 },
  // Drum & bass: tight, a hair of swing, ghost snares between the backbeats.
  dnb: { swing: 0.06, hat: [0.8, 0.5, 0.7, 0.5], kickOn: 1, kickBeat: 0.95, kickOff: 0.85, backbeat: 1, ghost: 0.5, jitter: 0.03, roll: 32 },
};

/** Tempo range and default of each style (BPM). */
export const TEMPO: Record<Style, { min: number; max: number; default: number }> = {
  trap: { min: 130, max: 160, default: 140 },
  drill: { min: 138, max: 146, default: 142 },
  boombap: { min: 84, max: 96, default: 90 },
  lofi: { min: 70, max: 90, default: 80 },
  house: { min: 118, max: 128, default: 124 },
  edm: { min: 124, max: 132, default: 128 },
  reggaeton: { min: 88, max: 100, default: 95 },
  afro: { min: 98, max: 112, default: 104 },
  pop: { min: 96, max: 124, default: 110 },
  bigroom: { min: 126, max: 128, default: 128 },
  proghouse: { min: 124, max: 128, default: 126 },
  futurebass: { min: 140, max: 160, default: 150 },
  dubstep: { min: 140, max: 150, default: 140 },
  melodicdub: { min: 140, max: 150, default: 145 },
  techhouse: { min: 124, max: 128, default: 126 },
  trance: { min: 136, max: 140, default: 138 },
  dnb: { min: 172, max: 176, default: 174 },
};

/** How often a style changes things up, in bars. */
export interface Phrasing {
  /** A small change (hat roll, 808 slide, open hat) every this many bars. */
  small: 4 | 8;
  /** A fill that replaces the drums every this many bars. */
  fill: 8 | 16;
}

/** The phrase lengths of each style: a small change and a fill come this many bars apart. */
export const PHRASE: Record<Style, Phrasing> = {
  trap: { small: 4, fill: 8 },
  drill: { small: 4, fill: 8 },
  boombap: { small: 4, fill: 8 },
  lofi: { small: 4, fill: 8 },
  house: { small: 8, fill: 16 },
  edm: { small: 8, fill: 16 },
  reggaeton: { small: 4, fill: 8 },
  afro: { small: 4, fill: 8 },
  pop: { small: 4, fill: 8 },
  // Dance music phrases in 8 and 16 bars (builds of 8–32 bars, a fill every 16); the 140 BPM half-time
  // styles have long bars, so they change every 4 and fill every 8.
  bigroom: { small: 8, fill: 16 },
  proghouse: { small: 8, fill: 16 },
  futurebass: { small: 4, fill: 8 },
  dubstep: { small: 4, fill: 8 },
  melodicdub: { small: 4, fill: 8 },
  techhouse: { small: 8, fill: 16 },
  trance: { small: 8, fill: 16 },
  dnb: { small: 8, fill: 16 },
};

/** Styles with a kick on every beat. */
export const FOUR_FLOOR: ReadonlySet<Style> = new Set<Style>(['house', 'edm', 'bigroom', 'proghouse', 'techhouse', 'trance']);
/** Half-time styles: the snare lands on beat 3, so a bar feels twice as long as the tempo says. */
export const HALF_TIME: ReadonlySet<Style> = new Set<Style>(['trap', 'drill', 'futurebass', 'dubstep', 'melodicdub']);

/** True when `v` is one of the known styles; used to check loose input (the AI, saved settings). */
export const isStyle = (v: unknown): v is Style => typeof v === 'string' && (STYLES as readonly string[]).includes(v);

/** Kicks on all four beats of most bars: house-style "four on the floor". */
function fourOnTheFloor(p: Project): boolean {
  const kicks = Object.entries(p.channels)
    .filter(([, c]) => c.kind === 'instrument' && /kick|bd\b/i.test(c.name))
    .map(([id]) => id as ChannelId);
  if (!kicks.length) return false;
  let bars = 0;
  let four = 0;
  for (const pat of Object.values(p.patterns)) {
    for (const cid of kicks) {
      const notes = Object.values(pat.notes[cid] ?? {});
      if (!notes.length) continue;
      const beats = new Set(notes.filter((n) => n.tick % (4 * TICKS_PER_STEP) === 0).map((n) => n.tick / (4 * TICKS_PER_STEP)));
      const len = Math.max(...notes.map((n) => n.tick)) + 1;
      const n = Math.max(1, Math.ceil(len / (16 * TICKS_PER_STEP)));
      bars += n;
      for (let b = 0; b < n; b++) if ([0, 1, 2, 3].every((q) => beats.has(b * 4 + q))) four++;
    }
  }
  return bars > 0 && four / bars >= 0.6;
}

/** A best guess at a project's style from its tempo, swing and kick pattern (the AI usually says). */
export function inferStyle(p: Project): Style {
  const { bpm, swing } = p.transport;
  return guessStyle(bpm, swing, fourOnTheFloor(p));
}

/** The guess behind `inferStyle`, from the numbers alone (a beat that isn't in a project yet uses it). */
export function guessStyle(bpm: number, swing: number, fourOnTheFloor: boolean): Style {
  if (fourOnTheFloor) return bpm >= 126 ? 'edm' : 'house';
  if (bpm >= 168) return 'dnb';
  if (swing >= 0.3) return bpm < 84 ? 'lofi' : 'boombap';
  if (bpm < 84) return 'lofi';
  if (bpm < 99) return swing > 0.1 ? 'boombap' : 'reggaeton';
  if (bpm < 115) return 'afro';
  if (bpm >= 138 && bpm <= 146) return 'drill';
  return 'trap';
}
