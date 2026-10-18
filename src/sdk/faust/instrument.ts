/**
 * The instrument kernel of a Faust plugin: a pool of voices, one DSP instance each, played through
 * the DSP's `freq`/`gain`/`gate` (or `key`/`vel`) controls. A released voice is freed once it falls
 * silent, and the oldest voice is stolen when all are busy.
 */
import { mtof } from '../dsp/math';
import type { ParamSpecs } from '../params';
import { at, InstrumentKernel, type KernelHost, type ParamBlock } from '../worklet/kernel';
import { FAUST_BLOCK_FRAMES, FaustInstance } from './instance';
import { ParamSync } from './param-sync';
import type { FaustControl, FaustMeta, FaustVoiceControls } from './params';

/** A voice whose output stays below this (about -100 dBFS) counts as silent. */
const SILENT_PEAK = 1e-5;
/** Seconds of silence after a voice is released before it is free again. */
const FREE_AFTER_QUIET_SEC = 0.05;
/** Cents in one semitone: `fine` and the channel pitch are in cents. */
const CENTS_PER_SEMITONE = 100;
const MIDI_VELOCITY_MAX = 127;

/** What one compiled instrument DSP is made of; every kernel instance shares it. */
export interface FaustInstrumentDesign {
  module: WebAssembly.Module;
  meta: FaustMeta;
  controls: readonly FaustControl[];
  /** The DSP's voice controls (memory offsets; -1 for the ones it lacks). */
  voice: FaustVoiceControls;
  voiceCount: number;
}

interface FaustVoice {
  dsp: FaustInstance;
  noteId: number;
  key: number;
  /** The note's fine pitch, cents. */
  fineCents: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  /** The channel pitch this voice is tuned to, cents. */
  channelPitchCents: number;
  /** False once the voice is free. */
  isActive: boolean;
  /** True between the note on and the note off. */
  isHeld: boolean;
  /** Start order, for stealing the oldest. */
  age: number;
  /** Frames of silence since release. */
  quietFrames: number;
}

class FaustInstrument extends InstrumentKernel<ParamSpecs> {
  private readonly pool: FaustVoice[] = [];
  private readonly sync: ParamSync;
  private readonly voice: FaustVoiceControls;
  private clock = 0;

  constructor(host: KernelHost, design: FaustInstrumentDesign) {
    super(host);
    this.sync = new ParamSync(design.controls);
    this.voice = design.voice;
    for (let i = 0; i < Math.max(1, design.voiceCount); i++)
      this.pool.push({
        dsp: new FaustInstance(design.module, design.meta, host.sampleRate),
        noteId: -1,
        key: 60,
        fineCents: 0,
        pan: 0,
        channelPitchCents: 0,
        isActive: false,
        isHeld: false,
        age: 0,
        quietFrames: 0,
      });
  }

  /** Sets the voice's frequency (and key) controls from its note, fine pitch and the channel pitch. */
  private tune(v: FaustVoice): void {
    const cents = v.fineCents + v.channelPitchCents;
    if (this.voice.freq >= 0) v.dsp.set(this.voice.freq, mtof(v.key + cents / CENTS_PER_SEMITONE));
    if (this.voice.key >= 0) v.dsp.set(this.voice.key, v.key);
  }

  /** A free voice, else the oldest released one, else the oldest one (stolen voices start clean). */
  private takeVoice(): FaustVoice {
    let free: FaustVoice | undefined;
    for (const candidate of this.pool) if (!candidate.isActive) free ??= candidate;
    if (free) return free;
    let victim: FaustVoice | undefined;
    for (const candidate of this.pool) if (!candidate.isHeld && (!victim || candidate.age < victim.age)) victim = candidate;
    if (!victim) for (const candidate of this.pool) if (!victim || candidate.age < victim.age) victim = candidate;
    const stolen = victim as FaustVoice;
    stolen.dsp.clear();
    return stolen;
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fineCents: number): void {
    const v = this.takeVoice();
    v.noteId = noteId;
    v.key = key;
    v.fineCents = fineCents;
    v.pan = pan;
    v.channelPitchCents = at(this.pitch, 0);
    v.isActive = true;
    v.isHeld = true;
    v.age = ++this.clock;
    v.quietFrames = 0;
    this.sync.apply(v.dsp);
    this.tune(v);
    if (this.voice.gain >= 0) v.dsp.set(this.voice.gain, velocity);
    if (this.voice.vel >= 0) v.dsp.set(this.voice.vel, Math.round(velocity * MIDI_VELOCITY_MAX));
    if (this.voice.gate >= 0) v.dsp.set(this.voice.gate, 1);
  }

