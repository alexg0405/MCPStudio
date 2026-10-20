/**
 * Convert to MIDI, the pure part (no DOM, runs in Node or a Worker): listen to a recording for a mode (`listen`), plan the
 * notes for a clip (`planTranscription`), suggest the mode that fits (`suggestMode`). See docs/architecture.md "Audio to MIDI".
 */
export { listen, type ListenOptions } from './listen';
export { planTranscription, TranscribePlanError } from './plan';
export { suggestMode, type ModeSuggestion } from './suggest';
export { GM_KEY } from './plan-drums';
export { measureSwing } from './quantize';
export { clipEndTick, songTickAt, type ClipTimeline } from './timeline';
export {
  DEFAULT_TRANSCRIBE,
  DRUM_KINDS,
  MODE_LABELS,
  settingsFor,
  TRANSCRIBE_MODES,
  type Articulation,
  type CoincidentHit,
  type DrumKind,
  type Heard,
  type HeardHit,
  type HeardNote,
  type KitCut,
  type PlannedChord,
  type PlannedNote,
  type PlannedPad,
  type QuantizeSettings,
  type Transcription,
  type TranscribeMode,
  type TranscribeSettings,
} from './types';
