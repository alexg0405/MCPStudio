/**
 * Musical styles and what they mean for groove and phrasing. Shared by the beat writer (accents,
 * swing), the arranger (phrase lengths, fills, transitions) and the mix setup (loudness targets).
 */
import type { ChannelId, Project } from '../model/types';
import { TICKS_PER_STEP } from '../time/ppq';

export const STYLES = ['trap', 'drill', 'boombap', 'lofi', 'house', 'edm', 'reggaeton', 'afro', 'pop'] as const;
export type Style = (typeof STYLES)[number];

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
};

export interface Groove {
  /** Global swing 0..1 that suits the style. */
  swing: number;
  /** Hat velocities on the four 1/16s of a beat (on the beat, e, and, a). */
  hat: readonly [number, number, number, number];
  /** Kick velocity on the beat and off it. */
  kickOn: number;
  kickOff: number;
  /** Snare/clap velocity on the backbeat, and for ghost notes. */
  backbeat: number;
  ghost: number;
  /** Seeded velocity jitter (±). */
  jitter: number;
  /** Hat rolls in 1/32s or 1/24s (triplets). */
  roll: 32 | 24;
}

export const GROOVE: Record<Style, Groove> = {
  trap: { swing: 0, hat: [0.9, 0.5, 0.7, 0.5], kickOn: 1, kickOff: 0.85, backbeat: 1, ghost: 0.45, jitter: 0.03, roll: 32 },
  drill: { swing: 0.1, hat: [0.85, 0.45, 0.65, 0.55], kickOn: 1, kickOff: 0.85, backbeat: 1, ghost: 0.45, jitter: 0.03, roll: 24 },
  boombap: { swing: 0.35, hat: [0.85, 0.35, 0.65, 0.4], kickOn: 1, kickOff: 0.8, backbeat: 1, ghost: 0.4, jitter: 0.05, roll: 32 },
  lofi: { swing: 0.45, hat: [0.7, 0.3, 0.5, 0.35], kickOn: 0.9, kickOff: 0.75, backbeat: 0.85, ghost: 0.35, jitter: 0.06, roll: 32 },
  house: { swing: 0.2, hat: [0.4, 0.4, 0.9, 0.4], kickOn: 1, kickOff: 0.9, backbeat: 0.95, ghost: 0.4, jitter: 0.03, roll: 32 },
  edm: { swing: 0, hat: [0.5, 0.4, 0.9, 0.4], kickOn: 1, kickOff: 0.9, backbeat: 1, ghost: 0.45, jitter: 0.02, roll: 32 },
  reggaeton: { swing: 0.08, hat: [0.85, 0.45, 0.7, 0.5], kickOn: 1, kickOff: 0.85, backbeat: 0.95, ghost: 0.45, jitter: 0.03, roll: 32 },
  afro: { swing: 0.25, hat: [0.8, 0.45, 0.7, 0.55], kickOn: 1, kickOff: 0.85, backbeat: 0.9, ghost: 0.4, jitter: 0.05, roll: 24 },
  pop: { swing: 0.05, hat: [0.85, 0.45, 0.7, 0.5], kickOn: 1, kickOff: 0.85, backbeat: 1, ghost: 0.45, jitter: 0.03, roll: 32 },
};

export interface Phrasing {
  /** A small change (hat roll, 808 slide, open hat) every this many bars. */
  small: 4 | 8;
  /** A fill that replaces the drums every this many bars. */
  fill: 8 | 16;
}

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
};

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
  if (fourOnTheFloor(p)) return bpm >= 126 ? 'edm' : 'house';
  if (swing >= 0.3) return bpm < 84 ? 'lofi' : 'boombap';
  if (bpm < 84) return 'lofi';
  if (bpm < 99) return swing > 0.1 ? 'boombap' : 'reggaeton';
  if (bpm < 115) return 'afro';
  if (bpm >= 138 && bpm <= 146) return 'drill';
  return 'trap';
}
