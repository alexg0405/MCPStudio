/** The levels auto-level aims for: where each role bus sits around the kick, and how loud the master plays, per style. */
import type { Style } from '@core/beat/style';

/** The buses auto-level sets (the returns follow their sends). */
export type LeveledBus = 'kick' | 'drums' | 'bass' | 'chords' | 'lead' | 'vocals' | 'fx';

/** The leveled buses in the order the first one heard stands in for a missing kick. */
export const LEVELED: readonly LeveledBus[] = ['kick', 'drums', 'bass', 'chords', 'lead', 'vocals', 'fx'];

/** What a style's mix aims for. */
export interface LevelTarget {
  /** Each bus's loudness relative to the kick bus, in dB. */
  drums: number;
  bass: number;
  chords: number;
  lead: number;
  /** The Vocals bus (default: 1 dB over the lead: a voice sits in front of the instruments). */
  vocals?: number;
  fx: number;
  /** The master's integrated loudness, LUFS. */
  master: number;
}

/** The target of every style. */
export const LEVEL_TARGETS: Readonly<Record<Style, LevelTarget>> = {
  trap: { drums: -2, bass: 1, chords: -7, lead: -4, fx: -8, master: -10 },
  drill: { drums: -1, bass: 1, chords: -6, lead: -4, fx: -8, master: -10 },
  boombap: { drums: 0, bass: -3, chords: -5, lead: -5, fx: -10, master: -11 },
  lofi: { drums: -2, bass: -4, chords: -2, lead: -5, fx: -10, master: -13 },
  house: { drums: -4, bass: -3, chords: -5, lead: -4, fx: -8, master: -9.5 },
  edm: { drums: -4, bass: -3, chords: -5, lead: -4, fx: -8, master: -9.5 },
  reggaeton: { drums: -2, bass: -2, chords: -6, lead: -4, fx: -9, master: -10 },
  afro: { drums: -2, bass: -2, chords: -6, lead: -4, fx: -9, master: -10 },
  pop: { drums: -3, bass: -3, chords: -5, lead: -2, fx: -10, master: -11 },
  // The EDM pack: club and festival masters are loud (−8.5 to −10 LUFS). The Limiter reaches the quieter ones; the rest get the
  // Maximizer before it (`tuneLoudness`), which reaches −8 within 0.5 dB at a −1 dBTP ceiling.
  // Big room: the lead is the hook, the sidechained chords sit behind it. Dubstep: the bass is as loud as the kick.
  bigroom: { drums: -4, bass: -5, chords: -6, lead: -2, fx: -7, master: -8.5 },
  proghouse: { drums: -4, bass: -3, chords: -4, lead: -5, fx: -9, master: -10 },
  futurebass: { drums: -3, bass: -3, chords: -2, lead: -3, fx: -8, master: -9 },
  dubstep: { drums: -3, bass: 1, chords: -9, lead: -5, fx: -6, master: -8.5 },
  melodicdub: { drums: -3, bass: -2, chords: -3, lead: -3, fx: -8, master: -9.5 },
  techhouse: { drums: -3, bass: -2, chords: -8, lead: -6, fx: -9, master: -10 },
  trance: { drums: -4, bass: -4, chords: -3, lead: -3, fx: -8, master: -9 },
  dnb: { drums: -1, bass: 0, chords: -7, lead: -6, fx: -9, master: -9 },
};

/** How far (dB) a bus sits from the kick in a style: the kick is the reference (0), a missing vocals target follows the lead. */
export function offsetFromKick(role: LeveledBus, target: LevelTarget): number {
  if (role === 'kick') return 0;
  if (role === 'vocals') return target.vocals ?? target.lead + 1;
  return target[role];
}
