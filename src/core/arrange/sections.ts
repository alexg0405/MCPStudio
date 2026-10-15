/**
 * Song sections as the arranger plans them: a name, a part of the song (intro, verse, build, drop…),
 * a length in bars, an energy 1–5, and what plays. Typical shapes: intro 4–8 bars at 1–2, verse 8–16
 * at 3, build 4–8, drop or hook 8–16 at 4–5, break 4–8 at 2, outro 4–8 at 1–2.
 */
import type { PatternId, Tick } from '../model/types';

export const SECTION_ROLES = ['intro', 'verse', 'pre', 'build', 'drop', 'hook', 'chorus', 'break', 'bridge', 'outro'] as const;
export type SectionRole = (typeof SECTION_ROLES)[number];

export const DEFAULT_ENERGY: Record<SectionRole, number> = {
  intro: 1,
  verse: 3,
  pre: 3,
  build: 3,
  drop: 5,
  hook: 5,
  chorus: 4,
  break: 2,
  bridge: 2,
  outro: 1,
};

/** Usual lengths in bars (the prompt states them; nothing enforces them). */
export const SECTION_BARS: Record<SectionRole, readonly [number, number]> = {
  intro: [4, 8],
  verse: [8, 16],
  pre: [4, 8],
  build: [4, 8],
  drop: [8, 16],
  hook: [8, 16],
  chorus: [8, 16],
  break: [4, 8],
  bridge: [4, 8],
  outro: [4, 8],
};

/** The loudest parts of a song: a build leads into them. */
export const isPeak = (r: SectionRole): boolean => r === 'drop' || r === 'hook' || r === 'chorus';

export const isSectionRole = (v: unknown): v is SectionRole =>
  typeof v === 'string' && (SECTION_ROLES as readonly string[]).includes(v);

/** A section's part from its name ("Verse 2", "Pre-chorus", "Breakdown"), if it says. */
export function roleFromName(name: string): SectionRole | undefined {
  const t = name.toLowerCase();
  if (/\bintro/.test(t)) return 'intro';
  if (/\boutro|\bending|\bend\b/.test(t)) return 'outro';
  if (/\bpre[- ]?(chorus|drop|hook)|\bpre\b/.test(t)) return 'pre';
  if (/\bbuild|\briser?\b|\blift|\bbuildup|\bbuild-up/.test(t)) return 'build';
  if (/\bdrop/.test(t)) return 'drop';
  if (/\bhook/.test(t)) return 'hook';
  if (/\bchorus|\brefrain/.test(t)) return 'chorus';
  if (/\bbridge/.test(t)) return 'bridge';
  if (/\bbreak|\bbreather|\binterlude|\bpause/.test(t)) return 'break';
  if (/\bverse/.test(t)) return 'verse';
  return undefined;
}

/** How much the phrase rules vary a section: auto, more (a change every 2 bars), less (fills only), none. */
export type VaryMode = 'auto' | 'more' | 'less' | 'none';
export const VARY_MODES: readonly VaryMode[] = ['auto', 'more', 'less', 'none'];

/** The fill a section's phrases use (auto rotates by style). */
export type FillChoice = 'auto' | 'snare' | 'tom' | 'hat' | 'kick' | 'none';
export const FILL_CHOICES: readonly FillChoice[] = ['auto', 'snare', 'tom', 'hat', 'kick', 'none'];

/** How a section is entered (auto classifies the energy change; none: no transition at all). */
export type TransitionChoice = 'auto' | 'rise' | 'lift' | 'same' | 'dip' | 'fall' | 'none';
export const TRANSITION_CHOICES: readonly TransitionChoice[] = ['auto', 'rise', 'lift', 'same', 'dip', 'fall', 'none'];

/** A section as described (by the AI, or inferred from a song). */
export interface SectionSpec {
  name: string;
  bars: number;
  role: SectionRole;
  /** 1 (sparse) … 5 (everything). */
  energy: number;
  /** The patterns that play (usually one beat). */
  play: PatternId[];
  /** Parts or channel ids left out. */
  without: string[];
  vary: VaryMode;
  transitionIn: TransitionChoice;
  fill: FillChoice;
}

/** A section placed in the song. */
export interface SectionSpan extends SectionSpec {
  index: number;
  from: Tick;
  /** Exclusive. */
  to: Tick;
}

/** Sections back to back from `from`. */
export function layoutSections(specs: readonly SectionSpec[], from: Tick, barTicks: Tick): SectionSpan[] {
  let at = from;
  return specs.map((s, index) => {
    const span = { ...s, index, from: at, to: at + s.bars * barTicks };
    at = span.to;
    return span;
  });
}
