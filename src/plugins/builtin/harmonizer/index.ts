import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './harmonizer.worklet.ts?worker&url';
import { HARMONIZER_ID, harmonizerLatencyFrames, harmonizerParams } from './params';

/**
 * Vocal harmonizer: up to three pitch-shifted copies of a voice that sing along in the song's key (a third
 * above, a fifth above, an octave below...) or on the notes a guide instrument holds, so a chord played on a
 * keyboard channel becomes a choir behind the lead. Each voice has its own interval, level and pan, a slow
 * human drift, and can keep the singer's formants. Its 12 ms shifter delay is reported as latency.
 */
export default defineWorkletEffect({
  id: HARMONIZER_ID,
  name: 'Harmonizer',
  version: 1,
  category: 'Voice',
  description:
    'Adds up to three harmony voices to a singer: intervals inside the key (a third above, a fifth above, an octave below), or the notes of a chord you play on a guide instrument. Each voice has its own level and pan, drifts a little like a real singer and keeps the voice’s formants.',
  params: harmonizerParams,
  processor,
  // The guide chord: the instrument channel the "Guide channel" param names (see PluginHost.notes).
  notes: { param: 'notesFrom' },
  latency: (sampleRate) => harmonizerLatencyFrames(sampleRate) / sampleRate,
  tap: true,
  meters: [
    { reading: 'pitch', label: 'Hears', kind: 'hz', hint: 'The pitch the Harmonizer detects in the input (— while it hears no clear note)' },
    { reading: 'target', label: 'Voice 1 sings', kind: 'note', hint: 'The note voice 1 is singing (the key’s note it moved to, or the guide chord’s note it follows)' },
  ],
  // Nothing rings after the input stops: a voice reads at most a few tens of milliseconds back.
  tailTime: 0.05,
  presets: [
    {
      name: 'Thirds above',
      params: { voices: 1, interval1: 2, semitones1: 0, level1: -3, pan1: 0, humanize: 5, tighten: 0, formant: true, mix: 0.5 },
    },
    {
      name: 'Choir stack',
      params: {
        voices: 3,
        interval1: 2,
        level1: -4,
        pan1: -0.6,
        interval2: 4,
        level2: -4,
        pan2: 0.6,
        interval3: -7,
        level3: -7,
        pan3: 0,
        humanize: 12,
        tighten: 0.3,
        formant: true,
        mix: 0.55,
      },
    },
    {
      name: 'Octave down',
      params: { voices: 1, interval1: -7, semitones1: 0, level1: -2, pan1: 0, humanize: 3, tighten: 0, formant: true, mix: 0.5 },
    },
    {
      name: 'Gospel 3-part',
      params: {
        voices: 3,
        interval1: -2,
        level1: -4,
        pan1: -0.5,
        interval2: 2,
        level2: -4,
        pan2: 0.5,
        interval3: 4,
        level3: -5,
        pan3: 0,
        humanize: 8,
        tighten: 0.5,
        formant: true,
        mix: 0.55,
      },
    },
  ],
});
