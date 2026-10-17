import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts). The
// scales repeat `SCALES` from '@agstudio/sdk/notes' (a test keeps them equal): this file runs on
// the audio thread too, so it doesn't import the notes module.
export const TUNE_ID = 'agstudio.tune';

export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** The same ids, labels and intervals as SCALES in src/sdk/notes/scales.ts, in the same order. */
export const TUNE_SCALES = [
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

type ScaleId = (typeof TUNE_SCALES)[number]['id'];
export const SCALE_IDS = TUNE_SCALES.map((s) => s.id) as unknown as readonly [ScaleId, ...ScaleId[]];

/** What the voice is pulled to. */
export const TARGET_SOURCES = ['scale', 'notes'] as const;

/** Pitch ranges the detector looks in. */
export const RANGES = ['low', 'mid', 'high'] as const;
export const RANGE_HZ: Readonly<Record<(typeof RANGES)[number], readonly [number, number]>> = {
  low: [50, 500],
  mid: [80, 800],
  high: [150, 1200],
};

/** The shifter's resting delay (its read head sits there when nothing needs correcting). */
const CENTRE_SECONDS = 0.012;
/** Frames Tune delays its audio by: the shifter's resting delay. */
export function tuneLatencyFrames(sampleRate: number): number {
  return Math.round(sampleRate * CENTRE_SECONDS);
}

export const tuneParams = {
  key: p.enum(KEYS, 'C', {
    label: 'Key',
    group: 'Correction',
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
    hint: 'The key of the song: notes are pulled to this key’s scale',
  }),
  scale: p.enum(SCALE_IDS, 'chromatic', {
    label: 'Scale',
    group: 'Correction',
    labels: Object.fromEntries(TUNE_SCALES.map((s) => [s.id, s.label])) as Record<ScaleId, string>,
    hint: 'Which notes are allowed: Chromatic corrects to the nearest semitone, a scale to its own notes only',
  }),
  speed: p.float(0, 400, 40, {
    label: 'Retune speed',
    unit: 'ms',
    group: 'Correction',
    hint: '0 snaps instantly (the robotic hard-tune sound); 30–80 ms sounds natural; slower keeps vibrato',
  }),
  range: p.enum(RANGES, 'mid', {
    label: 'Voice range',
    group: 'Correction',
    labels: { low: 'Low voice (50–500 Hz)', mid: 'Middle voice (80–800 Hz)', high: 'High voice (150–1200 Hz)' },
    hint: 'Where to look for the pitch: pick the one that fits the singer (or instrument)',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend of the tuned voice with the original (below 100% sounds like a doubled voice)',
  }),
  // ---- Added with pitch correction (B2): every default leaves the sound as it was before them ----
  source: p.enum(TARGET_SOURCES, 'scale', {
    label: 'Target',
    group: 'Correction',
    labels: { scale: 'Key and scale', notes: 'Played notes (guide melody)' },
    hint: 'What the voice is pulled to: the notes of the key and scale, or the notes an instrument channel plays (a guide melody: play the line you want sung, hold chords for the nearest note)',
  }),
  notesFrom: p.int(0, 32, 0, {
    label: 'Guide channel',
    group: 'Correction',
    automatable: false,
    hint: 'With Target = Played notes: which instrument channel plays the guide melody, counting instrument channels in the channel rack (1 = the first; 0 = none). Notes heard while none is held leave the voice as it is',
  }),
  humanize: p.float(0, 1, 0, {
    label: 'Keep natural drift',
    unit: '%',
    group: 'Feel',
    automatable: false,
    hint: 'How much of the singer’s slow pitch wandering inside a note is left in (100% keeps it all, 0 straightens every note onto its target). Vibrato and quick slips are still corrected',
  }),
  vibratoDepth: p.float(0, 100, 0, {
    label: 'Added vibrato',
    unit: 'ct',
    group: 'Feel',
    automatable: false,
    hint: 'Adds a gentle vibrato to held notes: how far the pitch swings either way, in cents (100 ct = a semitone). It fades in about a third of a second after each note starts. 0 = none',
  }),
  vibratoRate: p.float(2, 9, 5.5, {
    label: 'Vibrato rate',
    unit: 'Hz',
    group: 'Feel',
    automatable: false,
    hint: 'Speed of the added vibrato, in swings per second (5–6 Hz sounds natural)',
  }),
  formant: p.bool(false, {
    label: 'Keep formants',
    group: 'Output',
    hint: 'Keeps the voice’s tone colour (its vowel shape) when it is moved, so big corrections sound less like a chipmunk or a giant. Costs a little more CPU',
  }),
};
