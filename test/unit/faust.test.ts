/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { faustControls, type FaustMeta } from '@agstudio/sdk/faust/params';
import { decodeBase64 } from '@agstudio/sdk/faust/kernel';
import { compileFaust, faustErrorText, hasGate } from '../../tools/faust/compile.ts';

const template = (path: string) => readFile(join(process.cwd(), 'templates', path), 'utf8');

/** The Faust pipeline on the Node side: compile, describe, map controls to params. */
describe('Faust', () => {
  it('compiles an effect and turns its controls into params with labels, units and scales', async () => {
    const c = await compileFaust('Filter', await template('effect-faust/effect.dsp'));
    expect(c.wasm.length).toBeGreaterThan(500);
    expect(c.hash).toMatch(/^[0-9a-f]{12}$/);
    const meta = c.meta as unknown as FaustMeta;
    expect([meta.inputs, meta.outputs]).toEqual([2, 2]);
    expect(hasGate(meta.ui)).toBe(false);
    const { params, controls } = faustControls(meta, 'effect');
    expect(Object.keys(params)).toEqual(['cutoff', 'resonance', 'mix']);
    expect(params.cutoff).toMatchObject({ type: 'float', min: 40, max: 18000, default: 2000, unit: 'Hz', scale: 'log' });
    expect(params.cutoff?.label).toBe('Cutoff');
    expect(params.cutoff?.hint).toBe('Frequencies above this are cut');
    expect(controls.every((x) => Number.isInteger(x.index) && x.index >= 0)).toBe(true);
    // The same source compiles once.
    expect(await compileFaust('Filter', await template('effect-faust/effect.dsp'))).toBe(c);
  });

  it('sets an instrument’s voice controls apart from its knobs', async () => {
    const c = await compileFaust('Voice', await template('instrument-faust/voice.dsp'));
    const meta = c.meta as unknown as FaustMeta;
    expect(hasGate(meta.ui)).toBe(true);
    expect(meta.outputs).toBe(1);
    const { params, voice } = faustControls(meta, 'instrument');
    expect(Object.keys(params)).toEqual(['cutoff', 'attack', 'release']);
    expect(params.attack).toMatchObject({ unit: 's' });
    for (const k of ['freq', 'gain', 'gate'] as const) expect(voice[k]).toBeGreaterThanOrEqual(0);
  });

  it('reports compile errors by line, without the compiler’s internal noise', async () => {
    await expect(compileFaust('Broken', 'import("stdfaust.lib");\nprocess = nope;')).rejects.toThrow(
      /^line 2: undefined symbol : nope/,
    );
    expect(faustErrorText('Aborted(Assertion failed)\nX:4 : ERROR : oops', 'X')).toBe('line 4: oops');
  });

  it('decodes base64 without atob (the AudioWorklet scope has none)', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    expect([...decodeBase64(Buffer.from(bytes).toString('base64'))]).toEqual([...bytes]);
  });
});
