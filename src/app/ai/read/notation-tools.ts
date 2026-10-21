/** The read tool for sheet music: a part of a pattern as the compact notation text ("| C4q E4q G4h |"). */
import { engrave } from '@core/notation/engrave';
import { headerText, formatNotation } from '@core/notation/text';
import { NOTATION_GRIDS, type NotationGrid } from '@core/notation/types';
import type { PatternId } from '@core/model/types';
import { DRUMS_PART, engraveInputFor, resolvePart } from '../../notation/part';
import { defaultSheet } from '../../stores/editor';
import { num, str } from '../ops/values';
import * as S from '../schema/parts';
import { BAR_RANGE, projectOf, tool } from './tool';

/** Most bars one answer carries; a longer pattern is read in pieces with from_bar and to_bar. */
const MAX_BARS = 64;
/** Bars on a line of the text. */
const BARS_PER_LINE = 4;

export const getNotation = tool(
  'get_notation',
  'A part of a pattern as sheet-music text: bars between "|", notes as name + value (C4q E4e F#4h., middle C is C4; w whole, h half, q quarter, e eighth, s sixteenth, t thirty-second, "." dotted, "3" triplet, "~" tied to the next note of the same pitch), chords "[C4 E4 G4]h", rests "rq", a whole-bar rest "R", two voices in a bar separated by "&", drums "kick:q" (hat, snare, open-hat…). Notes are rounded to a grid (1/16 by default, triplets found on their own), so it reads as a score does. write_notation writes the same text back. channel defaults to the selected channel; "drums" joins every drum channel.',
  {
    pattern: S.PATTERN,
    channel: S.str('A channel (id or name), or "drums" for all the drum channels on one line (default: the selected channel).'),
    ...BAR_RANGE,
    grid: S.str(`The smallest note value: ${NOTATION_GRIDS.join(', ')} (default 1/16).`),
  },
  (services, args, lookup) => {
    const project = projectOf(services);
    const patternId: PatternId = args.pattern !== undefined ? lookup.pattern(args.pattern) : lookup.pattern('current');
    const wanted = args.channel === undefined ? 'auto' : str(args.channel) === DRUMS_PART ? DRUMS_PART : lookup.channel(args.channel);
    const part = resolvePart(project, patternId, wanted, services.session.getState().selectedChannelId);
    if (!part) return { error: 'that pattern has no notes to write as sheet music' };
    const gridText = str(args.grid);
    const grid = (NOTATION_GRIDS as readonly string[]).includes(gridText ?? '') ? (gridText as NotationGrid) : '1/16';
    const settings = { ...defaultSheet(), grid, lyrics: false, chords: false, dynamics: false };
    const score = engrave(engraveInputFor(project, patternId, part, settings));
    const total = score.measures.length;
    const fromBar = Math.max(1, Math.round(num(args.from_bar) ?? 1));
    const toBar = Math.max(fromBar, Math.min(total, Math.round(num(args.to_bar) ?? total), fromBar + MAX_BARS - 1));
    return {
      pattern: { id: patternId, name: project.patterns[patternId]?.name ?? '' },
      part: part.label,
      header: headerText(score),
      clefs: score.clefs,
      bars: total,
      from_bar: fromBar,
      to_bar: toBar,
      text: formatNotation(score, { header: false, barsPerLine: BARS_PER_LINE, fromBar, toBar }),
      ...(toBar < total ? { more: `bars ${toBar + 1}-${total} are not shown: ask with from_bar` } : {}),
      ...(score.simplified > 0 ? { simplified: `${score.simplified} overlapping notes were simplified (a staff holds two voices)` } : {}),
    };
  },
);
