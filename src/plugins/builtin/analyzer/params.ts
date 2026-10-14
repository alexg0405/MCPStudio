import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts), the editor and the audio-thread kernel (kernel.ts).
export const ANALYZER_ID = 'agstudio.analyzer';

export const LISTEN = ['stereo', 'mono', 'side', 'lows', 'highs', 'left', 'right'] as const;
/** Crossovers of the "lows only" and "highs only" listening modes. */
export const LOWS_HZ = 150;
export const HIGHS_HZ = 4000;

/** What the kernel publishes for the editor (`tap.reading(name)`). */
export const READINGS = ['momentary', 'shortTerm', 'integrated', 'truePeak', 'peakL', 'peakR', 'correlation'] as const;

export const analyzerParams = {
  listen: p.enum(LISTEN, 'stereo', {
    label: 'Listen',
    group: 'Listen',
    labels: {
      stereo: 'Stereo (as is)',
      mono: 'Mono (what both sides share)',
      side: 'Side only (what mono loses)',
      lows: 'Lows only (below 150 Hz)',
      highs: 'Highs only (above 4 kHz)',
      left: 'Left only',
      right: 'Right only',
    },
    hint: 'What you hear while you check a mix (the meters always measure the real signal)',
  }),
};
