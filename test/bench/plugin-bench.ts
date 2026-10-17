/**
 * CPU benchmark of every built-in worklet kernel at 48 kHz, as % of one core (CPU time of the
 * render divided by the audio's duration). Run it through `npm run bench:plugins`: that bundles this
 * file the way production bundles the worklets (rolldown, no test-runner module wrappers, which add
 * a property lookup to every call across modules and so overstate small helpers) and runs it in Node.
 *
 * Effects run a stereo music-like loop through their default settings and every preset; instruments
 * hold an 8-note chord and retrigger it every half second. The table lists the default and the worst
 * preset. Options: `--only chorus,reverb` (ids containing any), `--preset text` (only presets whose
 * name contains it), `--reps 5`, `--seconds 4`, `--json` (one JSON array instead of the table).
 *
 * `--automate` measures the default settings again with up to 3 automatable float params (the first
 * ones in declaration order) swept by a slow sine across their whole range, so each param changes on
 * every frame, the way automation in a song does. It prints the steady and automated % side by side
 * with their ratio, sorted by ratio. Presets are not used in that mode.
 *
 * `--chains` measures each factory vocal chain (src/app/mix/vocal-chains.ts): its worklet effects run one after the
 * other on the music loop, with the chain's presets and settings, as % of one core, with each effect's share. The
 * Reverb and Delay are native Web Audio nodes (no kernel): they are left out of the sum and named; a send to a
 * return costs nothing on the track itself.
 */
import type { FloatSpec, ParamSpecs, ParamValue } from '@agstudio/sdk';
import { fromNormalized, isAutomatable } from '@agstudio/sdk';
import { paramBlock, testTransport } from '@agstudio/sdk/testing';
import type { EffectKernel, InstrumentKernel, ParamBlock } from '@agstudio/sdk/worklet';
import { FACTORY_CHAINS } from '../../src/app/mix/vocal-chains';
import { KERNEL_ENTRIES, type EffectEntry, type InstrumentEntry, type KernelEntry } from '../helpers/builtin-kernels';
import { keyInput, musicInput } from '../helpers/kernel-run';

declare const process: {
  argv: string[];
  cpuUsage(): { user: number; system: number };
  stdout: { write(s: string): void };
};

const SR = 48000;
const BLOCK = 128;

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const SECONDS = Number(option('seconds', '4'));
const REPS = Number(option('reps', '5'));
const ONLY = option('only', '').split(',').filter(Boolean);
const PRESET = option('preset', '');
const JSON_OUT = args.includes('--json');
const AUTOMATE = args.includes('--automate');
const CHAINS = args.includes('--chains');
const FRAMES = SR * SECONDS;

/** Automated mode: at most this many float params are swept, one sine cycle every 4 s (a slow sweep). */
const MAX_SWEPT = 3;
const SWEEP_HZ = 0.25;

/** Settles the garbage collector before a timed run (its helper threads would count as CPU time). */
const settle = () => (globalThis as { gc?: () => void }).gc?.();

/** CPU time in ms: steadier than wall time while other programs share the machine. */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const INPUT = musicInput(FRAMES);
const KEY = keyInput(FRAMES);

/** `blocks` (automated mode) gives one param block per 128-frame block; otherwise `values` is constant. */
function timeEffect(entry: EffectEntry, values: Record<string, ParamValue>, blocks?: ParamBlock[]): number {
  const kernel: EffectKernel = entry.make(SR);
  const transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  kernel.transport = transport;
  const constant = blocks ? undefined : (paramBlock(entry.params, values) as ParamBlock);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const scL = new Float32Array(BLOCK);
  const scR = new Float32Array(BLOCK);
  settle();
  const t0 = cpuMs();
  for (let at = 0; at < FRAMES; at += BLOCK) {
    transport.blockStart = at;
    const params = constant ?? (blocks as ParamBlock[])[at / BLOCK];
    const i = [INPUT[0].subarray(at, at + BLOCK), INPUT[1].subarray(at, at + BLOCK)];
    if (entry.sidechain) {
      scL.set(KEY[0].subarray(at, at + BLOCK));
      scR.set(KEY[1].subarray(at, at + BLOCK));
      kernel.process(i, [outL, outR], BLOCK, params as ParamBlock, [scL, scR]);
    } else kernel.process(i, [outL, outR], BLOCK, params as ParamBlock);
  }
  return cpuMs() - t0;
}

