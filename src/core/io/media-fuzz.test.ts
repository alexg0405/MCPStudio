import { describe, expect, it } from 'vitest';
import { readTags } from '../dj/tags';
import { readAudioInfo } from './audio-info';
import { encodeFlac } from './flac';
import { decodePcm, encodeWav } from './wav';

/** Files from the musician's disk may be cut off or damaged: the readers return nothing, never throw. */

const tone = Float32Array.from({ length: 4000 }, (_, i) => 0.4 * Math.sin(i * 0.05));
const seeds: Record<string, Uint8Array> = {
  wav: encodeWav([tone, tone], 44100, { bitDepth: 16 }),
  wav24: encodeWav([tone], 48000, { bitDepth: 24 }),
  flac: encodeFlac([tone, tone], 44100, { bitDepth: 16 }),
  id3: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 30, 0x54, 0x49, 0x54, 0x32, 0, 0, 0, 8, 0, 0, 3, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0, 0xff, 0xfb, 0x90, 0, ...new Array(400).fill(0x55)]),
};

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

describe('media readers on damaged files', () => {
  it.each(Object.entries(seeds))('%s: cut at any length and with flipped bytes never throws', (name, bytes) => {
    const r = rnd(name.length * 7919);
    const bad: string[] = [];
    const check = (b: Uint8Array, what: string) => {
      for (const [fn, f] of [
        ['readAudioInfo', readAudioInfo],
        ['readTags', readTags],
        ['decodePcm', decodePcm],
      ] as const) {
        try {
          f(b);
        } catch (e) {
          bad.push(`${name} ${what} ${fn}: ${(e as Error).message}`);
        }
      }
    };
    for (let n = 0; n < Math.min(bytes.length, 300); n += 1) check(bytes.subarray(0, n), `cut ${n}`);
    for (let k = 0; k < 200; k++) {
      const copy = bytes.slice();
      for (let j = 0; j < 1 + Math.floor(r() * 6); j++) copy[Math.floor(r() * Math.min(copy.length, 400))]! ^= 1 << Math.floor(r() * 8);
      check(copy, `flip ${k}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
