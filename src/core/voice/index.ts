/**
 * Voice analysis: recordings of mouth sounds (beatboxing, a hummed bass line) → timed, classified
 * events → a step grid and a text summary. Pure TypeScript, no DOM (runs in a Worker or in Node).
 *
 *   const events = analyzeVoice(samples, sampleRate);
 *   const bpm = estimateBpm(events) ?? projectBpm;
 *   const steps = quantizeToGrid(events, { bpm, startSec: events[0]?.time ?? 0, bars: 2 });
 *   const text = describeEvents(steps); // + VOICE_SUMMARY_LEGEND in a prompt
 */
export {
  analyzeVoice,
  VOICE_THRESHOLDS,
  type AnalyzeOptions,
  type VoiceEvent,
  type VoiceFeatures,
  type VoiceKind,
} from './analyze';
export {
  describeEvents,
  estimateBpm,
  noteName,
  quantizeToGrid,
  VOICE_SUMMARY_LEGEND,
  type BpmOptions,
  type DescribeOptions,
  type Grid,
  type GridEvent,
  type QuantizeOptions,
} from './grid';
export { hzToMidi, midiToHz, trackPitch, type PitchOptions, type PitchTrack } from './pitch';
export { FFT, RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo, isPowerOfTwo } from './fft';
