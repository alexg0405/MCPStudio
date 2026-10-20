/**
 * The shapes of "Convert to MIDI": what is heard in the audio (in the recording's own seconds), what the musician asks
 * for, and the notes that come out (in pattern ticks). Pure data, no DOM.
 *
 * The work has two stages so the dialog stays quick: `detect*` listens to the audio once (slow, runs in a Worker) and
 * returns `Heard`; `planTranscription` turns `Heard` into notes for a clip with the quantize and note settings (fast, so
 * moving a slider re-plans at once).
 */
import type { Chromagram } from '../../dj/chroma';
import type { CompRhythm } from '../../harmony/voicing';

/** What kind of part to read out of the audio. */
export type TranscribeMode = 'melody' | 'drums' | 'chords' | 'bass';

/** Every mode, in the order a menu lists them. */
export const TRANSCRIBE_MODES: readonly TranscribeMode[] = ['melody', 'drums', 'chords', 'bass'];

/** How each mode is named for the musician, with a one-line explanation. */
export const MODE_LABELS: Readonly<Record<TranscribeMode, { label: string; hint: string }>> = {
  melody: { label: 'Melody', hint: 'One note at a time: a voice, a lead or a bass played alone. Pitch, timing and loudness become notes.' },
  drums: { label: 'Drums', hint: 'A drum loop or beat: kick, snare, clap, hats, toms and cymbals become hits on the General MIDI drum keys.' },
  chords: { label: 'Chords', hint: 'Several notes at once (keys, pads, guitar): finds the chord on every beat and writes them as notes.' },
  bass: { label: 'Bassline', hint: 'The lowest line of a mixed loop: ignores the drums and the high parts and follows the bass notes.' },
};

/** One note heard in the audio: seconds on the recording's own timeline, pitch as a MIDI number (fractions are cents). */
export interface HeardNote {
  fromSec: number;
  toSec: number;
  /** MIDI pitch as played in the audio (60 = C4), fractional. */
  pitch: number;
  /** 0..1: how loud it is against the loudest note of the recording. */
  level: number;
}

/** The kinds of drum hit that are told apart (the sample browser's drum categories). */
export type DrumKind = 'kick' | 'snare' | 'clap' | 'hat' | 'open-hat' | 'tom' | 'cymbal' | 'perc';

/** Every drum kind, in the order a report lists them. */
export const DRUM_KINDS: readonly DrumKind[] = ['kick', 'snare', 'clap', 'hat', 'open-hat', 'tom', 'cymbal', 'perc'];

/** One drum hit heard in the audio. */
export interface HeardHit {
  /** Seconds on the recording's timeline: the attack. */
  timeSec: number;
  kind: DrumKind;
  /** 0..1: how hard it was hit, against the hardest hit of its kind. */
  strength: number;
  /** 0..1: how sure the kind is. */
  confidence: number;
  /** Toms: the pitch of the body in Hz (so low, mid and high toms can be told apart). */
  bodyHz?: number;
}

/** A hit of another kind that sounds with a cut's own hit, and how long after it starts (s). */
export interface CoincidentHit {
  kind: DrumKind;
  deltaSec: number;
}

/** A stretch of the recording that is the best example of one kind of hit (for slicing into Drum Pads). */
export interface KitCut {
  kind: DrumKind;
  fromSec: number;
  toSec: number;
  /** The tom's pitch, to pick a pad. */
  bodyHz?: number;
  /** Hits of other kinds that sound with the example (a clap that is always on a kick): the pad can subtract their own examples. */
  with?: CoincidentHit[];
}

/**
 * What listening to a recording found: notes, drum hits (with kit examples), or the chroma of the harmony. Times are seconds on
 * the recording's own timeline; the chroma (made from a stretch that starts `startSec` into it) counts from its own start.
 */
export type Heard =
  | { kind: 'notes'; mode: 'melody' | 'bass'; notes: HeardNote[] }
  | { kind: 'drums'; hits: HeardHit[]; cuts: KitCut[] }
  | { kind: 'chroma'; chromagram: Chromagram; startSec: number };

