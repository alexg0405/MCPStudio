/**
 * Every built-in plugin that runs as an AudioWorklet kernel, runnable in plain Node: shared by the
 * plugin sweep (test/unit/plugin-sweep.test.ts) and the opt-in CPU benchmark
 * (test/unit/plugin-bench.test.ts). Plugins built from native Web Audio nodes (Sampler, 3xOsc,
 * 808 Bass, Delay, EQ, Filter, Distortion) have no kernel; test/browser/ covers them.
 */
import { defaultValues, type EffectDef, type InstrumentDef, type ParamSpecs, type ParamValue } from '@agstudio/sdk';
import type { EffectKernel, InstrumentKernel } from '@agstudio/sdk/worklet';
import { testHost } from '@agstudio/sdk/testing';

import analyzer from '../../src/plugins/builtin/analyzer';
import { AnalyzerKernel } from '../../src/plugins/builtin/analyzer/kernel';
import { analyzerParams } from '../../src/plugins/builtin/analyzer/params';
import chorus from '../../src/plugins/builtin/chorus';
import { ChorusKernel } from '../../src/plugins/builtin/chorus/kernel';
import { chorusParams } from '../../src/plugins/builtin/chorus/params';
import compressor from '../../src/plugins/builtin/compressor';
import { CompressorKernel } from '../../src/plugins/builtin/compressor/kernel';
import { compressorParams } from '../../src/plugins/builtin/compressor/params';
import deEsser from '../../src/plugins/builtin/de-esser';
import { DeEsserKernel } from '../../src/plugins/builtin/de-esser/kernel';
import { deEsserParams } from '../../src/plugins/builtin/de-esser/params';
import doubler from '../../src/plugins/builtin/doubler';
import { DoublerKernel } from '../../src/plugins/builtin/doubler/kernel';
import { doublerParams } from '../../src/plugins/builtin/doubler/params';
import drumPads from '../../src/plugins/builtin/drum-pads';
import { DrumPadsKernel } from '../../src/plugins/builtin/drum-pads/kernel';
import { drumPadsParams, FIRST_KEY as PAD_FIRST_KEY, SOUND_IDS } from '../../src/plugins/builtin/drum-pads/params';
import { builtinSound } from '../../src/plugins/builtin/drum-pads/sounds.kernel';
import drumSynth from '../../src/plugins/builtin/drum-synth';
import { DrumSynthKernel } from '../../src/plugins/builtin/drum-synth/kernel';
import { drumSynthParams } from '../../src/plugins/builtin/drum-synth/params';
import ducker from '../../src/plugins/builtin/ducker';
import { DuckerKernel } from '../../src/plugins/builtin/ducker/kernel';
import { duckerParams } from '../../src/plugins/builtin/ducker/params';
import eqPro from '../../src/plugins/builtin/eq-pro';
import { EqProKernel } from '../../src/plugins/builtin/eq-pro/kernel';
import { eqProParams } from '../../src/plugins/builtin/eq-pro/params';
import flanger from '../../src/plugins/builtin/flanger';
import { FlangerKernel } from '../../src/plugins/builtin/flanger/kernel';
import { flangerParams } from '../../src/plugins/builtin/flanger/params';
import fm from '../../src/plugins/builtin/fm';
import { FmKernel } from '../../src/plugins/builtin/fm/kernel';
import { fmParams } from '../../src/plugins/builtin/fm/params';
import gate from '../../src/plugins/builtin/gate';
import { GateKernel } from '../../src/plugins/builtin/gate/kernel';
import { gateParams } from '../../src/plugins/builtin/gate/params';
import limiter from '../../src/plugins/builtin/limiter';
import { LimiterKernel } from '../../src/plugins/builtin/limiter/kernel';
import { limiterParams } from '../../src/plugins/builtin/limiter/params';
import maximizer from '../../src/plugins/builtin/maximizer';
import { MaximizerKernel } from '../../src/plugins/builtin/maximizer/kernel';
import { maximizerParams } from '../../src/plugins/builtin/maximizer/params';
import lofi from '../../src/plugins/builtin/lofi';
import { LofiKernel } from '../../src/plugins/builtin/lofi/kernel';
import { lofiParams } from '../../src/plugins/builtin/lofi/params';
import multiband from '../../src/plugins/builtin/multiband';
import { MultibandKernel } from '../../src/plugins/builtin/multiband/kernel';
import { multibandParams } from '../../src/plugins/builtin/multiband/params';
import phaser from '../../src/plugins/builtin/phaser';
import { PhaserKernel } from '../../src/plugins/builtin/phaser/kernel';
import { phaserParams } from '../../src/plugins/builtin/phaser/params';
import pluck from '../../src/plugins/builtin/pluck';
import { PluckKernel } from '../../src/plugins/builtin/pluck/kernel';
import { pluckParams } from '../../src/plugins/builtin/pluck/params';
import reverb from '../../src/plugins/builtin/reverb';
import { ReverbKernel } from '../../src/plugins/builtin/reverb/kernel';
import { reverbParams } from '../../src/plugins/builtin/reverb/params';
import saturator from '../../src/plugins/builtin/saturator';
import { SaturatorKernel } from '../../src/plugins/builtin/saturator/kernel';
import { saturatorParams } from '../../src/plugins/builtin/saturator/params';
import slicer from '../../src/plugins/builtin/slicer';
import { demoLoop, DEMO_RATE } from '../../src/plugins/builtin/slicer/demo.kernel';
import { SlicerKernel } from '../../src/plugins/builtin/slicer/kernel';
import { FIRST_KEY as SLICE_FIRST_KEY, slicerParams } from '../../src/plugins/builtin/slicer/params';
import stereo from '../../src/plugins/builtin/stereo';
import { StereoKernel } from '../../src/plugins/builtin/stereo/kernel';
import { stereoParams } from '../../src/plugins/builtin/stereo/params';
import stutter from '../../src/plugins/builtin/stutter';
import { StutterKernel } from '../../src/plugins/builtin/stutter/kernel';
import { stutterParams } from '../../src/plugins/builtin/stutter/params';
import transient from '../../src/plugins/builtin/transient-shaper';
import { TransientKernel } from '../../src/plugins/builtin/transient-shaper/kernel';
import { transientParams } from '../../src/plugins/builtin/transient-shaper/params';
import tune from '../../src/plugins/builtin/tune';
import { TuneKernel } from '../../src/plugins/builtin/tune/kernel';
import { tuneParams } from '../../src/plugins/builtin/tune/params';
import vocoder from '../../src/plugins/builtin/vocoder';
import { VocoderKernel } from '../../src/plugins/builtin/vocoder/kernel';
import { vocoderParams } from '../../src/plugins/builtin/vocoder/params';
import wavetable from '../../src/plugins/builtin/wavetable';
import { WavetableKernel } from '../../src/plugins/builtin/wavetable/kernel';
import { wavetableParams } from '../../src/plugins/builtin/wavetable/params';
import { factoryBank } from '../../src/plugins/builtin/wavetable/tables';

