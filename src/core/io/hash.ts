/**
 * SHA-256 content hashes (sample blob names, autosave integrity) through Web Crypto, which exists in
 * browsers (secure contexts only: https or localhost) and in Node ≥ 19. Core has no DOM lib, so the
 * small slice of the API used here is declared locally.
 */
import { unsharedBytes } from './bytes';

interface SubtleDigest {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True for a lowercase 64-character hex string (what sha256Hex returns). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function subtle(): SubtleDigest {
  const c = (globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto;
  if (!c?.subtle) {
    throw new Error('Hashing needs Web Crypto (crypto.subtle), which is only available on https or localhost.');
  }
  return c.subtle;
}

/** Lowercase hex SHA-256 of `bytes` (only the view's own range is hashed). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Web Crypto rejects views of SharedArrayBuffer memory (the app is cross-origin isolated).
  const digest = new Uint8Array(await subtle().digest('SHA-256', unsharedBytes(bytes)));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += HEX[digest[i] as number];
  return hex;
}
