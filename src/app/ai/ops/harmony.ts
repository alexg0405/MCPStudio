/**
 * Harmony actions: the chord track (type, clear, detect, progressions) and the parts written from it (voiced chords, a
 * bassline, a melody fitted to the chords). They use the planners in `core/harmony`, reading a snapshot of the draft so a
 * chord track set earlier in the same answer is seen by the parts written after it.
 */
import { current } from 'immer';
import type { Draft } from 'immer';
import { BASS_STYLES, type BassStyle } from '@core/harmony/bassline';
import { formatChord, parseChordLine } from '@core/harmony/chord';
import { harmonyKey, keyForMode } from '@core/harmony/key';
import { MOODS, GENRES, PROGRESSIONS, layoutProgression, lookupProgression } from '@core/harmony/progressions';
import { planBassPart, planChordPart, planMelodyFit, type Register } from '@core/harmony/plan';
import { detectProjectChords } from '@core/harmony/scan';
import { COMP_RHYTHMS, type CompRhythm, type Spread } from '@core/harmony/voicing';
import type { Note, Project } from '@core/model/types';
import { clearChords, placeChords } from '@core/ops/chords';
import { setNoteKeys, writePart } from '@core/ops/part-notes';
import { chordTrackEnd, projectUsesFlats } from '@core/query/chords';
import { barSpan } from '@core/time/bars';
import { chordLineSpans } from '../../harmony/chord-track';
import { rolesOf } from '../../arrange/env';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import { bool, num, str } from './values';

const REGISTERS = ['low', 'mid', 'high'] as const;
const SPREADS = ['close', 'open', 'drop2'] as const;

/** The project as plain data (a snapshot of the draft). */
const snapshot = (context: OpContext): Project => current(context.draft) as Project;

/** Ticks of a 1-based bar. */
const barTick = (context: OpContext, bar: number): number => Math.max(0, Math.round(bar - 1)) * context.bar();

function oneOf<T extends string>(raw: unknown, choices: readonly T[], what: string, fallback: T): T {
  const text = str(raw)?.toLowerCase();
  if (text === undefined) return fallback;
  const found = choices.find((choice) => choice === text);
  return found ?? fail(`${what} must be one of ${choices.join(', ')}`);
}

/** The pattern, channel and notes an action works on (instrument channels only). */
function partTarget(action: Record<string, unknown>, context: OpContext) {
  const patternId = context.focus.writable(context.pattern(action.pattern ?? 'current'));
  const channelId = context.channel(action.channel);
  const channel = context.draft.channels[channelId]!;
  if (channel.kind !== 'instrument') fail(`“${channel.name}” doesn't play notes`);
  return { patternId, channelId, channelName: channel.name, patternName: context.draft.patterns[patternId]!.name };
}

const noChordsMessage = 'the chord track has no chords there: set them first with the chords action';

function setChords(action: Record<string, unknown>, context: OpContext): string {
  const text = str(action.text) ?? fail('chords: give the chords as text, e.g. "Am7 | F | C | G"');
  const { chords, bad } = parseChordLine(text);
  if (bad.length) fail(`not chords: ${bad.join(', ')} (use names like Am7, F, C/E, Gsus4)`);
  const per = Math.max(0.5, num(action.bars_per_chord) ?? 1);
  const start = barTick(context, num(action.from_bar) ?? 1);
  const spans = chordLineSpans(chords, context.bar(), start, per);
  if (spans.length === 0) fail('chords: no chords in the text');
  const end = Math.max(...spans.map((span) => span.tick + span.length));
  context.focus.span(start, end, 'chords');
  clearChords(context.draft, start, end);
  placeChords(context.draft, spans);
  context.touch(start, end);
  const flats = projectUsesFlats(snapshot(context));
  return `Chord track: ${spans.slice(0, 8).map((span) => formatChord(span.chord, flats)).join(' | ')}${spans.length > 8 ? ' …' : ''} from bar ${Math.round(start / context.bar()) + 1}`;
}

function clearTrack(action: Record<string, unknown>, context: OpContext): string {
  const from = num(action.from_bar);
  const to = num(action.to_bar);
  const fromTick = from !== undefined ? barTick(context, from) : undefined;
  const toTick = to !== undefined ? Math.round(to) * context.bar() : fromTick !== undefined ? Math.round(from!) * context.bar() : undefined;
  const end = toTick ?? chordTrackEnd(snapshot(context));
  context.focus.span(fromTick ?? 0, end, 'clear chords');
  const removed = clearChords(context.draft, fromTick, toTick);
  if (removed === 0) fail('the chord track has no chords there');
  return `Removed ${removed} chord${removed === 1 ? '' : 's'} from the chord track`;
}

