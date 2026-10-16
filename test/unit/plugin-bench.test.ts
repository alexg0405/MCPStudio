/**
 * CPU benchmark of every built-in worklet kernel, in Node at 48 kHz. Opt-in (it takes a minute and
 * its numbers depend on the machine):
 *
 *   VITE_AG_BENCH=1 npx vitest run --project unit --disableConsoleIntercept test/unit/plugin-bench.test.ts
 *
 * Effects run a stereo music-like loop (decaying chords, noise bursts) through their default
 * settings and through every preset; instruments hold an 8-note chord and retrigger it every half
 * second. The table lists the default and the worst preset as % of one core (render time divided by
 * audio time). VITE_AG_BENCH_ONLY=chorus,reverb limits it to plugins whose id contains one of them.
 */
import { describe, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import { paramBlock, testHost, testTransport } from '@agstudio/sdk/testing';
import type { EffectKernel, InstrumentKernel, ParamBlock } from '@agstudio/sdk/worklet';
import { KERNEL_ENTRIES, type EffectEntry, type InstrumentEntry } from '../helpers/builtin-kernels';

declare const process: { cpuUsage(): { user: number; system: number } };
/** CPU time in ms: steadier than wall time while other programs share the machine. */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const SR = 48000;
const BLOCK = 128;
const SECONDS = 4;
const FRAMES = SR * SECONDS;
const REPS = 5;

const enabled = import.meta.env.VITE_AG_BENCH === '1';
const only = String(import.meta.env.VITE_AG_BENCH_ONLY ?? '')
  .split(',')
  .filter(Boolean);

/** Stereo test music: a chord that restarts every half second and decays, plus a noise hit on the beat. */
function makeInput(): [Float32Array, Float32Array] {
  const L = new Float32Array(FRAMES);
  const R = new Float32Array(FRAMES);
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const freqs = [110, 165, 220, 277.2, 330, 440];
  for (let i = 0; i < FRAMES; i++) {
    const t = (i % (SR / 2)) / SR;
    const env = Math.exp(-t * 6);
    let x = 0;
    for (let f = 0; f < freqs.length; f++) x += Math.sin(2 * Math.PI * (freqs[f] as number) * (i / SR)) * 0.08;
    const hit = t < 0.05 ? rnd() * 0.5 * (1 - t / 0.05) : 0;
    L[i] = x * env + hit;
    R[i] = x * env * 0.9 + (t < 0.05 ? rnd() * 0.5 * (1 - t / 0.05) : 0);
  }
  return [L, R];
}

function makeKey(): [Float32Array, Float32Array] {
  const L = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const t = (i % (SR / 2)) / SR;
    L[i] = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 18) * 0.9;
  }
  return [L, L];
}

const INPUT = enabled ? makeInput() : null;
const KEY = enabled ? makeKey() : null;

function timeEffect(entry: EffectEntry, values: Record<string, ParamValue>): number {
  const input = INPUT as [Float32Array, Float32Array];
  const key = KEY as [Float32Array, Float32Array];
  const kernel: EffectKernel = entry.make(SR);
  const transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  kernel.transport = transport;
  const params = paramBlock(entry.params, values) as ParamBlock;
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const scL = new Float32Array(BLOCK);
  const scR = new Float32Array(BLOCK);
  const t0 = cpuMs();
  for (let at = 0; at < FRAMES; at += BLOCK) {
    transport.blockStart = at;
    const o = [outL, outR];
    const i = [input[0].subarray(at, at + BLOCK), input[1].subarray(at, at + BLOCK)];
    if (entry.sidechain) {
      scL.set(key[0].subarray(at, at + BLOCK));
      scR.set(key[1].subarray(at, at + BLOCK));
      kernel.process(i, o, BLOCK, params, [scL, scR]);
    } else kernel.process(i, o, BLOCK, params);
  }
  return cpuMs() - t0;
}

function timeInstrument(entry: InstrumentEntry, values: Record<string, ParamValue>): number {
  const kernel: InstrumentKernel = entry.make(SR);
  const transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  kernel.transport = transport;
  const params = paramBlock(entry.params, values) as ParamBlock;
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  const half = SR / 2;
  let id = 1;
  const t0 = cpuMs();
  for (let at = 0; at < FRAMES; at += BLOCK) {
    transport.blockStart = at;
    // Notes start at a block boundary every half second and are released a little before the next.
    if (at % half < BLOCK) {
      for (const k of entry.keys) kernel.noteOn(k, 0.8, id++, 0, 0);
    } else if (at % half >= half - 2 * BLOCK && at % half < half - BLOCK) {
      for (let n = id - entry.keys.length; n < id; n++) kernel.noteOff(n, entry.keys[n - (id - entry.keys.length)] as number, 0.5);
    }
    L.fill(0);
    R.fill(0);
    kernel.render([L, R], 0, BLOCK, params);
  }
  return cpuMs() - t0;
}

/** Best of REPS after a warm-up run, as % of one core. */
function percent(run: () => number): number {
  run();
  let best = Infinity;
  for (let r = 0; r < REPS; r++) best = Math.min(best, run());
  return (best / (SECONDS * 1000)) * 100;
}

describe.skipIf(!enabled)('plugin CPU benchmark (opt-in)', () => {
  it('measures every worklet plugin', { timeout: 600_000 }, () => {
    const rows: { id: string; kind: string; def: number; worst: number; worstName: string }[] = [];
    for (const entry of KERNEL_ENTRIES) {
      if (only.length && !only.some((o) => entry.id.includes(o))) continue;
      const run = (v: Record<string, ParamValue>) =>
        entry.kind === 'effect' ? () => timeEffect(entry, v) : () => timeInstrument(entry, v);
      const def = percent(run({}));
      let worst = def;
      let worstName = 'default';
      for (const preset of entry.presets) {
        const c = percent(run(preset.params));
        if (c > worst) {
          worst = c;
          worstName = preset.name;
        }
      }
      rows.push({ id: entry.id.replace('agstudio.', ''), kind: entry.kind, def, worst, worstName });
    }
    rows.sort((a, b) => b.worst - a.worst);
    const lines = rows.map(
      (r) =>
        `${r.id.padEnd(14)} ${r.kind.padEnd(10)} default ${r.def.toFixed(2).padStart(6)} %   worst ${r.worst
          .toFixed(2)
          .padStart(6)} %  (${r.worstName})`,
    );
    console.log(`\nCPU, % of one core at ${SR} Hz (${SECONDS} s, best of ${REPS})\n${lines.join('\n')}\n`);
    void testHost;
  });
});
