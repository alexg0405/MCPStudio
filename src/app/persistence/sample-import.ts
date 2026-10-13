import { sha256Hex } from '@core/io/hash';
import { normalizeSampleExt } from '@core/io/project-file';
import { newId } from '@core/model/ids';
import type { SampleRef } from '@core/model/types';
import type { BlobStore } from '@platform/opfs';
import { defaultSampleStore } from './blob-store';

const MAX_NAME_LENGTH = 128;

/** Guesses an audio file's extension from its first bytes (for names without one). */
export function sniffAudioExt(bytes: Uint8Array): string | null {
  const tag = (o: number) =>
    String.fromCharCode(bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0, bytes[o + 3] ?? 0);
  if (bytes.length < 4) return null;
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') return 'wav';
  if (tag(0) === 'FORM' && tag(8) === 'AIFF') return 'aiff';
  if (tag(0) === 'FORM' && tag(8) === 'AIFC') return 'aifc';
  if (tag(0) === 'fLaC') return 'flac';
  if (tag(0) === 'OggS') return 'ogg';
  if (tag(4) === 'ftyp') return 'm4a';
  if (tag(0).startsWith('ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/**
 * Stores an audio file in the sample store (once per content hash) and returns a new SampleRef for
 * it. `fileName` may include a folder path; the sample is named after the file without extension.
 */
export async function importSampleBytes(
  bytes: Uint8Array,
  fileName: string,
  opts: { store?: BlobStore } = {},
): Promise<SampleRef> {
  const hash = await sha256Hex(bytes);
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const ext = (dot > 0 ? normalizeSampleExt(base.slice(dot + 1)) : null) ?? sniffAudioExt(bytes) ?? 'bin';
  const name = (dot > 0 ? base.slice(0, dot) : base).trim().slice(0, MAX_NAME_LENGTH) || 'Sample';
  const store = opts.store ?? defaultSampleStore();
  if (!(await store.hasBlob(hash, ext))) await store.putBlob(hash, ext, bytes);
  return { id: newId.sample(), name, source: { kind: 'embedded', hash, ext, originalName: base } };
}
