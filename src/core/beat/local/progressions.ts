import type { Quality } from '../theory';

/** Four-bar progressions: chord roots in semitones above the key's root, and their qualities. */
export const PROGRESSIONS = {
  // Lo-fi: i7 – iv7 – ♭VII7 – ♭IIImaj7 (minor), ii7 – V7 – Imaj7 – vi7 (major).
  sevenths: {
    minor: [
      [0, 'm7'],
      [5, 'm7'],
      [10, '7'],
      [3, 'maj7'],
    ],
    major: [
      [2, 'm7'],
      [7, '7'],
      [0, 'maj7'],
      [9, 'm7'],
    ],
  },
  // EDM and pop: i – ♭VI – ♭III – ♭VII (minor), I – V – vi – IV (major).
  anthem: {
    minor: [
      [0, 'min'],
      [8, 'maj'],
      [3, 'maj'],
      [10, 'maj'],
    ],
    major: [
      [0, 'maj'],
      [7, 'maj'],
      [9, 'min'],
      [5, 'maj'],
    ],
  },
} as const satisfies Record<string, Record<'minor' | 'major', readonly (readonly [number, Quality])[]>>;
