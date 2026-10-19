/**
 * "Arrange like the reference": the reference's sections (lengths and energy) as sections for the arranger.
 * Only the shape of the song comes across: how long each part lasts and how loud it is. Which of the
 * musician's own patterns play in each part is decided from what the project already has (`material.ts`).
 * Pure.
 */
import type { SectionRole } from '../arrange/sections';
import type { ReferenceSection, ReferenceTrack } from '../model/types';

/** What the arranger takes: up to this many sections and bars, each section 1–64 bars. */
export const MAX_SECTIONS = 24;
export const MAX_BARS = 512;
export const MAX_SECTION_BARS = 64;

export interface PlannedSection {
  name: string;
  role: SectionRole;
  bars: number;
  /** 1 (sparse) … 5 (everything), from the reference's relative energy. */
  energy: number;
  /** The reference's own energy, 0–1. */
  refEnergy: number;
  /** Where it is in the reference (seconds), for the chat and the panel. */
  fromSec: number;
  toSec: number;
}

export interface SectionPlan {
  sections: PlannedSection[];
  /** Plain words about anything that was merged, split or cut. */
  notes: string[];
}

/** Energy 0–1 → the arranger's 1–5. */
export const energyLevel = (e: number): number =>
  Math.max(1, Math.min(5, 1 + Math.round(4 * Math.max(0, Math.min(1, e)))));

/** A section kind of the analysis → the arranger's part of a song, keeping the role's usual energy range. */
export function roleOf(s: Pick<ReferenceSection, 'kind' | 'energy'>): { role: SectionRole; energy: number } {
  const e = energyLevel(s.energy);
  switch (s.kind) {
    case 'intro':
      return { role: 'intro', energy: Math.min(e, 2) };
    case 'outro':
      return { role: 'outro', energy: Math.min(e, 2) };
    case 'build':
      return { role: 'build', energy: Math.max(e, 2) };
    case 'drop':
      return { role: 'drop', energy: Math.max(e, 4) };
    case 'break':
      return { role: 'break', energy: Math.min(e, 3) };
    case 'verse':
      return { role: 'verse', energy: Math.max(2, Math.min(e, 4)) };
    case 'body':
      return e >= 4 ? { role: 'chorus', energy: e } : { role: 'verse', energy: Math.max(2, e) };
  }
}

const ROLE_NAME: Record<SectionRole, string> = {
  intro: 'Intro',
  verse: 'Verse',
  pre: 'Pre',
  build: 'Build',
  drop: 'Drop',
  hook: 'Hook',
  chorus: 'Chorus',
  break: 'Break',
  bridge: 'Bridge',
  outro: 'Outro',
};

/**
 * A length in seconds as whole bars at the project's tempo: the nearest bar, and for sections of 6+ bars
 * the nearest multiple of 4 when that is within a bar (phrases are 4, 8 or 16 bars).
 */
export function barsFor(seconds: number, barSeconds: number): number {
  const exact = seconds / barSeconds;
  const near = Math.max(1, Math.round(exact));
  if (near < 6) return near;
  const phrase = Math.round(exact / 4) * 4;
  return Math.abs(phrase - exact) <= 1 ? phrase : near;
}

/** A part of the reference being shaped into a section. */
interface Part {
  role: SectionRole;
  energy: number;
  refEnergy: number;
  bars: number;
  fromSec: number;
  toSec: number;
}

/** Parts under this many bars join a neighbour. */
const MIN_PART_BARS = 2;

/** "1 section was", "3 sections were". */
const sectionsWere = (n: number) => `${n} section${n === 1 ? ' was' : 's were'}`;

/** Two neighbouring parts as one: the longer part keeps its role; energy by length. */
function mergeParts(a: Part, b: Part): Part {
  return {
    role: a.bars >= b.bars ? a.role : b.role,
    energy: Math.round((a.energy * a.bars + b.energy * b.bars) / (a.bars + b.bars)),
    refEnergy: (a.refEnergy * a.bars + b.refEnergy * b.bars) / (a.bars + b.bars),
    bars: a.bars + b.bars,
    fromSec: a.fromSec,
    toSec: b.toSec,
  };
}

/** Parts under 2 bars join their neighbour (the one before; the first joins the one after). Returns how many joined. */
function joinShortParts(parts: Part[]): number {
  let joined = 0;
  for (let i = 0; i < parts.length && parts.length > 1;) {
    if (parts[i]!.bars >= MIN_PART_BARS) {
      i++;
      continue;
    }
    const at = i > 0 ? i - 1 : i;
    parts.splice(at, 2, mergeParts(parts[at]!, parts[at + 1]!));
    joined++;
    i = Math.max(0, at);
  }
  return joined;
}

/** The neighbour a part joins: the only one at either end, else the shorter of the two (the one before on a tie). */
function shorterNeighbour(parts: readonly Part[], k: number): number {
  if (k === 0) return 1;
  if (k === parts.length - 1) return k - 1;
  return parts[k - 1]!.bars <= parts[k + 1]!.bars ? k - 1 : k + 1;
}

