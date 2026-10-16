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
 */
import type { ParamValue } from '@agstudio/sdk';
import { paramBlock, testTransport } from '@agstudio/sdk/testing';
import type { EffectKernel, InstrumentKernel, ParamBlock } from '@agstudio/sdk/worklet';
import { KERNEL_ENTRIES, type EffectEntry, type InstrumentEntry } from '../helpers/builtin-kernels';
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
const FRAMES = SR * SECONDS;

/** Settles the garbage collector before a timed run (its helper threads would count as CPU time). */
const settle = () => (globalThis as { gc?: () => void }).gc?.();

/** CPU time in ms: steadier than wall time while other programs share the machine. */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const INPUT = musicInput(FRAMES);
const KEY = keyInput(FRAMES);

function timeEffect(entry: EffectEntry, values: Record<string, ParamValue>): number {
  const kernel: EffectKernel = entry.make(SR);
  const transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  kernel.transport = transport;
  const params = paramBlock(entry.params, values) as ParamBlock;
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const scL = new Float32Array(BLOCK);
  const scR = new Float32Array(BLOCK);
  settle();
  const t0 = cpuMs();
  for (let at = 0; at < FRAMES; at += BLOCK) {
    transport.blockStart = at;
    const i = [INPUT[0].subarray(at, at + BLOCK), INPUT[1].subarray(at, at + BLOCK)];
    if (entry.sidechain) {
      scL.set(KEY[0].subarray(at, at + BLOCK));
      scR.set(KEY[1].subarray(at, at + BLOCK));
      kernel.process(i, [outL, outR], BLOCK, params, [scL, scR]);
    } else kernel.process(i, [outL, outR], BLOCK, params);
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
