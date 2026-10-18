/**
 * Reading a file for the sample analysis (Worker-safe: no DOM, only Blob). WAV and AIFF are parsed here (`decodePcm`), and
 * only as much of a big file as the analysis reads (the first 32 s); FLAC is decoded by `core/io/flac`; other formats (MP3, OGG,
 * M4A, odd WAVs) need the browser's decoder, which Workers don't have, so they come back as "needs-decode" and the main thread
 * decodes them.
 */
import { readAudioInfo } from '@core/io/audio-info';
import { decodeFlac } from '@core/io/flac';
import { decodePcm } from '@core/io/wav';
import { LONG_SEC, LOOP_ANALYSIS_SEC } from '@core/samples/analyze';

/** Files up to this size are read whole (the header says little for compressed formats). */
const WHOLE_FILE_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

export type FileRead =
  | { kind: 'audio'; channels: Float32Array[]; sampleRate: number; durationSec: number }
  | { kind: 'long'; durationSec: number }
  | { kind: 'needs-decode'; durationSec: number | null }
  | { kind: 'unreadable' };

export async function readForAnalysis(file: Blob): Promise<FileRead> {
  if (file.size < 44) return { kind: 'unreadable' };
  let bytes = new Uint8Array(await file.slice(0, Math.min(file.size, file.size <= WHOLE_FILE_BYTES ? file.size : HEAD_BYTES)).arrayBuffer());
  const info = readAudioInfo(bytes);
  const pcm = info ? info.format === 'wav' || info.format === 'aiff' : false;
  if (file.size > WHOLE_FILE_BYTES) {
    // A big file: a PCM file's header says its length and we read the part we need; anything else that big is a song.
    if (!info || !pcm) return { kind: 'long', durationSec: info?.durationSec ?? 0 };
    if (info.durationSec > LONG_SEC) return { kind: 'long', durationSec: info.durationSec };
    const perSec = file.size / Math.max(0.001, info.durationSec);
    const need = Math.min(file.size, Math.ceil(Math.min(info.durationSec, LOOP_ANALYSIS_SEC + 1) * perSec) + 8192);
    bytes = new Uint8Array(await file.slice(0, need).arrayBuffer());
  } else if (info && info.durationSec > LONG_SEC) {
    return { kind: 'long', durationSec: info.durationSec };
  }
  const decoded = decodePcm(bytes);
  if (decoded && decoded.channels[0] && decoded.channels[0].length > 0) {
    const frames = decoded.channels[0].length;
    // The file's own length (the header's) when only the start was read.
    const durationSec = info && info.durationSec > 0 ? info.durationSec : frames / decoded.sampleRate;
    return { kind: 'audio', channels: decoded.channels.slice(0, 2), sampleRate: decoded.sampleRate, durationSec };
  }
  // FLAC is read here too (the browser decodes it off the main thread, but a Worker cannot ask it).
  if (info?.format === 'flac') {
    try {
      const flac = decodeFlac(bytes);
      const scale = 1 / Math.pow(2, flac.bitDepth - 1);
      const channels = flac.channels.slice(0, 2).map((c) => Float32Array.from(c, (v) => v * scale));
      if (channels[0] && channels[0].length > 0) return { kind: 'audio', channels, sampleRate: flac.sampleRate, durationSec: info.durationSec };
    } catch {
      /* the browser may still read it */
    }
  }
  if (info && info.durationSec > LONG_SEC) return { kind: 'long', durationSec: info.durationSec };
  return { kind: 'needs-decode', durationSec: info?.durationSec ?? null };
}
