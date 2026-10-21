/**
 * The engraver: a part's notes, the time signature and the song key in, a score (staves of bars of voices of notes and
 * rests, with ties, beams, accidentals, lyrics, chord symbols and dynamics) out. Pure and deterministic: the same input
 * always gives the same score, which the renderers and the exporters then draw or write.
 *
 * The steps: round the notes to a grid and find triplet beats (`quantize.ts`), pick the clefs and share the notes among
 * the staves, put chords into voices (`voices.ts`), cut them into notes and rests bar by bar (`measures.ts`), then place
 * accidentals, stems and beams, and the words and marks around them.
 */
import type { Tick } from '../model/types';
import { markDynamics, placeChordSymbols, placeLyrics } from './annotate';
import { placeAccidentals } from './accidentals';
import { meterOf } from './meter';
import { buildBar, type BuildContext } from './measures';
import { quantizeNotes, type QuantizedNote } from './quantize';
import { keySignatureOf, spellKey } from './spelling';
import { placeAllStems } from './stems';
import type { ClefChoice, ClefKind, EngraveInput, Measure, NotationNote, Score, StaffMeasure, Voice } from './types';
import { drumVoices, pitchedVoices, type StaffVoices, type VoiceEvent } from './voices';

/** The lowest key a treble staff alone may hold (A3, two ledger lines below), and the highest a bass staff alone may hold (E4). */
const TREBLE_LOWEST = 57;
const BASS_HIGHEST = 64;
/** On a grand staff, this key (middle C) and above go on the treble staff. */
const SPLIT_KEY = 60;

/** The clefs for a part: one for a narrow range, treble over bass for a wide one. */
export function chooseClefs(notes: readonly NotationNote[], choice: ClefChoice, isPercussion: boolean): ClefKind[] {
  if (isPercussion) return ['percussion'];
  if (choice === 'treble') return ['treble'];
  if (choice === 'bass') return ['bass'];
  if (choice === 'grand') return ['treble', 'bass'];
  if (notes.length === 0) return ['treble'];
  const low = Math.min(...notes.map((note) => note.key));
  const high = Math.max(...notes.map((note) => note.key));
  if (low >= TREBLE_LOWEST) return ['treble'];
  if (high <= BASS_HIGHEST) return ['bass'];
  return ['treble', 'bass'];
}

/** Which staff a key is written on (0 is the top one). */
const staffOf = (key: number, clefCount: number): number => (clefCount === 1 || key >= SPLIT_KEY ? 0 : 1);

function voicesFor(notes: readonly QuantizedNote[], input: EngraveInput, gridTicks: Tick): StaffVoices {
  const meter = meterOf(input.timeSig);
  return input.isPercussion ? drumVoices(notes, meter) : pitchedVoices(notes, gridTicks);
}

/** How many bars the score needs: the pattern's, and more when notes run past it. */
function barCountOf(input: EngraveInput, staves: readonly StaffVoices[], barTicks: Tick): number {
  let end = input.lengthTicks;
  for (const staff of staves) for (const voice of staff.voices) for (const event of voice) end = Math.max(end, event.end);
  return Math.max(1, Math.ceil(end / barTicks));
}

function emptyMeasure(index: number, barTicks: Tick, staffCount: number): Measure {
  return { index, startTick: index * barTicks, ticks: barTicks, staves: Array.from({ length: staffCount }, () => ({ voices: [] as Voice[] })), chordSymbols: [] };
}

/** Builds the bars of every staff. */
function buildMeasures(staves: readonly StaffVoices[], barCount: number, ctx: BuildContext): Measure[] {
  const barTicks = ctx.meter.barTicks;
  const measures: Measure[] = [];
  for (let index = 0; index < barCount; index++) {
    const measure = emptyMeasure(index, barTicks, staves.length);
    staves.forEach((staff, staffIndex) => {
      const staffMeasure = measure.staves[staffIndex] as StaffMeasure;
      for (const number of [1, 2] as const) {
        const items = buildBar(staff.voices[number - 1] as VoiceEvent[], measure.startTick, measure.startTick + barTicks, number, ctx);
        if (items.length > 0) staffMeasure.voices.push({ number, items });
      }
      // A drum bar with only feet (a kick part) shows no rest for the empty hands.
      const [first, second] = staffMeasure.voices;
      const isEmptyHands = first?.items.length === 1 && first.items[0]?.kind === 'rest' && second !== undefined;
      if (ctx.isPercussion && isEmptyHands) staffMeasure.voices.shift();
    });
    measures.push(measure);
  }
  return measures;
}

/** Engraves a part. */
export function engrave(input: EngraveInput): Score {
  const meter = meterOf(input.timeSig);
  const signature = keySignatureOf(input.key);
  const quantized = quantizeNotes(input.notes, meter, input.grid, { useEnds: !input.isPercussion });
  const clefs = chooseClefs(input.notes, input.clef, input.isPercussion);
  const perStaff: QuantizedNote[][] = clefs.map(() => []);
  for (const note of quantized.notes) perStaff[staffOf(note.note.key, clefs.length)]!.push(note);
  const staves = perStaff.map((notes) => voicesFor(notes, input, quantized.gridTicks));
  const ctx: BuildContext = {
    meter,
    tripletUnits: quantized.tripletUnits,
    windowTicks: quantized.windowTicks,
    isPercussion: input.isPercussion,
    spell: (key) => spellKey(key, input.key, signature),
  };
  const measures = buildMeasures(staves, barCountOf(input, staves, meter.barTicks), ctx);
  if (!input.isPercussion) clefs.forEach((_, staff) => placeAccidentals(measures, staff, signature));
  placeAllStems(measures, clefs, meter);
  if (input.dynamics && !input.isPercussion) clefs.forEach((_, staff) => markDynamics(measures, staff));
  if (input.lyrics && input.lyrics.length > 0) placeLyrics(measures, 0, input.lyrics);
  if (input.chords) placeChordSymbols(measures, input.chords);
  return {
    timeSig: input.timeSig,
    keySignature: signature,
    bpm: input.bpm,
    isPercussion: input.isPercussion,
    clefs,
    measures,
    simplified: staves.reduce((sum, staff) => sum + staff.simplified, 0),
    hasLyrics: !!input.lyrics && input.lyrics.length > 0,
  };
}
