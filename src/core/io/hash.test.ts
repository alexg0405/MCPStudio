import { describe, expect, it } from 'vitest';
import { isSha256Hex, sha256Hex } from './hash';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vectors', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(ascii('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes only the view, and accepts SharedArrayBuffer memory', async () => {
    const big = ascii('xxabcxx');
    expect(await sha256Hex(big.subarray(2, 5))).toBe(await sha256Hex(ascii('abc')));
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set(ascii('abc'));
    expect(await sha256Hex(shared)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('recognizes hash strings', async () => {
    expect(isSha256Hex(await sha256Hex(ascii('x')))).toBe(true);
    expect(isSha256Hex('ABC')).toBe(false);
    expect(isSha256Hex('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85')).toBe(false);
    expect(isSha256Hex('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855')).toBe(false);
    expect(isSha256Hex(42)).toBe(false);
  });
});
