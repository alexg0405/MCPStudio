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
export const energyLevel = (e: number): number => Math.max(1, Math.min(5, 1 + Math.round(4 * Math.max(0, Math.min(1, e)))));

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

interface Part {
  role: SectionRole;
  energy: number;
  refEnergy: number;
  bars: number;
  fromSec: number;
  toSec: number;
}

/**
 * The reference's sections at the project's tempo. `barSeconds` is the length of one bar of the project (so
 * with the tempos matched, a 16-bar intro stays 16 bars; at another tempo the same time becomes the bars that
 * fit). Parts under 2 bars join the one before, a part over 64 bars is split in equal parts, and more than 24
 * sections or 512 bars are reduced (the notes say how).
 */
export function planReferenceSections(ref: Pick<ReferenceTrack, 'sections'>, barSeconds: number): SectionPlan {
  const notes: string[] = [];
  if (!(barSeconds > 0) || !ref.sections.length) return { sections: [], notes: ['The reference has no sections to follow.'] };
  let parts: Part[] = ref.sections.map((s) => {
    const r = roleOf(s);
    return { ...r, refEnergy: s.energy, bars: barsFor(s.endSec - s.startSec, barSeconds), fromSec: s.startSec, toSec: s.endSec };
  });
  // Parts under 2 bars join their neighbour (the one before; the first joins the one after).
  let joined = 0;
  const merge = (a: Part, b: Part): Part => ({
    // The longer part keeps its role; energy by length.
    role: a.bars >= b.bars ? a.role : b.role,
    energy: Math.round((a.energy * a.bars + b.energy * b.bars) / (a.bars + b.bars)),
    refEnergy: (a.refEnergy * a.bars + b.refEnergy * b.bars) / (a.bars + b.bars),
    bars: a.bars + b.bars,
    fromSec: a.fromSec,
    toSec: b.toSec,
  });
  for (let i = 0; i < parts.length && parts.length > 1; ) {
    if (parts[i]!.bars >= 2) {
      i++;
      continue;
    }
    const at = i > 0 ? i - 1 : i;
    parts.splice(at, 2, merge(parts[at]!, parts[at + 1]!));
    joined++;
    i = Math.max(0, at);
  }
  if (joined) notes.push(`${joined} section${joined === 1 ? ' was' : 's were'} too short at this tempo and joined the one next to ${joined === 1 ? 'it' : 'them'}.`);
  // More than 24 sections: the shortest joins its shorter neighbour.
  let reduced = 0;
  while (parts.length > MAX_SECTIONS) {
    let k = 0;
    for (let i = 1; i < parts.length; i++) if (parts[i]!.bars < parts[k]!.bars) k = i;
    const neighbour = k === 0 ? 1 : k === parts.length - 1 ? k - 1 : parts[k - 1]!.bars <= parts[k + 1]!.bars ? k - 1 : k + 1;
    const [x, y] = k < neighbour ? [k, neighbour] : [neighbour, k];
    parts.splice(x, 2, merge(parts[x]!, parts[y]!));
    reduced++;
  }
  if (reduced) notes.push(`The reference has more than ${MAX_SECTIONS} sections: ${reduced} short ones were joined to their neighbours.`);
  // Over 64 bars: equal parts.
  const split: Part[] = [];
  let splits = 0;
  for (const p of parts) {
    if (p.bars <= MAX_SECTION_BARS) {
      split.push(p);
      continue;
    }
    const n = Math.ceil(p.bars / MAX_SECTION_BARS);
    const each = Math.floor(p.bars / n);
    splits++;
    for (let i = 0; i < n; i++) {
      const bars = i === n - 1 ? p.bars - each * (n - 1) : each;
      const span = (p.toSec - p.fromSec) / n;
      split.push({ ...p, bars, fromSec: p.fromSec + i * span, toSec: p.fromSec + (i + 1) * span });
    }
  }
  if (splits) notes.push(`${splits} section${splits === 1 ? ' is' : 's are'} longer than ${MAX_SECTION_BARS} bars and ${splits === 1 ? 'was' : 'were'} split in equal parts.`);
  parts = split;
  // Over 512 bars: cut the end.
  const total = parts.reduce((n, p) => n + p.bars, 0);
  if (total > MAX_BARS) {
    const kept: Part[] = [];
    let used = 0;
    for (const p of parts) {
      if (used + p.bars > MAX_BARS) {
        const left = MAX_BARS - used;
        if (left >= 2) kept.push({ ...p, bars: left });
        used = MAX_BARS;
        break;
      }
      kept.push(p);
      used += p.bars;
    }
    notes.push(`The arranger holds ${MAX_BARS} bars: the last ${total - used} bars of the reference were left off.`);
    parts = kept;
  }
  // Names by part, numbered from the second one.
  const seen = new Map<SectionRole, number>();
  const sections = parts.map((p): PlannedSection => {
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
  return { sections, notes };
}

/** "Intro 16 · Drop 32 · Break 16 · Drop 2 32". */
export const planStrip = (sections: readonly Pick<PlannedSection, 'name' | 'bars'>[]): string => sections.map((s) => `${s.name} ${s.bars}`).join(' · ');