type AnyDef = InstrumentDef<ParamSpecs, unknown> | EffectDef<ParamSpecs, unknown>;

interface Common {
  /** Plugin id (as in the project document). */
  id: string;
  name: string;
  params: ParamSpecs;
  def: AnyDef;
  presets: readonly { name: string; params: Record<string, ParamValue> }[];
  sidechain: boolean;
  /** The tail the plugin reports (seconds) for a set of param values (defaults filled in). */
  tailTime(values?: Record<string, ParamValue>): number;
}

export interface InstrumentEntry extends Common {
  kind: 'instrument';
  make(sampleRate: number): InstrumentKernel;
  /** Notes (keys) a typical patch plays. */
  keys: readonly number[];
}

export interface EffectEntry extends Common {
  kind: 'effect';
  make(sampleRate: number): EffectKernel;
}

export type KernelEntry = InstrumentEntry | EffectEntry;

const sdkDef = (d: unknown) => d as AnyDef;

function tailOf(def: unknown, params: ParamSpecs, fallback: number) {
  const tail = (def as { tailTime?: number | ((v: Record<string, ParamValue>, host: unknown) => number) }).tailTime;
  // A host with no samples loaded and no notes: what the export's tail probe sees of an empty instrument.
  const host = {
    samples: { durationSec: () => null, name: () => null, get: () => null },
    channel: null,
  };
  return (values: Record<string, ParamValue> = {}): number => {
    if (typeof tail === 'function') return tail({ ...defaultValues(params), ...values }, host);
    return tail ?? fallback;
  };
}

