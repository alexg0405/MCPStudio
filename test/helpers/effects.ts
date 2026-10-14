/**
 * The M14 effects for the generic mixer tests (fixtures.ts adds them to EFFECTS), their kernels for
 * cost measurements, and helpers for effect browser tests. Keep imports from fixtures.ts out of
 * here: fixtures.ts imports this file.
 */
import { paramBlock, testHost, testTransport } from '@agstudio/sdk/testing';
import type { EffectKernel, KernelHost } from '@agstudio/sdk/worklet';
import type { ParamSpecs, PluginDef } from '@agstudio/sdk';
import eqPro from '../../src/plugins/builtin/eq-pro';
import limiter from '../../src/plugins/builtin/limiter';
import multiband from '../../src/plugins/builtin/multiband';
import transient from '../../src/plugins/builtin/transient-shaper';
import saturator from '../../src/plugins/builtin/saturator';
import chorus from '../../src/plugins/builtin/chorus';
import flanger from '../../src/plugins/builtin/flanger';
import phaser from '../../src/plugins/builtin/phaser';
import stereo from '../../src/plugins/builtin/stereo';
import lofi from '../../src/plugins/builtin/lofi';
import stutter from '../../src/plugins/builtin/stutter';
import vocoder from '../../src/plugins/builtin/vocoder';
import tune from '../../src/plugins/builtin/tune';
import analyzer from '../../src/plugins/builtin/analyzer';
import { EqProKernel } from '../../src/plugins/builtin/eq-pro/kernel';
import { LimiterKernel } from '../../src/plugins/builtin/limiter/kernel';
import { MultibandKernel } from '../../src/plugins/builtin/multiband/kernel';
import { TransientKernel } from '../../src/plugins/builtin/transient-shaper/kernel';
import { SaturatorKernel } from '../../src/plugins/builtin/saturator/kernel';
import { ChorusKernel } from '../../src/plugins/builtin/chorus/kernel';
import { FlangerKernel } from '../../src/plugins/builtin/flanger/kernel';
import { PhaserKernel } from '../../src/plugins/builtin/phaser/kernel';
import { StereoKernel } from '../../src/plugins/builtin/stereo/kernel';
import { LofiKernel } from '../../src/plugins/builtin/lofi/kernel';
import { StutterKernel } from '../../src/plugins/builtin/stutter/kernel';
import { VocoderKernel } from '../../src/plugins/builtin/vocoder/kernel';
import { TuneKernel } from '../../src/plugins/builtin/tune/kernel';
import { AnalyzerKernel } from '../../src/plugins/builtin/analyzer/kernel';
import { DuckerKernel } from '../../src/plugins/builtin/ducker/kernel';
import ducker from '../../src/plugins/builtin/ducker';

/** Every effect M14 added (the Ducker was already in EFFECTS). */
export const M14_EFFECTS: readonly PluginDef[] = [
  eqPro,
  limiter,
  multiband,
  transient,
  saturator,
  chorus,
  flanger,
  phaser,
  stereo,
  lofi,
  stutter,
  vocoder,
  tune,
  analyzer,
] as PluginDef[];

type KernelCtor = new (host: KernelHost) => EffectKernel;

/** Each effect's kernel, to measure what it costs. `heavy` ones may take more than 1 % of a core. */
export const M14_KERNELS: readonly { def: PluginDef; Kernel: KernelCtor; heavy?: boolean }[] = [
  { def: eqPro, Kernel: EqProKernel as KernelCtor },
  { def: limiter, Kernel: LimiterKernel as KernelCtor },
  { def: multiband, Kernel: MultibandKernel as KernelCtor },
  { def: transient, Kernel: TransientKernel as KernelCtor },
  { def: saturator, Kernel: SaturatorKernel as KernelCtor },
  { def: chorus, Kernel: ChorusKernel as KernelCtor },
  { def: flanger, Kernel: FlangerKernel as KernelCtor },
  { def: phaser, Kernel: PhaserKernel as KernelCtor },
  { def: stereo, Kernel: StereoKernel as KernelCtor },
  { def: lofi, Kernel: LofiKernel as KernelCtor },
  { def: stutter, Kernel: StutterKernel as KernelCtor },
  { def: vocoder, Kernel: VocoderKernel as KernelCtor, heavy: true },
  { def: tune, Kernel: TuneKernel as KernelCtor, heavy: true },
  { def: analyzer, Kernel: AnalyzerKernel as KernelCtor, heavy: true },
  { def: ducker as PluginDef, Kernel: DuckerKernel as KernelCtor },
];

/**
 * What one instance of a kernel costs at 48 kHz: the share of one core (in %) that processing
 * `seconds` of stereo music-like audio in 128-frame blocks takes, after a warm-up. `params` are the
 * plugin's params (a preset's values on top of the defaults).
 */
export function kernelCost(
  Kernel: KernelCtor,
  specs: ParamSpecs,
  params: Record<string, number | boolean | string>,
  seconds = 2,
): number {
  const sr = 48000;
  const block = 128;
  const kernel = new Kernel(testHost({ sampleRate: sr }));
  kernel.transport = testTransport({ playing: true, bpm: 128, sampleRate: sr });
  const p = paramBlock(specs, params);
  // One second of a chord with a pulse on every beat, so dynamics and detectors have work to do.
  const len = sr;
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const env = Math.exp(-((i % (sr / 2)) / sr) * 6);
    const tone = Math.sin(i * 0.0287) + 0.5 * Math.sin(i * 0.0431) + 0.3 * Math.sin(i * 0.0861);
    left[i] = 0.3 * env * tone;
    right[i] = 0.3 * env * Math.sin(i * 0.0287 + 0.5);
  }
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);
  const input = [inL, inR];
  const output = [outL, outR];
  const run = (frames: number) => {
    const transport = kernel.transport as ReturnType<typeof testTransport>;
    for (let at = 0; at < frames; at += block) {
      const from = at % len;
      inL.set(left.subarray(from, from + block));
      inR.set(right.subarray(from, from + block));
      transport.blockStart = at;
      kernel.process(input, output, block, p, input);
    }
  };
  run(sr); // warm up the JIT
  // The best of three runs: the machine's own hiccups only ever add time.
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    run(Math.round(seconds * sr));
    best = Math.min(best, performance.now() - t0);
  }
  return (best / (seconds * 1000)) * 100;
}
