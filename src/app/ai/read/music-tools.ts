/** Read tools for the music itself: the notes of a pattern and the chord track. */
import { formatChord } from '@core/harmony/chord';
import { harmonyKey } from '@core/harmony/key';
import { findProgressions, GENRES, MOODS } from '@core/harmony/progressions';
import { romanOf } from '@core/harmony/scale';
import type { Note, Pattern, PatternId, Project } from '@core/model/types';
import { symbolOf } from '@core/ops/chords';
import { chordsSorted, chordTrackLines, projectUsesFlats } from '@core/query/chords';
import { patternLength } from '@core/query/queries';
import { TICKS_PER_STEP } from '@core/time/ppq';
import { rolesOf } from '../../arrange/env';
import { nextChordSuggestions } from '../../harmony/chord-track';
import { num, str } from '../ops/values';
import * as S from '../schema/parts';
import {
  BAR_RANGE,
  barCount,
  barNumberAt,
  barRange,
  projectOf,
  round2,
  round3,
  tickOfBar,
  tool,
  type ToolArgs,
} from './tool';

/** Most notes get_pattern_notes returns when no limit is given. */
const DEFAULT_NOTE_LIMIT = 1500;
/** Most notes it ever returns, whatever the limit asked for. */
const MAX_NOTE_LIMIT = 5000;

/**
 * A note as a row: [step, length in steps, MIDI key, velocity], plus an object for what it has beyond that
 * (muted, pan, release, fine), so a plain note stays four numbers.
 */
function noteRow(note: Note): unknown[] {
  const row: unknown[] = [
    round3(note.tick / TICKS_PER_STEP),
    round3(note.length / TICKS_PER_STEP),
    note.key,
    round2(note.velocity),
  ];
  const extras: Record<string, unknown> = {};
  if (note.muted) extras.muted = true;
  if (note.pan !== undefined && note.pan !== 0) extras.pan = round2(note.pan);
  if (note.release !== undefined) extras.release = round2(note.release);
  if (note.fine) extras.fine = note.fine;
  if (Object.keys(extras).length) row.push(extras);
  return row;
}

/** The notes of a pattern per channel, within the bar range, sharing out `limit` notes in channel order. */
function channelsWithNotes(
  project: Project,
  pattern: Pattern,
  args: ToolArgs,
  onlyChannel: string | null,
  limit: number,
) {
  const range = barRange(project, args);
  let notesLeft = limit;
  let isTruncated = false;
  const channels = project.channelOrder
    .filter(
      (id) =>
        (onlyChannel ? id === onlyChannel : true) && pattern.notes[id] && Object.keys(pattern.notes[id]!).length > 0,
    )
    .map((id) => {
      const inRange = Object.values(pattern.notes[id]!)
        .filter((note) => note.tick >= range.from && note.tick < range.to)
        .sort((a, b) => a.tick - b.tick || a.key - b.key);
      const shown = inRange.slice(0, Math.max(0, notesLeft));
      if (shown.length < inRange.length) isTruncated = true;
      notesLeft -= shown.length;
      return { id, name: project.channels[id]!.name, count: inRange.length, notes: shown.map(noteRow) };
    });
  return { channels, isTruncated };
}

export const getPatternNotes = tool(
  'get_pattern_notes',
  'The notes of a pattern, per channel: rows of [step, length in steps, MIDI key, velocity 0..1] (step 0 = the pattern start, 16 steps per 4/4 bar, fractions allowed: the units write_notes takes), plus an object with pan, release, fine or muted for the notes that have them.',
  {
    pattern: S.PATTERN,
    channel: S.CHANNEL,
    ...BAR_RANGE,
    limit: S.int('Most notes to return (default 1500).'),
  },
  (services, args, lookup) => {
    const project = projectOf(services);
    const patternId: PatternId = args.pattern !== undefined ? lookup.pattern(args.pattern) : lookup.pattern('current');
    const pattern = project.patterns[patternId]!;
    const limit = Math.max(1, Math.min(MAX_NOTE_LIMIT, Math.round(num(args.limit) ?? DEFAULT_NOTE_LIMIT)));
    const onlyChannel = args.channel !== undefined ? lookup.channel(args.channel) : null;
    const { channels, isTruncated } = channelsWithNotes(project, pattern, args, onlyChannel, limit);
    return {
      pattern: {
        id: patternId,
        name: pattern.name,
        bars: barCount(project, patternLength({ ...pattern }, project.transport.timeSig)),
        steps: pattern.stepCount,
      },
      columns: ['step', 'len', 'key', 'vel'],
      channels,
      ...(isTruncated ? { truncated: true } : {}),
    };
  },
);

export const getChords = tool(
  'get_chords',
  'The chord track: the song key, every chord with its bar, length, Roman numeral in the key and (when it was detected) confidence, as one line per eight bars. With next_bar, chords that could start at that bar ranked by function; with mood or genre, the matching palette progressions (ids for the chords action).',
  {
    next_bar: S.int('1-based bar: suggest the chords that could start there (from the chord before it).'),
    mood: S.str(`Palette filter: ${MOODS.join(', ')}.`),
    genre: S.str(`Palette filter: ${GENRES.join(', ')}.`),
  },
  (services, args) => {
    const project = projectOf(services);
    const key = harmonyKey(project, rolesOf(project));
    const usesFlats = projectUsesFlats(project);
    const answer: Record<string, unknown> = {
      key: { root: key.root, scale: key.scale, from: key.from },
      chords: chordsSorted(project).map((event) => ({
        bar: barNumberAt(project, event.tick),
        bars: barCount(project, event.length),
        chord: formatChord(symbolOf(event), usesFlats),
        roman: romanOf(key, symbolOf(event)),
        ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
      })),
      lines: chordTrackLines(project),
    };
    const nextBar = num(args.next_bar);
    if (nextBar !== undefined) {
      answer.next = nextChordSuggestions(services, tickOfBar(project, nextBar)).map((next) => ({
        chord: formatChord(next.chord, usesFlats),
        roman: next.roman,
        function: next.function,
        score: next.score,
        why: next.reason,
      }));
    }
    const mood = str(args.mood);
    const genre = str(args.genre);
    if (mood || genre) {
      answer.progressions = findProgressions({ mood, genre }).map((progression) => ({
        id: progression.id,
        name: progression.name,
        mode: progression.mode,
        note: progression.note,
      }));
    }
    return answer;
  },
);