/** More than 24 sections: the shortest joins its shorter neighbour, until 24 are left. Returns how many joins. */
function reduceToMaxSections(parts: Part[]): number {
  let reduced = 0;
  while (parts.length > MAX_SECTIONS) {
    let shortest = 0;
    for (let i = 1; i < parts.length; i++) if (parts[i]!.bars < parts[shortest]!.bars) shortest = i;
    const neighbour = shorterNeighbour(parts, shortest);
    const [first, second] = shortest < neighbour ? [shortest, neighbour] : [neighbour, shortest];
    parts.splice(first, 2, mergeParts(parts[first]!, parts[second]!));
    reduced++;
  }
  return reduced;
}

/** A part over 64 bars is split in equal parts. Returns the new parts and how many parts were split. */
function splitLongParts(parts: readonly Part[]): { parts: Part[]; splits: number } {
  const split: Part[] = [];
  let splits = 0;
  for (const p of parts) {
    if (p.bars <= MAX_SECTION_BARS) {
      split.push(p);
      continue;
    }
    const count = Math.ceil(p.bars / MAX_SECTION_BARS);
    const each = Math.floor(p.bars / count);
    splits++;
    for (let i = 0; i < count; i++) {
      const bars = i === count - 1 ? p.bars - each * (count - 1) : each;
      const span = (p.toSec - p.fromSec) / count;
      split.push({ ...p, bars, fromSec: p.fromSec + i * span, toSec: p.fromSec + (i + 1) * span });
    }
  }
  return { parts: split, splits };
}

/** Over 512 bars: the end is cut (a last part is kept only if at least 2 bars of it fit). Returns the kept parts and the bars used. */
function cutToMaxBars(parts: readonly Part[]): { parts: Part[]; used: number } {
  const kept: Part[] = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.bars > MAX_BARS) {
      const left = MAX_BARS - used;
      if (left >= MIN_PART_BARS) kept.push({ ...p, bars: left });
      used = MAX_BARS;
      break;
    }
    kept.push(p);
    used += p.bars;
  }
  return { parts: kept, used };
}

/** Names by part ("Drop", "Drop 2"…), numbered from the second one of each role. */
function nameParts(parts: readonly Part[]): PlannedSection[] {
  const seen = new Map<SectionRole, number>();
  return parts.map((p): PlannedSection => {
    const n = (seen.get(p.role) ?? 0) + 1;
    seen.set(p.role, n);
    return {
      name: n === 1 ? ROLE_NAME[p.role] : `${ROLE_NAME[p.role]} ${n}`,
      role: p.role,
      bars: p.bars,
      energy: p.energy,
      refEnergy: p.refEnergy,
      fromSec: p.fromSec,
      toSec: p.toSec,
    };
  });
}

/**
 * The reference's sections at the project's tempo. `barSeconds` is the length of one bar of the project (so
 * with the tempos matched, a 16-bar intro stays 16 bars; at another tempo the same time becomes the bars that
 * fit). Parts under 2 bars join the one before, a part over 64 bars is split in equal parts, and more than 24
 * sections or 512 bars are reduced (the notes say how).
 */
export function planReferenceSections(ref: Pick<ReferenceTrack, 'sections'>, barSeconds: number): SectionPlan {
  const notes: string[] = [];
  if (!(barSeconds > 0) || !ref.sections.length)
    return { sections: [], notes: ['The reference has no sections to follow.'] };
  let parts: Part[] = ref.sections.map((s) => {
    const r = roleOf(s);
    return {
      ...r,
      refEnergy: s.energy,
      bars: barsFor(s.endSec - s.startSec, barSeconds),
      fromSec: s.startSec,
      toSec: s.endSec,
    };
  });
  const joined = joinShortParts(parts);
  if (joined) {
    notes.push(
      `${sectionsWere(joined)} too short at this tempo and joined the one next to ${joined === 1 ? 'it' : 'them'}.`,
    );
  }
  const reduced = reduceToMaxSections(parts);
  if (reduced) {
    notes.push(
      `The reference has more than ${MAX_SECTIONS} sections: ${reduced} short ones were joined to their neighbours.`,
    );
  }
  const split = splitLongParts(parts);
  if (split.splits) {
    const were = split.splits === 1 ? 'was' : 'were';
    const is = split.splits === 1 ? ' is' : 's are';
    notes.push(`${split.splits} section${is} longer than ${MAX_SECTION_BARS} bars and ${were} split in equal parts.`);
  }
  parts = split.parts;
  const total = parts.reduce((n, p) => n + p.bars, 0);
  if (total > MAX_BARS) {
    const cut = cutToMaxBars(parts);
    notes.push(
      `The arranger holds ${MAX_BARS} bars: the last ${total - cut.used} bars of the reference were left off.`,
    );
    parts = cut.parts;
  }
  return { sections: nameParts(parts), notes };
}

/** "Intro 16 · Drop 32 · Break 16 · Drop 2 32". */
export const planStrip = (sections: readonly Pick<PlannedSection, 'name' | 'bars'>[]): string =>
  sections.map((s) => `${s.name} ${s.bars}`).join(' · ');
