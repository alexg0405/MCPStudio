/**
 * Golden output of the Wavetable's factory sounds: the default patch and every preset, played with a scripted
 * phrase (a held low note, a chord entering one note at a time, a very high note that leans on the top mip
 * levels, then a release), recorded before the user-table support was added. The user-table work changed
 * the kernel's frame lookup, so this holds every existing sound to its old output: every 256th left sample
 * and the RMS of each 1024-frame chunk of both channels, within 0.002 and 0.05 dB.
 *
 * To regenerate on purpose: `WAVETABLE_GOLDEN_RECORD=1 npx vitest run src/plugins/builtin/wavetable/golden.test.ts`
 * rewrites `golden.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import {
  bitHash,
  chunkRms,
  paramBlock,
  renderInstrument,
  rmsDb,
  strided,
  testHost,
  testTransport,
} from '@agstudio/sdk/testing';
import wavetable from './index';
import { WavetableKernel } from './kernel';
import { wavetableParams } from './params';
import { factoryBank } from './tables';

const SR = 48000;
const FRAMES = 72000;
const FILE = new URL('./golden.json', import.meta.url);
const RECORD = process.env.WAVETABLE_GOLDEN_RECORD === '1';

/** [seconds, key, held seconds]. */
const SCRIPT: readonly [number, number, number][] = [
  [0, 45, 0.9],
  [0.1, 60, 0.7],
  [0.2, 64, 0.6],
  [0.3, 67, 0.5],
  [0.5, 96, 0.2],
  [0.8, 52, 0.15],
];

interface Snapshot {
  left: number[];
  rmsL: number[];
  rmsR: number[];
  hash: string;
}

const round = (x: number) => Math.round(x * 1e5) / 1e5;

function render(values: Record<string, ParamValue>): Snapshot {
  const k = new WavetableKernel(testHost(SR, 3));
  k.useBank(factoryBank());
  k.transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  const events = SCRIPT.flatMap(([sec, key, held], i) => [
    { frame: Math.round(sec * SR), run: () => k.noteOn(key, 0.8, i + 1, 0, 0) },
    { frame: Math.round((sec + held) * SR), run: () => k.noteOff(i + 1, key, 0.5) },
  ]);
  const [l, r] = renderInstrument(k, FRAMES, paramBlock(wavetableParams, values), events);
  return {
    left: strided(l as Float32Array, 256).map(round),
    rmsL: chunkRms(l as Float32Array).map(round),
    rmsR: chunkRms(r as Float32Array).map(round),
    hash: bitHash(l as Float32Array),
  };
}

const SOUNDS: readonly { name: string; params: Record<string, ParamValue> }[] = [
  { name: 'default', params: {} },
  ...(wavetable.presets ?? []).map((p) => ({ name: p.name, params: (p.params ?? {}) as Record<string, ParamValue> })),
];

describe('Wavetable golden output (factory sounds)', () => {
  if (RECORD) {
    it('records', () => {
      const out: Record<string, Snapshot> = {};
      for (const s of SOUNDS) out[s.name] = render(s.params);
      writeFileSync(FILE, JSON.stringify(out) + '\n');
    });
    return;
  }
  const golden = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Snapshot>;

  it('covers every preset', () => {
    expect(Object.keys(golden).sort()).toEqual(SOUNDS.map((s) => s.name).sort());
  });

  it.each(SOUNDS.map((s) => [s.name, s] as const))('%s sounds as it did', (name, sound) => {
    const want = golden[name] as Snapshot;
    const got = render(sound.params);
    expect(got.left.length).toBe(want.left.length);
    let worst = 0;
    got.left.forEach((x, i) => (worst = Math.max(worst, Math.abs(x - (want.left[i] as number)))));
    expect(worst, 'left samples').toBeLessThan(0.002);
    for (const [a, b] of [
      [got.rmsL, want.rmsL],
      [got.rmsR, want.rmsR],
    ] as const)
      a.forEach((x, i) => expect(Math.abs(rmsDb(x, b[i] as number)), `chunk ${i}`).toBeLessThan(0.05));
    // Bit-exact on the machine that recorded it; other machines' maths libraries may differ in the last bits.
    if (process.env.WAVETABLE_GOLDEN_EXACT === '1') expect(got.hash).toBe(want.hash);
  });
});