function detect(action: Record<string, unknown>, context: OpContext): string {
  const project = snapshot(context);
  const roles = rolesOf(project);
  const from = num(action.from_bar);
  const to = num(action.to_bar);
  const range = from !== undefined ? { from: barTick(context, from), to: (to !== undefined ? Math.round(to) : Math.round(from)) * context.bar() } : context.focus.range();
  const scope = range && Number.isFinite(range.to) ? ({ kind: 'range', from: range.from, to: range.to } as const) : ({ kind: 'song' } as const);
  const resolution = action.resolution === 'half' ? 'half' : 'bar';
  const spans = detectProjectChords(project, roles, scope, { resolution });
  if (spans.length === 0) fail('found no chords to read: it needs chord, pad, keys or bass notes with two or more notes at once');
  const start = Math.min(...spans.map((span) => span.tick));
  const end = Math.max(...spans.map((span) => span.tick + span.length));
  context.focus.span(start, end, 'detect chords');
  clearChords(context.draft, start, end);
  placeChords(context.draft, spans);
  context.touch(start, end);
  const flats = projectUsesFlats(project);
  const names = spans.slice(0, 8).map((span) => formatChord(span.chord, flats)).join(' | ');
  return `Read ${spans.length} chords from the notes (${barSpan(start, end, context.draft.transport.timeSig)}): ${names}${spans.length > 8 ? ' …' : ''}`;
}

function progression(action: Record<string, unknown>, context: OpContext): string {
  const ref = str(action.progression) ?? fail('chords: say which progression (see the list in the action)');
  const found = lookupProgression(ref) ?? fail(`there is no progression "${ref}" (ids: ${PROGRESSIONS.map((p) => p.id).join(', ')})`);
  const project = snapshot(context);
  const key = keyForMode(harmonyKey(project, rolesOf(project), found.mode), found.mode);
  const start = barTick(context, num(action.from_bar) ?? 1);
  const bars = num(action.bars);
  const built = layoutProgression(found, key, {
    startTick: start,
    bar: context.bar(),
    ...(bars !== undefined ? { bars: Math.max(1, Math.round(bars)) } : {}),
    ...(action.sevenths === true ? { sevenths: true } : {}),
  });
  const last = built[built.length - 1] ?? fail('that progression has no chords');
  const end = last!.tick + last!.length;
  context.focus.span(start, end, 'chords');
  clearChords(context.draft, start, end);
  placeChords(context.draft, built.map((entry) => ({ tick: entry.tick, length: entry.length, chord: entry.chord })));
  context.touch(start, end);
  const flats = projectUsesFlats(project);
  return `Chord track: ${found.name} in the song key, ${built.slice(0, 8).map((entry) => formatChord(entry.chord, flats)).join(' | ')} from bar ${Math.round(start / context.bar()) + 1}`;
}

/** Notes of a channel in a pattern that the part may touch (a notes focus limits it to the selection). */
function fitTargets(context: OpContext, target: ReturnType<typeof partTarget>): Note[] {
  const only = context.focus.notes(target.patternId, target.channelId);
  const notes = Object.values(context.draft.patterns[target.patternId]!.notes[target.channelId] ?? {}) as Draft<Note>[];
  return notes.filter((note) => !only || only.has(note.id)).map((note) => ({ ...note })).sort((x, y) => x.tick - y.tick);
}

