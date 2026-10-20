/**
 * The shape of a song: its sections in order, with their lengths and energies. The dance styles of the EDM pack use their
 * usual songs (`SONG_SHAPES`); the others use one of three general shapes (a rap song, a pop song, a chill track). A
 * request that names a length (32 bars, "about 2 minutes") shortens a shape by dropping its optional parts or lengthens it
 * by adding more of the section that carries the song.
 */
import { SONG_SHAPES, type ShapeSection } from '../arrange/shapes';
import type { SectionRole } from '../arrange/sections';
import type { Style } from '../beat/style';

const section = (name: string, role: SectionRole, bars: number, energy: number, without?: readonly string[]): ShapeSection => ({
  name,
  role,
  bars,
  energy,
  ...(without ? { without } : {}),
});

/** A rap or hip-hop song: verses over a groove, builds, hooks, a short bridge. */
const RAP_SHAPE: readonly ShapeSection[] = [
  section('Intro', 'intro', 4, 1),
  section('Verse', 'verse', 8, 3),
  section('Build', 'build', 4, 3, ['bass']),
  section('Hook', 'hook', 8, 5),
  section('Verse 2', 'verse', 8, 3),
  section('Build 2', 'build', 4, 3, ['bass']),
  section('Hook 2', 'hook', 8, 5),
  section('Bridge', 'bridge', 4, 2),
  section('Hook 3', 'hook', 8, 5),
  section('Outro', 'outro', 4, 1),
];

/** A pop or house song: verses, pre-choruses, choruses, a bridge, the last chorus again. */
const POP_SHAPE: readonly ShapeSection[] = [
  section('Intro', 'intro', 4, 1),
  section('Verse', 'verse', 8, 3),
  section('Pre-chorus', 'pre', 4, 3, ['bass']),
  section('Chorus', 'chorus', 8, 4),
  section('Verse 2', 'verse', 8, 3),
  section('Pre-chorus 2', 'pre', 4, 3, ['bass']),
  section('Chorus 2', 'chorus', 8, 4),
  section('Bridge', 'bridge', 8, 2),
  section('Chorus 3', 'chorus', 8, 5),
  section('Outro', 'outro', 4, 1),
];

/** A chill track: it never gets loud; two verses, the main part, a quiet turn and the main part again. */
const CHILL_SHAPE: readonly ShapeSection[] = [
  section('Intro', 'intro', 4, 1),
  section('Verse', 'verse', 8, 2),
  section('Main', 'chorus', 8, 3),
  section('Break', 'break', 4, 1),
  section('Verse 2', 'verse', 8, 2),
  section('Main 2', 'chorus', 8, 3),
  section('Outro', 'outro', 4, 1),
];

/** A club house track: a DJ intro with drums and bass only, a long build, a drop, a breakdown and the drop again. */
const HOUSE_SHAPE: readonly ShapeSection[] = [
  section('Intro', 'intro', 8, 2, ['music']),
  section('Groove', 'verse', 8, 3),
  section('Build', 'build', 8, 4, ['bass']),
  section('Drop', 'drop', 16, 5),
  section('Breakdown', 'break', 8, 2),
  section('Build 2', 'build', 8, 4, ['bass']),
  section('Drop 2', 'drop', 16, 5),
  section('Outro', 'outro', 8, 2, ['music']),
];

/** Tech house keeps its bass in the DJ intro and outro (a groove-first intro, drums and bass, not drums alone). */
const TECHHOUSE_SHAPE: readonly ShapeSection[] = (SONG_SHAPES.techhouse ?? []).map((entry) =>
  entry.role === 'intro' || entry.role === 'outro' ? { ...entry, without: ['music'] } : entry,
);

/** The shape each style without its own in `SONG_SHAPES` uses. */
const GENERAL_SHAPES: Partial<Record<Style, readonly ShapeSection[]>> = {
  trap: RAP_SHAPE,
  drill: RAP_SHAPE,
  boombap: RAP_SHAPE,
  reggaeton: RAP_SHAPE,
  afro: POP_SHAPE,
  pop: POP_SHAPE,
  lofi: CHILL_SHAPE,
  house: HOUSE_SHAPE,
  edm: HOUSE_SHAPE,
};

