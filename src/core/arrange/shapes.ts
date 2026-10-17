/**
 * Arrangement shapes of the EDM pack: how each style usually lays a song out (sections, lengths, energy
 * and what is left out), and the energy a section's role gets in that style when nobody says. General
 * genre conventions (intro lengths for DJs, 8–32 bar builds, a quiet breakdown before the second drop);
 * the AI reads them from the prompt and tests apply them to check they flow.
 */
import type { Style } from '../beat/style';
import { DEFAULT_ENERGY, type SectionRole } from './sections';

/** A section of a style's usual song; `without` are parts left out (see the arrange action). */
export interface ShapeSection {
  name: string;
  role: SectionRole;
  bars: number;
  energy: number;
  without?: readonly string[];
}

const s = (name: string, role: SectionRole, bars: number, energy: number, without?: readonly string[]): ShapeSection => ({
  name,
  role,
  bars,
  energy,
  ...(without ? { without } : {}),
});

/** The usual song of each EDM-pack style, in order. */
export const SONG_SHAPES: Partial<Record<Style, readonly ShapeSection[]>> = {
  // Festival: a long DJ-friendly intro, an 8-bar snare-roll build, a 16-bar drop, an emotional breakdown, the drop again.
  bigroom: [
    s('Intro', 'intro', 16, 1, ['bass', 'music']),
    s('Build', 'build', 8, 4, ['bass']),
    s('Drop', 'drop', 16, 5),
    s('Breakdown', 'break', 16, 2, ['drums', 'bass']),
    s('Build 2', 'build', 8, 4, ['bass']),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 16, 1, ['music']),
  ],
  // Progressive: it grooves from the first bar, builds for 16 bars with filter sweeps, and breaks down to chords.
  proghouse: [
    s('Intro', 'intro', 16, 2, ['music']),
    s('Groove', 'verse', 16, 3, ['lead']),
    s('Build', 'build', 16, 4, ['lead']),
    s('Drop', 'drop', 16, 4),
    s('Breakdown', 'break', 16, 2, ['drums', 'bass']),
    s('Build 2', 'build', 16, 4),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 16, 2, ['music']),
  ],
  futurebass: [
    s('Intro', 'intro', 8, 1, ['drums', 'bass']),
    s('Verse', 'verse', 8, 2, ['lead']),
    s('Build', 'build', 8, 3, ['bass']),
    s('Drop', 'drop', 16, 5),
    s('Breakdown', 'break', 8, 2, ['drums']),
    s('Build 2', 'build', 8, 3, ['bass']),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 8, 1, ['drums', 'bass']),
  ],
  // Sparse drops: a short build, then silence, then the bass.
  dubstep: [
    s('Intro', 'intro', 8, 1, ['bass']),
    s('Build', 'build', 4, 3, ['bass']),
    s('Drop', 'drop', 16, 5),
    s('Breakdown', 'break', 8, 1, ['drums', 'bass']),
    s('Build 2', 'build', 4, 3, ['bass']),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 8, 1, ['bass']),
  ],
  melodicdub: [
    s('Intro', 'intro', 8, 2, ['drums', 'bass']),
    s('Verse', 'verse', 8, 3, ['lead']),
    s('Build', 'build', 8, 4, ['bass']),
    s('Drop', 'drop', 16, 5),
    s('Breakdown', 'break', 8, 1, ['drums']),
    s('Build 2', 'build', 8, 4, ['bass']),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 8, 1, ['drums', 'bass']),
  ],
  // Tech house: DJ-friendly intro and outro, a short break, one main groove.
  techhouse: [
    s('Intro', 'intro', 16, 2, ['music', 'bass']),
    s('Groove', 'verse', 16, 3),
    s('Break', 'break', 8, 2, ['kick']),
    s('Build', 'build', 8, 3),
    s('Drop', 'drop', 16, 4),
    s('Outro', 'outro', 16, 2, ['music']),
  ],
  trance: [
    s('Intro', 'intro', 16, 2, ['bass', 'music']),
    s('Build', 'build', 8, 4, ['bass']),
    s('Drop', 'drop', 16, 5),
    s('Breakdown', 'break', 16, 1, ['drums', 'bass']),
    s('Build 2', 'build', 16, 4, ['bass']),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 16, 2, ['music']),
  ],
  dnb: [
    s('Intro', 'intro', 16, 2, ['bass']),
    s('Build', 'build', 8, 3, ['bass']),
    s('Drop', 'drop', 16, 5),
    s('Break', 'break', 8, 2, ['kick', 'snare']),
    s('Build 2', 'build', 8, 3, ['bass']),
    s('Drop 2', 'drop', 16, 5),
    s('Outro', 'outro', 16, 2, ['bass']),
  ],
};

/** Where a style's energy for a role differs from `DEFAULT_ENERGY` (a long groove-first intro, a dead-quiet breakdown…). */
const STYLE_ENERGY: Partial<Record<Style, Partial<Record<SectionRole, number>>>> = {
  bigroom: { build: 4, break: 2, intro: 1 },
  proghouse: { intro: 2, build: 4, drop: 4, outro: 2 },
  futurebass: { verse: 2, break: 2 },
  dubstep: { verse: 2, break: 1 },
  melodicdub: { intro: 2, build: 4, break: 1 },
  techhouse: { intro: 2, drop: 4, outro: 2 },
  trance: { intro: 2, build: 4, break: 1, outro: 2 },
  dnb: { intro: 2, outro: 2 },
};

/** The energy a section of this part of the song gets in `style` when none is given. */
export function defaultEnergy(style: Style | null | undefined, role: SectionRole): number {
  return (style ? STYLE_ENERGY[style]?.[role] : undefined) ?? DEFAULT_ENERGY[role];
}

/** A style's usual song as a line for the prompt: "Intro 16 (1), Build 8 (4), …". */
export function shapeText(style: Style): string | null {
  const shape = SONG_SHAPES[style];
  if (!shape) return null;
  return shape.map((x) => `${x.name} ${x.bars} bars energy ${x.energy}${x.without ? ` without ${x.without.join('/')}` : ''}`).join('; ');
}