/** `blocks` (automated mode) gives one param block per 128-frame block; otherwise `values` is constant. */
function timeInstrument(entry: InstrumentEntry, values: Record<string, ParamValue>, blocks?: ParamBlock[]): number {
  const kernel: InstrumentKernel = entry.make(SR);
  const transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  kernel.transport = transport;
  const constant = blocks ? undefined : (paramBlock(entry.params, values) as ParamBlock);
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  const half = SR / 2;
  let id = 1;
  settle();
  const t0 = cpuMs();
  for (let at = 0; at < FRAMES; at += BLOCK) {
    transport.blockStart = at;
    // Notes start at a block boundary every half second and are released a little before the next.
    if (at % half < BLOCK) {
      for (const k of entry.keys) kernel.noteOn(k, 0.8, id++, 0, 0);
    } else if (at % half >= half - 2 * BLOCK && at % half < half - BLOCK) {
      const first = id - entry.keys.length;
      for (let n = first; n < id; n++) kernel.noteOff(n, entry.keys[n - first] as number, 0.5);
    }
    L.fill(0);
    R.fill(0);
    const params = constant ?? (blocks as ParamBlock[])[at / BLOCK];
    kernel.render([L, R], 0, BLOCK, params as ParamBlock);
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

/** The first automatable float params, in declaration order (at most MAX_SWEPT). */
function sweptParams(specs: ParamSpecs): { key: string; spec: FloatSpec }[] {
  const out: { key: string; spec: FloatSpec }[] = [];
  for (const [key, spec] of Object.entries(specs)) {
    if (out.length >= MAX_SWEPT) break;
    if (spec.type === 'float' && isAutomatable(spec)) out.push({ key, spec });
  }
  return out;
}

/**
 * One param block per 128-frame block, built before timing starts: the constant params of `values`,
 * and each swept param as a per-frame array of a slow sine across its range (in the normalized
 * domain, so log and dB ranges are swept evenly to the ear). Phases are spread so the sweeps differ.
 */
function automatedBlocks(
  entry: KernelEntry,
  values: Record<string, ParamValue>,
  swept: { key: string; spec: FloatSpec }[],
): ParamBlock[] {
  const blockCount = Math.ceil(FRAMES / BLOCK);
  const base = paramBlock(entry.params, values) as unknown as Record<string, Float32Array>;
  const curves = swept.map((s, k) => {
    const curve = new Float32Array(blockCount * BLOCK);
    const phase = k / MAX_SWEPT;
    for (let i = 0; i < curve.length; i++) {
      const n = 0.5 + 0.5 * Math.sin(2 * Math.PI * (SWEEP_HZ * (i / SR) + phase));
      curve[i] = Number(fromNormalized(s.spec, n));
    }
    return curve;
  });
  const blocks: ParamBlock[] = [];
  for (let b = 0; b < blockCount; b++) {
    const p: Record<string, Float32Array> = { ...base };
    swept.forEach((s, k) => {
      p[s.key] = (curves[k] as Float32Array).subarray(b * BLOCK, (b + 1) * BLOCK);
    });
    blocks.push(p as unknown as ParamBlock);
  }
  return blocks;
}

function runSteady() {
  const rows: { id: string; kind: string; default: number; worst: number; worstPreset: string }[] = [];
  for (const entry of KERNEL_ENTRIES) {
    if (ONLY.length && !ONLY.some((o) => entry.id.includes(o))) continue;
    const run = (v: Record<string, ParamValue>) =>
      entry.kind === 'effect' ? () => timeEffect(entry, v) : () => timeInstrument(entry, v);
    const def = percent(run({}));
    let worst = def;
    let worstPreset = 'default';
    for (const preset of entry.presets) {
      if (PRESET && !preset.name.includes(PRESET)) continue;
      const c = percent(run(preset.params));
      if (c > worst) {
        worst = c;
        worstPreset = preset.name;
      }
    }
    rows.push({ id: entry.id.replace('agstudio.', ''), kind: entry.kind, default: def, worst, worstPreset });
  }
  rows.sort((a, b) => b.worst - a.worst);
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(rows)}\n`);
  else {
    const lines = rows.map(
      (r) =>
        `${r.id.padEnd(14)} ${r.kind.padEnd(10)} default ${r.default.toFixed(2).padStart(6)} %   worst ${r.worst
          .toFixed(2)
          .padStart(6)} %  (${r.worstPreset})`,
    );
    process.stdout.write(`CPU, % of one core at ${SR} Hz (${SECONDS} s, best of ${REPS})\n${lines.join('\n')}\n`);
  }
}

/** Default settings, steady and with sweeps; sorted by the automated/steady ratio, worst first. */
function runAutomated() {
  const rows: {
    id: string;
    kind: string;
    steady: number;
    automated: number | null;
    ratio: number | null;
    swept: string[];
  }[] = [];
  for (const entry of KERNEL_ENTRIES) {
    if (ONLY.length && !ONLY.some((o) => entry.id.includes(o))) continue;
    const values: Record<string, ParamValue> = {};
    const steady = percent(() =>
      entry.kind === 'effect' ? timeEffect(entry, values) : timeInstrument(entry, values),
    );
    const id = entry.id.replace('agstudio.', '');
    const swept = sweptParams(entry.params);
    if (swept.length === 0) {
      rows.push({ id, kind: entry.kind, steady, automated: null, ratio: null, swept: [] });
      continue;
    }
    const blocks = automatedBlocks(entry, values, swept);
    const automated = percent(() =>
      entry.kind === 'effect' ? timeEffect(entry, values, blocks) : timeInstrument(entry, values, blocks),
    );
    rows.push({ id, kind: entry.kind, steady, automated, ratio: automated / steady, swept: swept.map((s) => s.key) });
  }
  rows.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(rows)}\n`);
  else {
    const f = (n: number | null) => (n === null ? '-' : n.toFixed(2));
    const lines = rows.map(
      (r) =>
        `${r.id.padEnd(14)} ${r.kind.padEnd(10)} steady ${f(r.steady).padStart(6)} %   automated ${f(r.automated).padStart(
          6,
        )} %   ratio ${(r.ratio === null ? '-' : r.ratio.toFixed(2)).padStart(5)}  (${r.swept.join(', ') || 'no automatable floats'})`,
    );
    process.stdout.write(
      `CPU, % of one core at ${SR} Hz (${SECONDS} s, best of ${REPS}), steady vs automated (up to ${MAX_SWEPT} float params swept)\n${lines.join('\n')}\n`,
    );
  }
}

