// Reading an audio file for the table editor: a WAV through the SDK's own reader, anything else (MP3, FLAC, OGG, AIFF…)
// through the browser's decoder. The editor only: this file touches the DOM.
import {
  decodeWav,
  framesFromCycles,
  framesFromSlices,
  mixToMono,
  type Frame,
} from '@agstudio/sdk/dsp/wavetable-frames';

/** An audio file as one channel, and the cycle length it announces (0 when it says nothing). */
export interface TableAudio {
  samples: Float32Array;
  cycleLength: number;
  name: string;
}

/** Reads a file for a table; null when it is not audio the browser can read. */
export async function readTableAudio(file: File): Promise<TableAudio | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const wav = decodeWav(bytes);
  if (wav) return { samples: mixToMono(wav.channels), cycleLength: wav.cycleLength, name: file.name };
  try {
    // A throwaway one-frame context: decoding needs no sound card and no user gesture.
    const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.buffer.slice(0));
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    return { samples: mixToMono(channels), cycleLength: 0, name: file.name };
  } catch {
    return null;
  }
}

/** Samples in one cycle when a file has no cycle-size chunk: a short file is one cycle, a multiple of 2048 a table. */
const COMMON_CYCLE = 2048;
const LONGEST_SINGLE_CYCLE = 8192;

/** How many samples to read as one cycle of this file. */
export function cycleLengthOf(audio: TableAudio): number {
  if (audio.cycleLength >= 4) return audio.cycleLength;
  const n = audio.samples.length;
  if (n <= LONGEST_SINGLE_CYCLE || n % COMMON_CYCLE !== 0) return n;
  return COMMON_CYCLE;
}

/** How the editor turns a file into frames: its cycles (a single-cycle file or a table of them) or equal slices of it. */
export type ImportMode = { kind: 'cycles' } | { kind: 'slices'; count: number };

/** The key frames of a file under an import mode (at most 32). */
export function framesFromAudio(audio: TableAudio, mode: ImportMode): Frame[] {
  if (mode.kind === 'slices') return framesFromSlices(audio.samples, mode.count);
  return framesFromCycles(audio.samples, cycleLengthOf(audio));
}
