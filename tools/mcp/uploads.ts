import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Exports for AI apps: no file picker is needed because this server writes the file. The page renders
 * the audio and sends the bytes here, under a one-time ticket that exists only while an authenticated
 * `export_audio` or `export_video` call is running, into one folder (default `~/Music/AGstudio/`). Names are cleaned
 * and only audio and video extensions are written, never over an existing file.
 */
export const defaultExportsDir = (): string => join(homedir(), 'Music', 'AGstudio');

const EXTENSIONS = new Set(['.wav', '.flac', '.mp3', '.zip', '.mp4', '.webm']);
const MAX_BYTES = 4 * 1024 ** 3;

/** One path segment that is safe to create: no separators, no control characters, not hidden. */
export function cleanName(raw: string, fallback: string): string {
  const s = basename(raw.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return s || fallback;
}

export class UploadTickets {
  private readonly open = new Set<string>();

  issue(): string {
    const t = randomBytes(24).toString('base64url');
    this.open.add(t);
    return t;
  }

  revoke(ticket: string | undefined): void {
    if (ticket) this.open.delete(ticket);
  }

  valid(ticket: string): boolean {
    return this.open.has(ticket);
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** A path in `dir` that doesn't exist yet: "Song.wav", then "Song (2).wav"… */
async function freePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!(await exists(p))) return p;
  }
  throw new Error('Too many files with that name.');
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Writes the request body as `name` (inside `folder`, when given) under `root`; returns the final path. */
export async function saveUpload(root: string, body: Readable, name: string, folder?: string): Promise<string> {
  const file = cleanName(name, 'export.wav');
  if (!EXTENSIONS.has(extname(file).toLowerCase()))
    throw new UploadError('Only .wav, .flac, .mp3 and .zip files are written.', 400);
  const dir = folder ? join(root, cleanName(folder, 'stems')) : root;
  await mkdir(dir, { recursive: true });
  const target = await freePath(dir, file);
  const temp = `${target}.part`;
  let size = 0;
  body.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BYTES) body.destroy(new UploadError('That file is too large.', 413));
  });
  try {
    await pipeline(body, createWriteStream(temp, { flags: 'wx', mode: 0o644 }));
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
  return target;
}
