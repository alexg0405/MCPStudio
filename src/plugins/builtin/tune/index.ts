import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './tune.worklet.ts?worker&url';
import { TUNE_ID, tuneLatencyFrames, tuneParams } from './params';

/**
 * Scale pitch correction for vocals (or any single melody line): pulls each note to the nearest
 * note of the chosen key and scale, or to the notes a guide instrument channel plays. It can leave
 * the singer's natural drift in, add vibrato, and keep the voice's formants. Its 12 ms shifter
 * window is reported as latency.
 */
export default defineWorkletEffect({
  id: TUNE_ID,
  name: 'Tune',
  version: 1,
  category: 'Voice',
  description:
    'Pulls a singer (or any single melody) to the notes of a key and scale, or to a guide melody you play, from gentle correction to the robotic hard-tune effect. Can keep natural drift, add vibrato and keep the voice’s formants.',
  params: tuneParams,
  processor,
  // The guide melody: the instrument channel the "Guide channel" param names (see PluginHost.notes).
  notes: { param: 'notesFrom' },
  latency: (sampleRate) => tuneLatencyFrames(sampleRate) / sampleRate,
  tap: true,
  meters: [
    { reading: 'pitch', label: 'Hears', kind: 'hz', hint: 'The pitch Tune detects in the input (— while it hears no clear note)' },
    { reading: 'target', label: 'Pulls to', kind: 'note', hint: 'The note of the key and scale (or the guide melody) it is tuning to' },
    { reading: 'cents', label: 'Correction', kind: 'cents', hint: 'How far it is moving the pitch right now (100 ct = a semitone)' },
  ],
  tailTime: 0.05,
  presets: [
    { name: 'Natural vocal tune (C major)', params: { key: 'C', scale: 'major', speed: 60, mix: 1 } },
    { name: 'Hard tune robot (A minor)', params: { key: 'A', scale: 'minor', speed: 0, mix: 1 } },
    { name: 'Gentle correction (chromatic)', params: { scale: 'chromatic', speed: 120, mix: 1 } },
    { name: 'Pop tune (G major)', params: { key: 'G', scale: 'major', speed: 25, mix: 1 } },
    { name: 'Minor pentatonic snap (E)', params: { key: 'E', scale: 'minor-pentatonic', speed: 5, mix: 1 } },
    { name: 'Deep voice hard tune (F minor)', params: { key: 'F', scale: 'minor', speed: 0, range: 'low' } },
    // Added with pitch correction: they use the feel and formant params.
    { name: 'Hard trap tune (C minor)', params: { key: 'C', scale: 'minor', speed: 0, humanize: 0, vibratoDepth: 0, formant: true, mix: 1 } },
    { name: 'Natural pop (C major)', params: { key: 'C', scale: 'major', speed: 45, humanize: 0.6, vibratoDepth: 0, formant: true, mix: 1 } },
    { name: 'Robot', params: { key: 'C', scale: 'whole-tone', speed: 0, humanize: 0, vibratoDepth: 0, range: 'low', formant: true, mix: 1 } },
  ],
});
