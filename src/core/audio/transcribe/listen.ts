/**
 * Listening to a recording for a mode: the one slow step of "Convert to MIDI" (a Worker runs it for long clips). The result,
 * `Heard`, is in the recording's own seconds and does not depend on the clip, the tempo or the quantize settings, so it can be
 * kept and planned again for any of them (`planTranscription`).
 */
import { detectBass } from './bass';
import { detectChroma } from './chords';
import { detectDrums } from './drums';
import { detectMelody } from './melody';
import type { Heard, TranscribeMode } from './types';

/** What listening is told besides the audio. */
export interface ListenOptions {
  /** 0..1: how much is picked up (default 0.5). Melody, drums and bass use it; chords do not. */
  sensitivity?: number;
}

/** Listens to mono audio for one mode. */
export function listen(mode: TranscribeMode, mono: Float32Array, sampleRate: number, options: ListenOptions = {}): Heard {
  const sensitivity = options.sensitivity ?? 0.5;
  switch (mode) {
    case 'melody':
      return { kind: 'notes', mode: 'melody', notes: detectMelody(mono, sampleRate, { sensitivity }) };
    case 'bass':
      return { kind: 'notes', mode: 'bass', notes: detectBass(mono, sampleRate, { sensitivity }) };
    case 'drums':
      return { kind: 'drums', ...detectDrums(mono, sampleRate, { sensitivity }) };
    case 'chords':
      return { kind: 'chroma', chromagram: detectChroma(mono, sampleRate) };
  }
}