export const harmony: OpModule = {
  schemas: [
    S.op(
      'chords',
      'The song-wide chord track (chord symbols over time): the harmony that chord parts, basslines and melodies are written against. set = type the chords, one a bar ("Am7 | F | C | G"; a "." holds the chord before); progression = a palette progression in the song key; detect = read the chords the song already plays from its chord, pad, keys and bass notes; clear = remove them. Set the song key first (song action). One undo step with the answer.',
      {
        action: { type: 'string', enum: ['set', 'progression', 'detect', 'clear'], description: 'What to do with the chord track.' },
        text: S.str('set: the chords as text, e.g. "Am7 | F | C/E | G7"; names like Am7, Bbmaj7, F/C, Gsus4, Dadd9, Bm7b5.'),
        bars_per_chord: S.num('set: bars each chord lasts (default 1; 0.5 for two chords a bar).'),
        progression: S.str(
          `progression: an id from the palette (${PROGRESSIONS.map((p) => p.id).join(', ')}); by mood (${MOODS.join(', ')}) or genre (${GENRES.join(', ')}) choose the one that fits.`,
        ),
        sevenths: S.bool('progression: use the key’s seventh chords instead of plain triads.'),
        bars: S.int('progression: bars to fill (it repeats; default one pass).'),
        from_bar: S.int('1-based first bar (set, progression, detect, clear; default 1; detect without it reads the whole song or the part asked about).'),
        to_bar: S.int('Last bar, inclusive (detect, clear).'),
        resolution: { type: 'string', enum: ['bar', 'half'], description: 'detect: one chord reading per bar (default) or per half bar.' },
      },
      ['action'],
    ),
    S.op(
      'voice_chords',
      'Writes the chord track as voiced chords into a channel’s pattern, with voice leading (the chords move as little as possible from one to the next). Replaces that channel’s notes in the pattern. Needs chords on the chord track.',
      {
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        register: { type: 'string', enum: [...REGISTERS], description: 'Where the chords sit: low (pads under a lead), mid (default) or high.' },
        spread: { type: 'string', enum: [...SPREADS], description: 'close (default), open (wider) or drop2 (jazz).' },
        rhythm: { type: 'string', enum: [...COMP_RHYTHMS], description: 'hold (default: each chord held), beats (struck every beat), offbeats, eighths.' },
        bass: S.bool('Add each chord’s root (or slash bass) as a low note.'),
        bars: S.int('Bars to write (default: the pattern’s length, or the chord track’s for a new pattern).'),
        velocity: S.num('Velocity 0..1 (default 0.8).'),
      },
      ['channel'],
    ),
    S.op(
      'bassline',
      'Writes a bassline that follows the chord track into a channel’s pattern: roots (held), root-fifth, walking (quarter notes with approach notes) or 808 (hits where the beat’s kick hits, on the chord’s root). Replaces that channel’s notes in the pattern.',
      {
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        style: { type: 'string', enum: [...BASS_STYLES], description: 'roots, root-fifth, walking or 808.' },
        bars: S.int('Bars to write (default: the pattern’s length, or the chord track’s for a new pattern).'),
        low: S.int('Lowest MIDI key (default 33; 28 for 808).'),
        velocity: S.num('Velocity 0..1 (default 0.85).'),
      },
      ['channel', 'style'],
    ),
    S.op(
      'fit_melody',
      'Moves a melody’s notes onto the chords: notes on strong beats (and long notes) go to the nearest chord tone, the others to the nearest note of the song key. strength 1 fixes every note that is off; less fixes the smallest moves first. Only keys change, never timing.',
      {
        pattern: S.PATTERN,
        channel: S.CHANNEL,
        strength: S.num('0..1 (default 1).'),
      },
      ['channel'],
    ),
  ],
  prompt: {
    id: 'harmony',
    order: 86,
    text: `Harmony (chords, voice_chords, bassline, fit_melody): for chords, a bassline and a melody that fit together, set the song key, put the harmony on the chord track first (chords: set, or progression by mood/genre, or detect from existing notes), then voice the chords, write the bassline (808 follows the kick) and fit the melody to it. The context shows the chord track as bars: "bars 1–8: Am7 | F | C | G".`,
  },
  handlers: {
    chords: (action, context) => {
      const subAction = oneOf(action.action, ['set', 'progression', 'detect', 'clear'] as const, 'action', 'set');
      if (subAction === 'set') return setChords(action, context);
      if (subAction === 'progression') return progression(action, context);
      if (subAction === 'detect') return detect(action, context);
      return clearTrack(action, context);
    },

    voice_chords: (action, context) => {
      const target = partTarget(action, context);
      const velocity = num(action.velocity);
      const bars = num(action.bars);
      const plan =
        planChordPart(snapshot(context), target.patternId, {
          register: oneOf<Register>(action.register, REGISTERS, 'register', 'mid'),
          spread: oneOf<Spread>(action.spread, SPREADS, 'spread', 'close'),
          rhythm: oneOf<CompRhythm>(action.rhythm, COMP_RHYTHMS, 'rhythm', 'hold'),
          ...(bool(action.bass) ? { bass: true } : {}),
          ...(bars !== undefined ? { bars } : {}),
          ...(velocity !== undefined ? { velocity: Math.max(0, Math.min(1, velocity)) } : {}),
        }) ?? fail(noChordsMessage);
      context.focus.wholePattern(target.patternId, target.channelId, 'voice chords');
      const written = writePart(context.draft, target.patternId, target.channelId, plan.notes, plan.length);
      return `Wrote ${plan.chordCount} voiced chords (${written} notes) for “${target.channelName}” in “${target.patternName}”`;
    },

    bassline: (action, context) => {
      const target = partTarget(action, context);
      const style = oneOf<BassStyle>(action.style, BASS_STYLES, 'style', 'roots');
      const bars = num(action.bars);
      const low = num(action.low);
      const velocity = num(action.velocity);
      const project = snapshot(context);
      const plan =
        planBassPart(project, target.patternId, rolesOf(project), {
          style,
          ...(bars !== undefined ? { bars } : {}),
          ...(low !== undefined ? { low: Math.max(0, Math.min(100, Math.round(low))) } : {}),
          ...(velocity !== undefined ? { velocity: Math.max(0, Math.min(1, velocity)) } : {}),
        }) ?? fail(noChordsMessage);
      context.focus.wholePattern(target.patternId, target.channelId, 'bassline');
      const written = writePart(context.draft, target.patternId, target.channelId, plan.notes, plan.length);
      return `Wrote a ${style} bassline (${written} notes) for “${target.channelName}” in “${target.patternName}”`;
    },

    fit_melody: (action, context) => {
      const target = partTarget(action, context);
      const raw = num(action.strength) ?? 1;
      const strength = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
      const notes = fitTargets(context, target);
      if (notes.length === 0) fail(`“${target.channelName}” has no notes in “${target.patternName}” to fit`);
      const plan = planMelodyFit(snapshot(context), target.patternId, notes, { strength });
      if (plan.withoutChord === plan.noteCount) fail(noChordsMessage);
      setNoteKeys(context.draft, target.patternId, target.channelId, plan.changes);
      return `Fit “${target.channelName}” to the chords: moved ${plan.changes.length} of ${plan.noteCount} notes in “${target.patternName}”`;
    },
  },
};
