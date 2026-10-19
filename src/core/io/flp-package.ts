/**
 * FL Studio's "zipped loop package" (File > Export > Zipped loop package): a .zip holding the .flp
 * and the audio it uses, in folders. This reads the project and indexes the audio by file name so
 * the importer can match each channel's sample path (an absolute path on the machine that saved it).
 */
import { unzipSync } from 'fflate';
import { FlpError, flpFileName } from './flp';

/** Audio formats a package may carry (what the app can decode, plus FL's own). */
const AUDIO = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|opus|m4a)$/i;
const MAX_ENTRY = 512 * 1024 * 1024;
const MAX_TOTAL = 1536 * 1024 * 1024;

/** One audio file of an FL zipped loop package: its path inside the zip and its bytes. */
export interface FlpPackageFile {
  /** Path inside the zip. */
  path: string;
  bytes: Uint8Array;
}

/** An opened FL zipped loop package: the .flp (name and bytes) and the audio files that came with it. */
export interface FlpPackage {
  /** The .flp's name inside the zip (without folders). */
  flpName: string;
  flp: Uint8Array;
  audio: FlpPackageFile[];
}

/** True for the bytes of a zip archive (local file header or an empty archive's directory end). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

/** Whether a zip holds an FL Studio project (reads only the file names). */
export function zipHasFlp(bytes: Uint8Array): boolean {
  if (!isZip(bytes)) return false;
  let found = false;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (/\.flp$/i.test(f.name)) found = true;
        return false;
      },
    });
  } catch {
    return false;
  }
  return found;
}

/** Every audio file of a zip (no project needed): for finding missing samples in any zip. */
export function readZipAudio(bytes: Uint8Array): FlpPackageFile[] {
  return unzip(bytes, false).audio;
}

/** Reads a zipped loop package. Throws FlpError when it isn't a zip or has no .flp in it. */
export function readFlpPackage(bytes: Uint8Array): FlpPackage {
  const { flps, audio } = unzip(bytes, true);
  // The project at the top of the zip wins over ones in folders (backups, "Old" folders).
  flps.sort((a, b) => a.path.split('/').length - b.path.split('/').length || b.bytes.length - a.bytes.length);
  const flp = flps[0];
  if (!flp) throw new FlpError('This zip has no FL Studio project (.flp) in it.');
  return { flpName: flpFileName(flp.path), flp: flp.bytes, audio };
}

function unzip(bytes: Uint8Array, wantFlp: boolean): { flps: FlpPackageFile[]; audio: FlpPackageFile[] } {
  if (!isZip(bytes)) throw new FlpError("This isn't a zip file.");
  let total = 0;
  let tooBig = false;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        const name = f.name.replace(/\\/g, '/');
        if (name.endsWith('/') || name.split('/').some((part) => part.startsWith('__MACOSX') || part.startsWith('._')))
          return false;
        const isFlp = wantFlp && /\.flp$/i.test(name);
        if (!isFlp && !AUDIO.test(name)) return false;
        if (f.originalSize > MAX_ENTRY || total + f.originalSize > MAX_TOTAL) {
          tooBig = true;
          return false;
        }
        total += f.originalSize;
        return true;
      },
    });
  } catch (e) {
    throw new FlpError(`The zip file is damaged and couldn't be read${e instanceof Error ? ` (${e.message})` : ''}.`);
  }
  if (tooBig && Object.keys(entries).length === 0) throw new FlpError('The zip file is too large to import.');
  const flps: FlpPackageFile[] = [];
  const audio: FlpPackageFile[] = [];
  for (const [path, data] of Object.entries(entries)) {
    const p = path.replace(/\\/g, '/');
    if (wantFlp && /\.flp$/i.test(p)) flps.push({ path: p, bytes: data });
    else audio.push({ path: p, bytes: data });
  }
  return { flps, audio };
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * Finds the file for an FL sample path among `files`: the same file name (case-insensitive), else
 * the same name with another audio extension (FL may convert when packing).
 */
export function matchSampleFile<F extends { path: string }>(samplePath: string, files: readonly F[]): F | undefined {
  const want = flpFileName(samplePath).toLowerCase();
  if (!want) return undefined;
  const byName = files.find((f) => flpFileName(f.path).toLowerCase() === want);
  if (byName) return byName;
  const wantStem = stem(want);
  return files.find((f) => stem(flpFileName(f.path).toLowerCase()) === wantStem);
}