function presetsOf(d: unknown) {
  return ((d as { presets?: { name: string; params?: Record<string, ParamValue> }[] }).presets ?? []).map((x) => ({
    name: x.name,
    params: x.params ?? {},
  }));
}

function effect<P extends ParamSpecs>(
  def: unknown,
  params: P,
  Kernel: new (host: ReturnType<typeof testHost>) => EffectKernel<P>,
): EffectEntry {
  const d = def as { id: string; name: string; sidechain?: boolean };
  return {
    kind: 'effect',
    id: d.id,
    name: d.name,
    params,
    def: sdkDef(def),
    presets: presetsOf(def),
    sidechain: d.sidechain === true,
    tailTime: tailOf(def, params, 0),
    make: (sr) => new Kernel(testHost(sr, 7)) as unknown as EffectKernel,
  };
}

function instrument<P extends ParamSpecs>(
  def: unknown,
  params: P,
  make: (sampleRate: number) => InstrumentKernel<P>,
  keys: readonly number[],
): InstrumentEntry {
  const d = def as { id: string; name: string };
  return {
    kind: 'instrument',
    id: d.id,
    name: d.name,
    params,
    def: sdkDef(def),
    presets: presetsOf(def),
    sidechain: false,
    tailTime: tailOf(def, params, 1),
    make: (sr) => make(sr) as unknown as InstrumentKernel,
    keys,
  };
}

const CHORD = [48, 55, 60, 64, 67, 72, 76, 79];

export const KERNEL_ENTRIES: readonly KernelEntry[] = [
  instrument(
    wavetable,
    wavetableParams,
    (sr) => {
      const k = new WavetableKernel(testHost(sr, 7));
      k.useBank(factoryBank());
      return k;
    },
    CHORD,
  ),
  instrument(fm, fmParams, (sr) => new FmKernel(testHost(sr, 7)), CHORD),
  instrument(pluck, pluckParams, (sr) => new PluckKernel(testHost(sr, 7)), CHORD),
  instrument(
    drumPads,
    drumPadsParams,
    (sr) => {
      const k = new DrumPadsKernel(testHost(sr, 7));
      k.onMessage({
        type: 'sounds',
        sampleRate: sr,
        sounds: SOUND_IDS.map((id) => builtinSound(id, sr)),
      });
      return k;
    },
    Array.from({ length: 16 }, (_, i) => PAD_FIRST_KEY + i),
  ),
  instrument(
    drumSynth,
    drumSynthParams,
    (sr) => new DrumSynthKernel(testHost(sr, 7)),
    [36, 38, 42, 46, 45, 49, 39, 56],
  ),
  instrument(
    slicer,
    slicerParams,
    (sr) => {
      const k = new SlicerKernel(testHost(sr, 7));
      k.onMessage({ type: 'demo', data: demoLoop(), sampleRate: DEMO_RATE });
      return k;
    },
    Array.from({ length: 8 }, (_, i) => SLICE_FIRST_KEY + i),
  ),

  effect(analyzer, analyzerParams, AnalyzerKernel),
  effect(chorus, chorusParams, ChorusKernel),
  effect(compressor, compressorParams, CompressorKernel),
  effect(deEsser, deEsserParams, DeEsserKernel),
  effect(doubler, doublerParams, DoublerKernel),
  effect(ducker, duckerParams, DuckerKernel),
  effect(eqPro, eqProParams, EqProKernel),
  effect(flanger, flangerParams, FlangerKernel),
  effect(gate, gateParams, GateKernel),
  effect(limiter, limiterParams, LimiterKernel),
  effect(lofi, lofiParams, LofiKernel),
  effect(maximizer, maximizerParams, MaximizerKernel),
  effect(multiband, multibandParams, MultibandKernel),
  effect(phaser, phaserParams, PhaserKernel),
  effect(reverb, reverbParams, ReverbKernel),
  effect(saturator, saturatorParams, SaturatorKernel),
  effect(stereo, stereoParams, StereoKernel),
  effect(stutter, stutterParams, StutterKernel),
  effect(transient, transientParams, TransientKernel),
  effect(tune, tuneParams, TuneKernel),
  effect(vocoder, vocoderParams, VocoderKernel),
];