  noteOff(noteId: number): void {
    for (const v of this.pool) {
      if (!v.isActive || !v.isHeld || v.noteId !== noteId) continue;
      v.isHeld = false;
      if (this.voice.gate >= 0) v.dsp.set(this.voice.gate, 0);
    }
  }

  override allNotesOff(hard: boolean): void {
    for (const v of this.pool) {
      if (!v.isActive) continue;
      v.isHeld = false;
      if (this.voice.gate >= 0) v.dsp.set(this.voice.gate, 0);
      if (hard) {
        v.dsp.clear();
        v.isActive = false;
      }
    }
  }

  override reset(): void {
    for (const v of this.pool) {
      v.dsp.clear();
      v.isActive = false;
    }
  }

  render(out: Float32Array[], from: number, to: number, block: ParamBlock): void {
    const changed = this.sync.read(block);
    const channelPitchCents = at(this.pitch, from);
    const left = out[0] as Float32Array;
    const right = (out[1] ?? out[0]) as Float32Array;
    for (const v of this.pool) {
      if (!v.isActive) continue;
      if (changed) this.sync.apply(v.dsp);
      if (channelPitchCents !== v.channelPitchCents) {
        v.channelPitchCents = channelPitchCents;
        this.tune(v);
      }
      this.renderVoice(v, left, right, from, to);
    }
  }

  /** Adds one voice's frames [from, to) to the output, panned, and frees it once it has been silent long enough. */
  private renderVoice(v: FaustVoice, left: Float32Array, right: Float32Array, from: number, to: number): void {
    const outputChannels = v.dsp.outputs.length;
    if (outputChannels === 0) return;
    // Equal-power pan for a mono voice; balance for a stereo one.
    const angle = ((v.pan + 1) * Math.PI) / 4;
    const gainLeft = outputChannels === 1 ? Math.cos(angle) * Math.SQRT2 : Math.min(1, 1 - v.pan);
    const gainRight = outputChannels === 1 ? Math.sin(angle) * Math.SQRT2 : Math.min(1, 1 + v.pan);
    let peak = 0;
    for (let offset = from; offset < to; offset += FAUST_BLOCK_FRAMES) {
      const count = Math.min(FAUST_BLOCK_FRAMES, to - offset);
      for (const inputBuffer of v.dsp.inputs) inputBuffer.fill(0, 0, count);
      v.dsp.compute(count);
      const voiceLeft = v.dsp.outputs[0] as Float32Array;
      const voiceRight = (v.dsp.outputs[1] ?? v.dsp.outputs[0]) as Float32Array;
      for (let i = 0; i < count; i++) {
        const sampleLeft = voiceLeft[i] as number;
        const sampleRight = voiceRight[i] as number;
        left[offset + i] = (left[offset + i] as number) + sampleLeft * gainLeft;
        right[offset + i] = (right[offset + i] as number) + sampleRight * gainRight;
        const magnitude = sampleLeft < 0 ? -sampleLeft : sampleLeft;
        if (magnitude > peak) peak = magnitude;
      }
    }
    if (v.isHeld) return;
    v.quietFrames = peak < SILENT_PEAK ? v.quietFrames + (to - from) : 0;
    if (v.quietFrames > this.sampleRate * FREE_AFTER_QUIET_SEC) v.isActive = false;
  }
}

/** The kernel class for an instrument DSP (a subclass that carries the design, since a kernel's constructor takes only the host). */
export function faustInstrumentClass(design: FaustInstrumentDesign): new (host: KernelHost) => InstrumentKernel<ParamSpecs> {
  return class extends FaustInstrument {
    constructor(host: KernelHost) {
      super(host, design);
    }
  };
}