/** A chain's worklet effects in series on the music loop; each one's cost on its own is measured too (same input). */
function runChains() {
  const rows: { chain: string; total: number; parts: { id: string; cost: number }[]; native: string[] }[] = [];
  for (const chain of FACTORY_CHAINS) {
    if (ONLY.length && !ONLY.some((o) => chain.name.toLowerCase().includes(o.toLowerCase()))) continue;
    const kernels: { entry: EffectEntry; params: ParamBlock }[] = [];
    const native: string[] = [];
    for (const step of chain.steps) {
      const entry = KERNEL_ENTRIES.find((e): e is EffectEntry => e.id === step.pluginId && e.kind === 'effect');
      if (!entry) {
        native.push(step.pluginId.replace('agstudio.', ''));
        continue;
      }
      const preset = entry.presets.find((p) => p.name === step.preset);
      kernels.push({ entry, params: paramBlock(entry.params, { ...(preset?.params ?? {}), ...(step.params ?? {}) }) as ParamBlock });
    }
    const run = (parts: typeof kernels) => () => {
      const instances = parts.map((k) => {
        const kernel = k.entry.make(SR);
        kernel.transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
        return kernel;
      });
      const a = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const b = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      settle();
      const t0 = cpuMs();
      for (let at = 0; at < FRAMES; at += BLOCK) {
        a[0]!.set(INPUT[0].subarray(at, at + BLOCK));
        a[1]!.set(INPUT[1].subarray(at, at + BLOCK));
        let from = a;
        let to = b;
        for (let k = 0; k < instances.length; k++) {
          (instances[k] as EffectKernel).process(from, to, BLOCK, (parts[k] as (typeof kernels)[number]).params);
          [from, to] = [to, from];
        }
      }
      return cpuMs() - t0;
    };
    rows.push({
      chain: chain.name,
      total: percent(run(kernels)),
      parts: kernels.map((k) => ({ id: k.entry.id.replace('agstudio.', ''), cost: percent(run([k])) })),
      native,
    });
  }
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(rows)}\n`);
  else {
    const lines = rows.map(
      (r) =>
        `${r.chain.padEnd(22)} ${r.total.toFixed(2).padStart(6)} %  (${r.parts.map((p) => `${p.id} ${p.cost.toFixed(2)}`).join(', ')}${r.native.length ? `; native, not measured: ${r.native.join(', ')}` : ''})`,
    );
    process.stdout.write(`Vocal chains, CPU as % of one core at ${SR} Hz (${SECONDS} s, best of ${REPS})\n${lines.join('\n')}\n`);
  }
}

if (CHAINS) runChains();
else if (AUTOMATE) runAutomated();
else runSteady();
