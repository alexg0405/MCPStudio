/**
 * The `write_notation` action: writes a channel's notes in a pattern from the compact text of sheet music ("| C4q E4q G4h |"),
 * the same text the `get_notation` read returns. Bars of the text are bars of the song's time signature, starting at
 * `from_bar`; ties join notes, chords and two voices are allowed, and drum names write to a drum kit channel.
 */
import { rolesOf } from '../../arrange/env';
import { newId } from '@core/model/ids';
import type { Note, Pattern, TimeSignature } from '@core/model/types';
import { parseNotation } from '@core/notation/text';
import { addNotes } from '@core/ops/notes';
import { ceilToBars } from '@core/time/ppq';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { num, str } from './values';

/** The most notes one write_notation adds (the same cap as write_notes). */
const MAX_NOTES = 1024;
/** Velocity of written notes: mezzo-forte, the piano roll's default. */
const WRITTEN_VELOCITY = 0.8;

/** Pattern length on a draft: an explicit length grows to hold the written bars. */
function growLength(pattern: Pattern, endTick: number, timeSig: TimeSignature): void {
  if (pattern.length !== undefined && endTick > pattern.length) pattern.length = ceilToBars(endTick, timeSig);
}

export const notation: OpModule = {
  schemas: [
    S.op(
      'write_notation',
      'Writes a channel’s notes in a pattern from sheet-music text. text: bars between "|", notes as name + value (C4q E4e F#4h., middle C is C4; w whole, h half, q quarter, e eighth, s sixteenth, t thirty-second, "." dotted, "3" triplet, "~" tie to the next note of the same pitch), chords "[C4 E4 G4]h", rests "rq", a whole-bar rest "R", two voices in a bar separated by "&", drums "kick:q" or "[kick hat]:e" (kick snare hat open-hat clap rim pedal-hat tom-low tom-mid tom-high crash ride perc; needs a drum kit channel). Bars use the song’s time signature. get_notation reads the same text.',
      {
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        text: S.str('The notation, e.g. "| C4q E4q G4h | [C4 E4 G4]w |". A header like "4/4 key=Am tempo=120" before the first bar is ignored.'),
        from_bar: S.num('The 1-based bar the first bar of the text goes to (default 1).'),
        replace: S.bool("true (default) replaces that channel's notes in the pattern; false adds to them."),
      },
      ['pattern', 'channel', 'text'],
    ),
  ],
  prompt: {
    id: 'notation',
    order: 86,
    text: 'Sheet music: get_notation reads a part as short text ("| C4q E4q G4h |", middle C = C4); write_notation writes a channel’s notes from the same text (bars, ties, chords, rests, triplets, drums).',
  },
  handlers: {
    write_notation: (action, context) => {
      const { draft } = context;
      const patternId = context.focus.writable(context.pattern(action.pattern));
      const channelId = context.channel(action.channel);
      const channel = draft.channels[channelId]!;
      if (channel.kind !== 'instrument') fail(`“${channel.name}” doesn't play notes`);
      const text = str(action.text) ?? fail('write_notation needs text (for example "| C4q E4q G4h |")');
      const parsed = parseNotation(text, draft.transport.timeSig);
      if (parsed.errors.length > 0 && parsed.notes.length === 0) fail(parsed.errors[0] as string);
      if (parsed.notes.length === 0) fail('that notation has no notes');
      if (parsed.notes.some((note) => note.isDrum) && rolesOf(context.base).get(channelId) !== 'kit') {
        fail(`“${channel.name}” is not a drum kit: write drum names to a Drum Pads or Drum Synth channel`);
      }
      for (const error of parsed.errors) context.warn(error);
      for (const warning of parsed.warnings) context.warn(warning);
      const offset = (Math.max(1, Math.round(num(action.from_bar) ?? 1)) - 1) * context.bar();
      const notes: Note[] = parsed.notes.slice(0, MAX_NOTES).map((note) => ({
        id: newId.note(),
        tick: note.tick + offset,
        length: Math.max(10, note.length),
        key: Math.max(0, Math.min(127, note.key)),
        velocity: WRITTEN_VELOCITY,
      }));
      const pattern = draft.patterns[patternId]!;
      if (action.replace !== false) {
        // Selected notes (a notes focus): only those are replaced.
        const only = context.focus.notes(patternId, channelId);
        if (only) for (const id of only) delete pattern.notes[channelId]?.[id];
        else delete pattern.notes[channelId];
      }
      addNotes(draft, patternId, channelId, notes);
      growLength(pattern, Math.max(...notes.map((note) => note.tick + note.length)), draft.transport.timeSig);
      return `Wrote ${notes.length} note${notes.length === 1 ? '' : 's'} for “${channel.name}” in “${pattern.name}” from the notation (${parsed.bars} bar${parsed.bars === 1 ? '' : 's'}${parsed.notes.length > MAX_NOTES ? `; only the first ${MAX_NOTES} notes were written` : ''})`;
    },
  },
};
