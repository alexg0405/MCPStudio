/**
 * From what was heard in a recording to the notes of a pattern: one entry point for the four modes. The notes land in the
 * clip's own ticks (trim, tempo follow and pitch respected), snapped to the grid as asked, and the result carries plain
 * sentences about what was found. Cheap enough to run again on every change of a setting; the listening it is made from
 * (`Heard`) is the slow part. Pure and deterministic.
 */
import { formatChord } from '../../harmony/chord';
import { noteName } from '../../voice/grid';
import { chordNotes, plannedChords, readChords } from './chords';
import { planDrums } from './plan-drums';
import { planNoteLine } from './plan-notes';
import type { ClipTimeline } from './timeline';
import { DRUM_KINDS, MODE_LABELS, type Heard, type PlannedNote, type Transcription, type TranscribeSettings } from './types';

/** Why a heard result cannot be planned for the settings' mode. */
export class TranscribePlanError extends Error {}

/** A plural: "1 note", "3 notes". */
const count = (n: number, noun: string, plural = `${noun}s`): string => `${n} ${n === 1 ? noun : plural}`;

/** The lowest and highest key of a list of notes as names ("C2 to G3"). */
function rangeOf(notes: readonly PlannedNote[]): string {
  const keys = notes.map((n) => n.key);
  return `${noteName(Math.min(...keys))} to ${noteName(Math.max(...keys))}`;
}

const DRUM_NAMES: Readonly<Record<string, [string, string]>> = {
  kick: ['kick', 'kicks'],
  snare: ['snare', 'snares'],
  clap: ['clap', 'claps'],
  hat: ['hat', 'hats'],
  'open-hat': ['open hat', 'open hats'],
  tom: ['tom', 'toms'],
  cymbal: ['cymbal', 'cymbals'],
  perc: ['percussion hit', 'percussion hits'],
};

/** The sentence about the swing found, when there is one worth saying. */
function swingSentence(swingFound: number | null, settings: TranscribeSettings): string[] {
  if (swingFound === null || swingFound < 0.05) return [];
  const percent = Math.round(swingFound * 100);
  const what = settings.quantize.swing === 'keep' ? 'kept in the notes' : 'straightened (the song’s own swing setting still applies)';
  return [`Swing found: ${percent}%, ${what}.`];
}

/** An empty plan for a mode, with the sentence that says why. */
function nothing(mode: TranscribeSettings['mode'], lengthTicks: number, why: string): Transcription {
  return { mode, notes: [], chords: [], pads: [], lengthTicks, swingFound: null, summary: [why] };
}

/** Melody and bass: notes of one line. */
function planLine(heard: Extract<Heard, { kind: 'notes' }>, timeline: ClipTimeline, settings: TranscribeSettings): Transcription {
  const { notes, swingFound } = planNoteLine(heard.notes, timeline, settings);
  const lengthTicks = timeline.clip.length;
  if (notes.length === 0) return nothing(settings.mode, lengthTicks, `No ${settings.mode === 'bass' ? 'bass notes' : 'notes'} were found in this clip. Try a higher sensitivity, or another mode.`);
  const summary = [`Found ${count(notes.length, 'note')}, ${rangeOf(notes)}.`, ...swingSentence(swingFound, settings)];
  return { mode: settings.mode, notes, chords: [], pads: [], lengthTicks, swingFound, summary };
}

/** Drums: hits on General MIDI keys. */
function planKit(heard: Extract<Heard, { kind: 'drums' }>, timeline: ClipTimeline, settings: TranscribeSettings): Transcription {
  const lengthTicks = timeline.clip.length;
  const { notes, pads, swingFound } = planDrums(heard.hits, heard.cuts, timeline, settings);
  if (notes.length === 0) return nothing('drums', lengthTicks, 'No drum hits were found in this clip. Try a higher sensitivity, or another mode.');
  const kinds = DRUM_KINDS.map((kind) => ({ kind, n: heard.hits.filter((h) => h.kind === kind).length })).filter((k) => k.n > 0);
  const parts = kinds.map((k) => count(k.n, (DRUM_NAMES[k.kind] as [string, string])[0], (DRUM_NAMES[k.kind] as [string, string])[1]));
  return { mode: 'drums', notes, chords: [], pads, lengthTicks, swingFound, summary: [`Found ${count(notes.length, 'hit')}: ${parts.join(', ')}.`, ...swingSentence(swingFound, settings)] };
}

/** Chords: one chord per window, voiced as notes. */
function planHarmony(heard: Extract<Heard, { kind: 'chroma' }>, timeline: ClipTimeline, settings: TranscribeSettings): Transcription {
  const lengthTicks = timeline.clip.length;
  const spans = readChords(heard.chromagram, timeline, settings);
  if (spans.length === 0) return nothing('chords', lengthTicks, 'No chords were found in this clip: it needs several notes sounding together. Try Melody or Bassline for a single line.');
  const notes = chordNotes(spans, timeline, settings);
  const names = spans.slice(0, 8).map((span) => formatChord(span.chord));
  const more = spans.length > names.length ? ` and ${spans.length - names.length} more` : '';
  return { mode: 'chords', notes, chords: plannedChords(spans), pads: [], lengthTicks, swingFound: null, summary: [`Found ${count(spans.length, 'chord')}: ${names.join(' ')}${more}.`] };
}

/** The notes for what was heard in a clip, as the settings ask. Throws `TranscribePlanError` when `heard` is not of the settings' mode. */
export function planTranscription(heard: Heard, timeline: ClipTimeline, settings: TranscribeSettings): Transcription {
  const label = MODE_LABELS[settings.mode].label;
  switch (settings.mode) {
    case 'melody':
    case 'bass':
      if (heard.kind !== 'notes') throw new TranscribePlanError(`${label} needs the notes of the recording, not ${heard.kind}.`);
      return planLine(heard, timeline, settings);
    case 'drums':
      if (heard.kind !== 'drums') throw new TranscribePlanError(`${label} needs the drum hits of the recording, not ${heard.kind}.`);
      return planKit(heard, timeline, settings);
    case 'chords':
      if (heard.kind !== 'chroma') throw new TranscribePlanError(`${label} needs the harmony of the recording, not ${heard.kind}.`);
      return planHarmony(heard, timeline, settings);
  }
}
