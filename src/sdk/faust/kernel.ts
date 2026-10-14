/**
 * The audio-thread side of Faust plugins: runs the DSP's compiled WebAssembly inside an SDK kernel,
 * so Faust plugins get what every AGstudio kernel gets (frame-exact notes, param automation, the
 * channel pitch, NaN guards, deterministic offline renders).
 *
 * Effects run one DSP instance. Instruments run a pool of voices, one instance each, played through
 * the DSP's `freq`/`gain`/`gate` (or `key`/`vel`) controls; a released voice is freed once it falls
 * silent, and the oldest voice is stolen when all are busy.
 *
 * Memory layout (as faustwasm lays it out): the DSP struct at 0 (`meta.size` bytes), then the input
 * and output channel pointer arrays, then one 128-frame float buffer per channel.
 */
import { mtof } from '../dsp/math';
import { at, EffectKernel, InstrumentKernel, type KernelHost, type ParamBlock } from '../worklet/kernel';
import { registerKernel } from '../worklet/register';
import type { ParamSpecs } from '../params';
import { faustControls, type FaustControl, type FaustMeta } from './params';

/** Frames per compute call (the size of each wasm channel buffer). */
const BLOCK = 128;

interface FaustExports {
  memory: WebAssembly.Memory;
  init(dsp: number, sampleRate: number): void;
  instanceClear(dsp: number): void;
  compute(dsp: number, count: number, inputs: number, outputs: number): void;
  setParamValue(dsp: number, index: number, value: number): void;
}

