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
    labels: { 'C#': 'C# / Db', 'D#': 'D# / Eb', 'F#': 'F# / Gb', 'G#': 'G# / Ab', 'A#': 'A# / Bb' },
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
};
