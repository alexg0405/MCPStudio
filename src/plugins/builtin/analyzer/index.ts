import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './analyzer.worklet.ts?worker&url';
import { AnalyzerUI } from './AnalyzerUI';
import { ANALYZER_ID, analyzerParams } from './params';

/**
 * Metering for a track or the master: spectrum, oscilloscope, loudness (LUFS), true peak and
 * stereo correlation. It passes audio through untouched unless a Listen mode is chosen.
 */
export default defineWorkletEffect({
  id: ANALYZER_ID,
  name: 'Analyzer',
  version: 1,
  category: 'Analysis',
  description:
    'Shows what a sound looks like (spectrum, waveform) and how loud it is (LUFS, true peak, stereo correlation) without changing it.',
  params: analyzerParams,
  processor,
  ui: AnalyzerUI,
  tap: { fftSize: 4096, smoothing: 0.7 },
  presets: [
    { name: 'Analyze (no change)', params: { listen: 'stereo' } },
    { name: 'Bass check (lows only)', params: { listen: 'lows' } },
    { name: 'Mono check', params: { listen: 'mono' } },
    { name: 'Side check (what mono loses)', params: { listen: 'side' } },
    { name: 'Highs check (above 4 kHz)', params: { listen: 'highs' } },
    { name: 'Left only', params: { listen: 'left' } },
    { name: 'Right only', params: { listen: 'right' } },
  ],
});