/** The usual song of a style. */
export function shapeOf(style: Style): readonly ShapeSection[] {
  if (style === 'techhouse') return TECHHOUSE_SHAPE;
  return SONG_SHAPES[style] ?? GENERAL_SHAPES[style] ?? POP_SHAPE;
}

const totalBars = (sections: readonly ShapeSection[]): number => sections.reduce((sum, entry) => sum + entry.bars, 0);

/** How early a section goes when a song has to be shorter (lower goes first); null: it stays. */
function dropOrder(entry: ShapeSection, index: number, sections: readonly ShapeSection[]): number | null {
  if (index === 0 || index === sections.length - 1) return null;
  if (/ 3$| 4$/.test(entry.name)) return 1;
  if (entry.role === 'break' || entry.role === 'bridge') return 2;
  if (entry.role === 'build' || entry.role === 'pre') return / 2$/.test(entry.name) ? 3 : null;
  if (entry.role === 'verse' && / 2$/.test(entry.name)) return 4;
  return null;
}

/** A section this long (bars) or longer may be cut in half to shorten a song. */
const HALVABLE_BARS = 16;

/** Which sections give up bars first: the ends and the quiet middle before the builds, and the peaks last (lower goes first). */
const HALVE_ORDER: Partial<Record<SectionRole, number>> = { intro: 0, outro: 0, break: 1, bridge: 1, verse: 2, pre: 3, build: 3 };

/** The sections with the first of the most expendable long ones cut in half; null when none is long enough. */
function halveOne(sections: readonly ShapeSection[]): ShapeSection[] | null {
  const candidates = sections
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.bars >= HALVABLE_BARS)
    .sort((a, b) => (HALVE_ORDER[a.entry.role] ?? 4) - (HALVE_ORDER[b.entry.role] ?? 4) || b.entry.bars - a.entry.bars || a.index - b.index);
  const chosen = candidates[0];
  if (!chosen) return null;
  return sections.map((entry, index) => (index === chosen.index ? { ...entry, bars: entry.bars / 2 } : entry));
}

/** The sections of a shape with one taken out. */
function removeAt(sections: readonly ShapeSection[], index: number): ShapeSection[] {
  return sections.filter((_, at) => at !== index);
}

/** The sections that carry a song, which a longer song repeats: its last peak with the build and the verse before it. */
function growBy(sections: readonly ShapeSection[]): ShapeSection[] {
  const lastPeak = [...sections].reverse().find((entry) => entry.role === 'drop' || entry.role === 'hook' || entry.role === 'chorus');
  if (!lastPeak) return [...sections];
  const insertAt = sections.length - 1;
  const copies = sections.filter((entry) => entry.role === lastPeak.role).length + 1;
  const base = lastPeak.name.replace(/ \d+$/, '');
  const extra = [section(`${base} ${copies}`, lastPeak.role, lastPeak.bars, lastPeak.energy)];
  const lead = sections.find((entry) => entry.role === 'break' || entry.role === 'bridge' || entry.role === 'verse');
  const turn = lead ? [section(`${lead.name.replace(/ \d+$/, '')} ${copies}`, lead.role, lead.bars, lead.energy, lead.without)] : [];
  return [...sections.slice(0, insertAt), ...turn, ...extra, ...sections.slice(insertAt)];
}

/** How far from the asked length a song may end, in bars: sections come in fours and eights. */
const LENGTH_SLACK_BARS = 6;

/** The sections of a song of a style, shortened or lengthened toward `bars` when a length was asked for. */
export function sectionsFor(style: Style, bars: number | undefined): ShapeSection[] {
  let sections = [...shapeOf(style)];
  if (bars === undefined) return sections;
  for (;;) {
    const total = totalBars(sections);
    if (total <= bars + LENGTH_SLACK_BARS) break;
    // Long sections get shorter before any section goes: the song keeps its shape.
    const halved = halveOne(sections);
    if (halved) {
      sections = halved;
      continue;
    }
    const order = sections.map((entry, index) => ({ index, order: dropOrder(entry, index, sections) })).filter((entry) => entry.order !== null);
    const next = order.sort((a, b) => (a.order as number) - (b.order as number))[0];
    if (!next) break;
    sections = removeAt(sections, next.index);
  }
  while (totalBars(sections) < bars - LENGTH_SLACK_BARS) {
    const grown = growBy(sections);
    if (grown.length === sections.length) break;
    sections = grown;
  }
  return sections;
}