/** What Faust's generated code may import: math functions, in float and double flavours. */
function faustImports(): WebAssembly.Imports {
  const env: Record<string, unknown> = {
    memoryBase: 0,
    tableBase: 0,
    table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
  };
  const math: Record<string, (...x: number[]) => number> = {
    acos: Math.acos,
    asin: Math.asin,
    atan: Math.atan,
    atan2: Math.atan2,
    ceil: Math.ceil,
    cos: Math.cos,
    exp: Math.exp,
    floor: Math.floor,
    fmod: (x, y) => x % y,
    log: Math.log,
    log10: Math.log10,
    remainder: (x, y) => x - Math.round(x / y) * y,
    pow: Math.pow,
    round: Math.round,
    sin: Math.sin,
    sqrt: Math.sqrt,
    tan: Math.tan,
    acosh: Math.acosh,
    asinh: Math.asinh,
    atanh: Math.atanh,
    cosh: Math.cosh,
    sinh: Math.sinh,
    tanh: Math.tanh,
    isnan: (x) => (Number.isNaN(x) ? 1 : 0),
    isinf: (x) => (Number.isFinite(x) || Number.isNaN(x) ? 0 : 1),
    copysign: (x, y) => (Math.sign(x) === Math.sign(y) ? x : -x),
  };
  for (const [name, fn] of Object.entries(math)) {
    env[`_${name}f`] = fn;
    env[`_${name}`] = fn;
  }
  env._abs = Math.abs;
  env._max_f = env._max_ = Math.max;
  env._min_f = env._min_ = Math.min;
  return { env } as WebAssembly.Imports;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 → bytes (AudioWorklet scopes have no atob). */
export function decodeBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | (lookup[clean.charCodeAt(i)] as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

const align = (n: number, to: number) => Math.ceil(n / to) * to;

/** One instance of the DSP with its own memory and channel buffers. */
export class FaustInstance {
  private readonly ex: FaustExports;
  private readonly inPtrs: number;
  private readonly outPtrs: number;
  readonly inputs: Float32Array[] = [];
  readonly outputs: Float32Array[] = [];

  constructor(module: WebAssembly.Module, meta: FaustMeta, sampleRate: number) {
    this.ex = new WebAssembly.Instance(module, faustImports()).exports as unknown as FaustExports;
    const mem = this.ex.memory;
    this.inPtrs = align(meta.size, 8);
    this.outPtrs = this.inPtrs + 4 * meta.inputs;
    const buffers = align(this.outPtrs + 4 * meta.outputs, 16);
    const end = buffers + (meta.inputs + meta.outputs) * BLOCK * 4;
    if (mem.buffer.byteLength < end) mem.grow(Math.ceil((end - mem.buffer.byteLength) / 65536));
    const i32 = new Int32Array(mem.buffer);
    for (let c = 0; c < meta.inputs + meta.outputs; c++) {
      const ptr = buffers + c * BLOCK * 4;
      i32[(this.inPtrs >> 2) + c] = ptr;
      (c < meta.inputs ? this.inputs : this.outputs).push(new Float32Array(mem.buffer, ptr, BLOCK));
    }
    this.ex.init(0, sampleRate);
  }

  set(index: number, value: number): void {
    this.ex.setParamValue(0, index, value);
  }

  clear(): void {
    this.ex.instanceClear(0);
  }

  /** Runs `count` (≤ 128) frames: inputs from `this.inputs`, results in `this.outputs`. */
  compute(count: number): void {
    this.ex.compute(0, count, this.inPtrs, this.outPtrs);
  }
}

/** Pushes changed param values into instances (block rate). */
class ParamSync {
  readonly values: Float64Array;
  constructor(private readonly controls: readonly FaustControl[]) {
    this.values = new Float64Array(controls.length).fill(Number.NaN);
  }
  /** Reads the block's values; returns true when any changed. */
  read(params: ParamBlock): boolean {
    let changed = false;
    for (let k = 0; k < this.controls.length; k++) {
      const block = params[(this.controls[k] as FaustControl).id];
      const v = block ? at(block, 0) : Number.NaN;
      if (v !== this.values[k] && !Number.isNaN(v)) {
        this.values[k] = v;
        changed = true;
      }
    }
    return changed;
  }
  apply(inst: FaustInstance): void {
    for (let k = 0; k < this.controls.length; k++) {
      const v = this.values[k] as number;
      if (!Number.isNaN(v)) inst.set((this.controls[k] as FaustControl).index, v);
    }
  }
}

/**
 * Registers the kernel for one compiled DSP under `name` (the Vite plugin's worklet module for a
 * .dsp file calls this). `kind` 'instrument' gets a voice pool of `voices` instances.
 */
export function registerFaustKernel(
  name: string,
  meta: FaustMeta,
  wasmBase64: string,
  kind: 'effect' | 'instrument',
  voices = 8,
): void {
  const module = new WebAssembly.Module(decodeBase64(wasmBase64) as Uint8Array<ArrayBuffer>);
  const { params, controls, voice } = faustControls(meta, kind);

  class FaustEffect extends EffectKernel<ParamSpecs> {
    private readonly dsp: FaustInstance;
    private readonly sync = new ParamSync(controls);

    constructor(host: KernelHost) {
      super(host);
      this.dsp = new FaustInstance(module, meta, host.sampleRate);
    }

    process(input: Float32Array[], output: Float32Array[], n: number, block: ParamBlock): void {
      if (this.sync.read(block)) this.sync.apply(this.dsp);
      const dsp = this.dsp;
      const ins = dsp.inputs.length;
      const outs = dsp.outputs.length;
      for (let off = 0; off < n; off += BLOCK) {
        const m = Math.min(BLOCK, n - off);
        for (let c = 0; c < ins; c++) {
          const dst = dsp.inputs[c] as Float32Array;
          // A mono DSP hears both sides; a stereo one each side.
          if (ins === 1 && input.length > 1) {
            const l = input[0] as Float32Array;
            const r = input[1] as Float32Array;
            for (let i = 0; i < m; i++) dst[i] = 0.5 * ((l[off + i] as number) + (r[off + i] as number));
          } else {
            const src = (input[c] ?? input[0]) as Float32Array;
            for (let i = 0; i < m; i++) dst[i] = src[off + i] as number;
          }
        }
        dsp.compute(m);
        for (let c = 0; c < output.length; c++) {
          const dst = output[c] as Float32Array;
          if (outs === 0) continue;
          const src = dsp.outputs[Math.min(c, outs - 1)] as Float32Array;
          for (let i = 0; i < m; i++) dst[off + i] = src[i] as number;
        }
      }
    }

    override reset(): void {
      this.dsp.clear();
    }
  }

  interface Voice {
    dsp: FaustInstance;
    id: number;
    key: number;
    fine: number;
    pan: number;
    pitch: number;
    active: boolean;
    held: boolean;
    age: number;
    /** Frames of silence since release. */
    quiet: number;
  }

  class FaustInstrument extends InstrumentKernel<ParamSpecs> {
    private readonly pool: Voice[] = [];
    private readonly sync = new ParamSync(controls);
    private clock = 0;

    constructor(host: KernelHost) {
      super(host);
      for (let i = 0; i < Math.max(1, voices); i++)
        this.pool.push({
          dsp: new FaustInstance(module, meta, host.sampleRate),
          id: -1,
          key: 60,
          fine: 0,
          pan: 0,
          pitch: 0,
          active: false,
          held: false,
          age: 0,
          quiet: 0,
        });
    }

    private tune(v: Voice): void {
      if (voice.freq >= 0) v.dsp.set(voice.freq, mtof(v.key + (v.fine + v.pitch) / 100));
      if (voice.key >= 0) v.dsp.set(voice.key, v.key);
    }

    noteOn(key: number, velocity: number, noteId: number, pan: number, fine: number): void {
      // A free voice, else the oldest released one, else the oldest one (stolen voices start clean).
      let v: Voice | undefined;
      for (const x of this.pool) if (!x.active) v ??= x;
      if (!v) {
        for (const x of this.pool) if (!x.held && (!v || x.age < v.age)) v = x;
        if (!v) for (const x of this.pool) if (!v || x.age < v.age) v = x;
        v!.dsp.clear();
      }
      const vc = v!;
      vc.id = noteId;
      vc.key = key;
      vc.fine = fine;
      vc.pan = pan;
      vc.pitch = at(this.pitch, 0);
      vc.active = true;
      vc.held = true;
      vc.age = ++this.clock;
      vc.quiet = 0;
      this.sync.apply(vc.dsp);
      this.tune(vc);
      if (voice.gain >= 0) vc.dsp.set(voice.gain, velocity);
      if (voice.vel >= 0) vc.dsp.set(voice.vel, Math.round(velocity * 127));
      if (voice.gate >= 0) vc.dsp.set(voice.gate, 1);
    }

    noteOff(noteId: number): void {
      for (const v of this.pool) {
        if (!v.active || !v.held || v.id !== noteId) continue;
        v.held = false;
        if (voice.gate >= 0) v.dsp.set(voice.gate, 0);
      }
    }

    override allNotesOff(hard: boolean): void {
      for (const v of this.pool) {
        if (!v.active) continue;
        v.held = false;
        if (voice.gate >= 0) v.dsp.set(voice.gate, 0);
        if (hard) {
          v.dsp.clear();
          v.active = false;
        }
      }
    }

    override reset(): void {
      for (const v of this.pool) {
        v.dsp.clear();
        v.active = false;
      }
    }

    render(out: Float32Array[], from: number, to: number, block: ParamBlock): void {
      const changed = this.sync.read(block);
      const pitch = at(this.pitch, from);
      const left = out[0] as Float32Array;
      const right = (out[1] ?? out[0]) as Float32Array;
      for (const v of this.pool) {
        if (!v.active) continue;
        if (changed) this.sync.apply(v.dsp);
        if (pitch !== v.pitch) {
          v.pitch = pitch;
          this.tune(v);
        }
        const outs = v.dsp.outputs.length;
        if (outs === 0) continue;
        // Equal-power pan for a mono voice; balance for a stereo one.
        const a = ((v.pan + 1) * Math.PI) / 4;
        const gl = outs === 1 ? Math.cos(a) * Math.SQRT2 : Math.min(1, 1 - v.pan);
        const gr = outs === 1 ? Math.sin(a) * Math.SQRT2 : Math.min(1, 1 + v.pan);
        let peak = 0;
        for (let off = from; off < to; off += BLOCK) {
          const m = Math.min(BLOCK, to - off);
          for (const inBuf of v.dsp.inputs) inBuf.fill(0, 0, m);
          v.dsp.compute(m);
          const l = v.dsp.outputs[0] as Float32Array;
          const r = (v.dsp.outputs[1] ?? v.dsp.outputs[0]) as Float32Array;
          for (let i = 0; i < m; i++) {
            const xl = l[i] as number;
            const xr = r[i] as number;
            left[off + i] = (left[off + i] as number) + xl * gl;
            right[off + i] = (right[off + i] as number) + xr * gr;
            const ax = xl < 0 ? -xl : xl;
            if (ax > peak) peak = ax;
          }
        }
        if (!v.held) {
          v.quiet = peak < 1e-5 ? v.quiet + (to - from) : 0;
          // 50 ms of silence after the release: the voice is free again.
          if (v.quiet > this.sampleRate * 0.05) v.active = false;
        }
      }
    }
  }

  registerKernel(name, params, kind === 'instrument' ? FaustInstrument : FaustEffect);
}
