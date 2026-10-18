/**
 * Writing parts from the chord track into the selected channel's pattern: voiced chords, a bassline, and a melody fitted to
 * the chords. Each is one undo step. The planning is `core/harmony/plan`; the AI's actions use the same planners.
 */
import type { BassStyle } from '@core/harmony/bassline';
import { planBassPart, planChordPart, planMelodyFit, type BassPartOptions, type ChordPartOptions } from '@core/harmony/plan';
import type { ChannelId, Note, PatternId } from '@core/model/types';
import { notesSorted } from '@core/query/queries';
import { setNoteKeys, writePart } from '@core/ops/part-notes';
import { rolesOf } from '../arrange/env';
import type { Services } from '../services';
import type { ActionResult } from './chord-track';

/** The instrument channel and pattern a part goes to: the selected channel in the current pattern. */
export function partTarget(s: Services): { channelId: ChannelId; patternId: PatternId } | string {
  const channelId = s.session.getState().selectedChannelId;
  const patternId = s.view.getState().currentPatternId;
  const project = s.doc.getState().project;
  if (!channelId || project.channels[channelId]?.kind !== 'instrument') return 'Select an instrument channel in the channel rack first.';
  if (!patternId || !project.patterns[patternId]) return 'There is no current pattern.';
  return { channelId, patternId };
}

const noChords = 'The chord track has no chords there yet: add some (type them, pick a progression or detect them) first.';

/** Writes voiced chords (with voice leading) for the chord track into the selected channel's pattern. */
export function makeChordPart(s: Services, options: ChordPartOptions = {}): ActionResult {
  const target = partTarget(s);
  if (typeof target === 'string') return { ok: false, message: target };
  const plan = planChordPart(s.doc.getState().project, target.patternId, options);
  if (!plan) return { ok: false, message: noChords };
  s.history.transact('Make chords from the chord track', (draft) => {
    writePart(draft, target.patternId, target.channelId, plan.notes, plan.length);
  });
  return { ok: true, message: `Wrote ${plan.chordCount} chord${plan.chordCount === 1 ? '' : 's'} (${plan.notes.length} notes).` };
}

/** Writes a bassline for the chord track into the selected channel's pattern. */
export function makeBassline(s: Services, options: BassPartOptions): ActionResult {
  const target = partTarget(s);
  if (typeof target === 'string') return { ok: false, message: target };
  const project = s.doc.getState().project;
  const plan = planBassPart(project, target.patternId, rolesOf(project), options);
  if (!plan) return { ok: false, message: noChords };
  const label = bassStyleLabel(options.style);
  s.history.transact(`Make a bassline (${label})`, (draft) => {
    writePart(draft, target.patternId, target.channelId, plan.notes, plan.length);
  });
  return { ok: true, message: `Wrote a ${label} bassline over ${plan.chordCount} chord${plan.chordCount === 1 ? '' : 's'} (${plan.notes.length} notes).` };
}

/** Plain names of the bass styles. */
export function bassStyleLabel(style: BassStyle): string {
  switch (style) {
    case 'roots':
      return 'root notes';
    case 'root-fifth':
      return 'root and fifth';
    case 'walking':
      return 'walking';
    case '808':
      return '808 (follows the kick)';
  }
}

/** The notes to fit: the piano roll's selection in the selected channel, else all of the channel's notes in the pattern. */
function melodyNotes(s: Services, channelId: ChannelId, patternId: PatternId): readonly Note[] {
  const project = s.doc.getState().project;
  const all = notesSorted(project.patterns[patternId]?.notes[channelId]);
  const selected = new Set<string>(s.editor.getState().noteSelection);
  const chosen = all.filter((note) => selected.has(note.id));
  return chosen.length ? chosen : all;
}

/** Moves the melody's notes onto chord tones on strong beats and scale tones elsewhere. `strength` is 0–1. */
export function fitMelodyToChords(s: Services, strength = 1): ActionResult {
  const target = partTarget(s);
  if (typeof target === 'string') return { ok: false, message: target };
  const project = s.doc.getState().project;
  const notes = melodyNotes(s, target.channelId, target.patternId);
  if (notes.length === 0) return { ok: false, message: 'The channel has no notes in this pattern to fit.' };
  const plan = planMelodyFit(project, target.patternId, notes, { strength });
  if (plan.withoutChord === plan.noteCount) return { ok: false, message: noChords };
  if (plan.changes.length === 0) return { ok: true, message: 'Every note already fits the chords and the key.' };
  s.history.transact('Fit melody to chords', (draft) => {
    setNoteKeys(draft, target.patternId, target.channelId, plan.changes);
  });
  return { ok: true, message: `Moved ${plan.changes.length} of ${plan.noteCount} notes (${plan.off} were off) onto chord and scale tones.` };
}