/** How note starts and ends are pulled to a grid. */
export interface QuantizeSettings {
  /** Ticks between grid lines; 0 or 1 = no quantizing (the heard timing, rounded to a tick). */
  gridTicks: number;
  /** 0..1: how far each time moves towards its grid line (1 = onto it). */
  strength: number;
  /** `straighten`: onto straight lines (the song's swing, if any, then applies). `keep`: onto the recording's own swung lines. */
  swing: 'straighten' | 'keep';
}

/** How the ends of melody and bass notes are shaped. */
export type Articulation = 'legato' | 'natural' | 'staccato';

/** Everything the musician can set for a conversion. Fields left out take the default noted on them. */
export interface TranscribeSettings {
  mode: TranscribeMode;
  quantize: QuantizeSettings;
  /** 0..1: how much is picked up. Higher finds quieter and shorter sounds (and more mistakes). Default 0.5. */
  sensitivity: number;
  /** Melody and bass: `legato` closes gaps shorter than `legatoGapMs`, `natural` keeps the lengths heard, `staccato` halves them. */
  articulation: Articulation;
  /** The gap (ms) legato closes. Default 150. */
  legatoGapMs: number;
  /** Melody and bass: keep each note's cents off its semitone as the note's fine pitch (default: whole semitones only). */
  keepCents: boolean;
  /** Chords: how finely to look (a chord per beat, half bar or bar). */
  chordResolution: 'beat' | 'half' | 'bar';
  /** Chords: how the chord is played (held, on the beats, on the off-beats, every eighth). */
  chordRhythm: CompRhythm;
  /** Chords: add the chord's root as a low bass note. */
  chordBass: boolean;
  /** Chords: put the chords on the song's chord track as well. */
  fillChordTrack: boolean;
}

/** The settings a conversion starts with. */
export const DEFAULT_TRANSCRIBE: Omit<TranscribeSettings, 'mode'> = {
  quantize: { gridTicks: 240, strength: 1, swing: 'straighten' },
  sensitivity: 0.5,
  articulation: 'natural',
  legatoGapMs: 150,
  keepCents: false,
  chordResolution: 'beat',
  chordRhythm: 'hold',
  chordBass: false,
  fillChordTrack: false,
};

/** The settings for a mode with everything else at its default and `over` laid on top. */
export function settingsFor(mode: TranscribeMode, over: Partial<Omit<TranscribeSettings, 'mode'>> = {}): TranscribeSettings {
  return { mode, ...DEFAULT_TRANSCRIBE, ...over, quantize: { ...DEFAULT_TRANSCRIBE.quantize, ...over.quantize } };
}

/** One note of the result: ticks from the start of the clip (the pattern's own ticks), a MIDI key and a velocity. */
export interface PlannedNote {
  tick: number;
  length: number;
  key: number;
  /** 0..1 */
  velocity: number;
  /** Cents off the key (−100…100), only with `keepCents`. */
  fine?: number;
}

/** A chord found in the recording, in song ticks (what the chord track takes). */
export interface PlannedChord {
  tick: number;
  length: number;
  root: number;
  quality: string;
  bass?: number;
  confidence: number;
}

/** A hit to cut into a Drum Pads pad: the kind, the pad (1–16), the stretch of the recording and what else sounds in it. */
export interface PlannedPad {
  pad: number;
  kind: DrumKind;
  fromSec: number;
  toSec: number;
  with?: CoincidentHit[];
}

/** What a conversion makes, before anything is written to the project. */
export interface Transcription {
  mode: TranscribeMode;
  notes: PlannedNote[];
  /** Chords mode: the chords read (song ticks). */
  chords: PlannedChord[];
  /** Drums mode: the clean examples to slice into pads, one per pad that plays. */
  pads: PlannedPad[];
  /** The length the pattern needs (ticks): the clip's length. */
  lengthTicks: number;
  /** The recording's swing found (0..1), when enough notes sat on off-beats to measure it. */
  swingFound: number | null;
  /** Plain sentences about what was found, for the dialog and the AI. */
  summary: string[];
}
