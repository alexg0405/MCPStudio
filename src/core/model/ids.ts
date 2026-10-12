import type { ChannelId, ClipId, InsertId, LaneId, NoteId, PatternId, SampleId, SlotId } from './types';

/**
 * Ids are a short prefix plus 10 random base64url characters (60 bits). The random source is
 * injectable so tests (and fixtures) can be deterministic.
 */
export type RandomBytes = (n: number) => Uint8Array;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T } | undefined;

const cryptoBytes: RandomBytes = (n) => {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== 'undefined') return crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

/** Deterministic byte source for tests (mulberry32). */
export function seededBytes(seed: number): RandomBytes {
  let a = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
    }
    return out;
  };
}

let source: RandomBytes = cryptoBytes;

/** Replaces the random source (tests); returns the previous one. */
export function setIdSource(next: RandomBytes): RandomBytes {
  const prev = source;
  source = next;
  return prev;
}

export function randomId(prefix: string): string {
  const bytes = source(10);
  let s = prefix + '_';
  for (let i = 0; i < 10; i++) s += ALPHABET[(bytes[i] ?? 0) & 63];
  return s;
}

export const newId = {
  channel: () => randomId('ch') as ChannelId,
  pattern: () => randomId('pat') as PatternId,
  note: () => randomId('n') as NoteId,
  lane: () => randomId('lane') as LaneId,
  clip: () => randomId('clip') as ClipId,
  insert: () => randomId('ins') as InsertId,
  slot: () => randomId('fx') as SlotId,
  sample: () => randomId('smp') as SampleId,
  project: () => randomId('prj'),
};
