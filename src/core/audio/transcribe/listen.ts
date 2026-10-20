/**
 * Listening to a recording for a mode: the one slow step of "Convert to MIDI" (a Worker runs it for long clips). The result,
 * `Heard`, is in the recording's own seconds and does not depend on the clip, the tempo or the quantize settings, so it can be
 * kept and planned again for any of them (`planTranscription`).
 */
import { detectBass } from './bass';
import { detectChroma } from './chords';
import { detectDrums } from './drums';
import { detectMelody } from './melody';
import type { Heard, HeardNote, TranscribeMode } from './types';

/** What listening is told besides the audio. */
export interface ListenOptions {
  /** 0..1: how much is picked up (default 0.5). Melody, drums and bass use it; chords do not. */
  sensitivity?: number;
  /** Where the first sample of `mono` is on the recording's timeline, seconds (default 0): heard times are made absolute with it. */
  startSec?: number;
}

/** Listens to mono audio for one mode. */
export function listen(mode: TranscribeMode, mono: Float32Array, sampleRate: number, options: ListenOptions = {}): Heard {
  const sensitivity = options.sensitivity ?? 0.5;
  const startSec = options.startSec ?? 0;
  switch (mode) {
    case 'melody':
      return { kind: 'notes', mode: 'melody', notes: shiftNotes(detectMelody(mono, sampleRate, { sensitivity }), startSec) };
    case 'bass':
      return { kind: 'notes', mode: 'bass', notes: shiftNotes(detectBass(mono, sampleRate, { sensitivity }), startSec) };
    case 'drums': {
      const drums = detectDrums(mono, sampleRate, { sensitivity });
      return {
        kind: 'drums',
        hits: drums.hits.map((hit) => ({ ...hit, timeSec: hit.timeSec + startSec })),
        cuts: drums.cuts.map((cut) => ({ ...cut, fromSec: cut.fromSec + startSec, toSec: cut.toSec + startSec })),
      };
    }
    case 'chords':
      return { kind: 'chroma', chromagram: detectChroma(mono, sampleRate), startSec };
  }
}

/** Heard notes moved to the recording's own timeline. */
function shiftNotes(notes: readonly HeardNote[], startSec: number): HeardNote[] {
  return startSec === 0 ? [...notes] : notes.map((n) => ({ ...n, fromSec: n.fromSec + startSec, toSec: n.toSec + startSec }));
}
