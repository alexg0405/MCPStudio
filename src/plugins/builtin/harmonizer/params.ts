import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts). The
// scales repeat `SCALES` from '@agstudio/sdk/notes' (a test keeps them equal): this file runs on
// the audio thread too, so it doesn't import the notes module.
export const HARMONIZER_ID = 'agstudio.harmonizer';

export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** The same ids, labels and intervals as SCALES in src/sdk/notes/scales.ts, in the same order. */
export const HARMONIZER_SCALES = [
  { id: 'major', label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic-minor', label: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor', label: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', label: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'major-pentatonic', label: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'major-blues', label: 'Major blues', intervals: [0, 2, 3, 4, 7, 9] },
  { id: 'phrygian-dominant', label: 'Phrygian dominant', intervals: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'harmonic-major', label: 'Harmonic major', intervals: [0, 2, 4, 5, 7, 8, 11] },
  { id: 'double-harmonic', label: 'Double harmonic', intervals: [0, 1, 4, 5, 7, 8, 11] },
  { id: 'hungarian-minor', label: 'Hungarian minor', intervals: [0, 2, 3, 6, 7, 8, 11] },
  { id: 'hirajoshi', label: 'Hirajoshi', intervals: [0, 2, 3, 7, 8] },
  { id: 'in-sen', label: 'In-sen', intervals: [0, 1, 5, 7, 10] },
  { id: 'whole-tone', label: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10] },
  { id: 'diminished', label: 'Diminished (whole-half)', intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: 'chromatic', label: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
] as const;

type ScaleId = (typeof HARMONIZER_SCALES)[number]['id'];
export const SCALE_IDS = HARMONIZER_SCALES.map((s) => s.id) as unknown as readonly [ScaleId, ...ScaleId[]];

/** What the voices follow: the song's key and scale, or the notes a guide instrument channel holds. */
export const HARMONY_SOURCES = ['scale', 'notes'] as const;

/** Pitch ranges the detector looks in (the same three as Tune). */
export const RANGES = ['low', 'mid', 'high'] as const;
export const RANGE_HZ: Readonly<Record<(typeof RANGES)[number], readonly [number, number]>> = {
  low: [50, 500],
  mid: [80, 800],
  high: [150, 1200],
};

/** How many harmony voices there are at most. */
export const MAX_VOICES = 3;

/** Seconds of delay the voices read at when nothing is being shifted (and the dry path waits). */
const CENTRE_SECONDS = 0.012;
/** Frames the Harmonizer delays its audio by: the shifter's resting delay. */
export function harmonizerLatencyFrames(sampleRate: number): number {
  return Math.round(sampleRate * CENTRE_SECONDS);
}

/** The scale-step interval of one voice: whole steps up (+) or down (-) the scale from the sung note. */
const intervalSpec = (voice: number, steps: number) =>
  p.int(-7, 7, steps, {
    label: `Voice ${voice} interval`,
    group: `Voice ${voice}`,
    hint: 'Steps up (+) or down (−) the scale from the sung note: +2 = a third above, +4 = a fifth above, +5 = a sixth above, −7 = an octave below. Ignored when Target = Played notes',
  });

/** A fixed shift added on top of the scale steps (0 steps + this = a plain pitch shift). */
const semitonesSpec = (voice: number) =>
  p.int(-12, 12, 0, {
    label: `Voice ${voice} shift`,
    unit: 'st',
    group: `Voice ${voice}`,
    hint: 'Fixed semitones added to the interval (12 st = an octave). With the interval at 0 this is a plain pitch shift that ignores the key; the sum is kept within one octave either way. Ignored when Target = Played notes',
  });

const levelSpec = (voice: number) =>
  p.float(-24, 6, -3, {
    label: `Voice ${voice} level`,
    unit: 'dB',
    scale: 'db',
    group: `Voice ${voice}`,
    hint: 'How loud this harmony voice is against the others (before the Mix)',
  });

const panSpec = (voice: number, pan: number) =>
  p.float(-1, 1, pan, {
    label: `Voice ${voice} pan`,
    group: `Voice ${voice}`,
    hint: 'Where this harmony voice sits, from the left speaker (−100%) to the right (+100%)',
  });

export const harmonizerParams = {
  source: p.enum(HARMONY_SOURCES, 'scale', {
    label: 'Target',
    group: 'Harmony',
    labels: { scale: 'Key and scale', notes: 'Played notes (guide chord)' },
    hint: 'What the voices follow: intervals inside the key and scale, or the notes an instrument channel holds (play the chord you want sung)',
  }),
  notesFrom: p.int(0, 32, 0, {
    label: 'Guide channel',
    group: 'Harmony',
    automatable: false,
    hint: 'With Target = Played notes: which instrument channel plays the guide chord, counting instrument channels in the channel rack (1 = the first; 0 = none). Voice 1 takes the held note nearest the sung pitch, voice 2 the next one above it, voice 3 the next one below. No note held = no harmony',
  }),
  key: p.enum(KEYS, 'C', {
    label: 'Key',
    group: 'Harmony',
    labels: {
      C: 'C',
      'C#': 'C# / Db',
      D: 'D',
      'D#': 'D# / Eb',
      E: 'E',
      F: 'F',
      'F#': 'F# / Gb',
      G: 'G',
      'G#': 'G# / Ab',
      A: 'A',
      'A#': 'A# / Bb',
      B: 'B',
    },
    hint: 'The key of the song: the harmony voices stay on the notes of this key’s scale',
  }),
  scale: p.enum(SCALE_IDS, 'major', {
    label: 'Scale',
    group: 'Harmony',
    labels: Object.fromEntries(HARMONIZER_SCALES.map((s) => [s.id, s.label])) as Record<ScaleId, string>,
    hint: 'Which notes the harmony may use: a third above the sung note is two notes up this scale',
  }),
  range: p.enum(RANGES, 'mid', {
    label: 'Voice range',
    group: 'Harmony',
    labels: { low: 'Low voice (50–500 Hz)', mid: 'Middle voice (80–800 Hz)', high: 'High voice (150–1200 Hz)' },
    hint: 'Where to look for the pitch: pick the one that fits the singer (or instrument)',
  }),
  voices: p.int(1, MAX_VOICES, 2, {
    label: 'Voices',
    group: 'Harmony',
    hint: 'How many harmony voices sing along with the original (1–3)',
  }),
  interval1: intervalSpec(1, 2),
  semitones1: semitonesSpec(1),
  level1: levelSpec(1),
  pan1: panSpec(1, -0.5),
  interval2: intervalSpec(2, 4),
  semitones2: semitonesSpec(2),
  level2: levelSpec(2),
  pan2: panSpec(2, 0.5),
  interval3: intervalSpec(3, -7),
  semitones3: semitonesSpec(3),
  level3: levelSpec(3),
  pan3: panSpec(3, 0),
  humanize: p.float(0, 30, 6, {
    label: 'Humanize',
    unit: 'ct',
    group: 'Feel',
    hint: 'How far each voice drifts sharp and flat on its own, slowly, in cents (100 ct = a semitone), so the voices sound like separate singers and do not phase against each other. 0 = exact intervals',
  }),
  tighten: p.float(0, 1, 0, {
    label: 'Snap to key',
    unit: '%',
    group: 'Feel',
    hint: 'How much of the sung note’s mistuning is taken out of the harmony: 0% keeps the voices exactly an interval from the singer (they follow slides and vibrato), 100% puts them dead on the notes of the scale. Not used when Target = Played notes (those voices always land on the held notes)',
  }),
  formant: p.bool(true, {
    label: 'Keep formants',
    group: 'Output',
    hint: 'Keeps each voice’s tone colour (its vowel shape) when it is moved, so a third up does not sound like a chipmunk. Costs a little more CPU',
  }),
  mix: p.float(0, 1, 0.5, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: '0% is the original only, 50% the original with the full harmony under it, 100% only the harmony voices',
  }),
};
