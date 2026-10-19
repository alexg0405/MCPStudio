import {
  at,
  dbToGain,
  InstrumentKernel,
  polyBlep,
  softClip,
  WavetableBank,
  type KernelHost,
  type Lfo,
  type LfoShape,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import {
  DEST_AMP,
  DEST_CUTOFF,
  DEST_LFO1_RATE,
  DEST_LFO2_RATE,
  DEST_OSC1_POSITION,
  DEST_OSC2_POSITION,
  DEST_PAN,
  DEST_PITCH,
  DEST_RESONANCE,
  DESTINATION_COUNT,
  sumModMatrix,
} from './modulation.kernel';
import { addOscillatorToMix } from './oscillator-mix.kernel';
import { LFO_BEATS, LFO_SHAPES, wavetableParams } from './params';
import { LFO_IDS, ParamSnapshot, type LfoParams, type OscillatorParams } from './snapshot.kernel';
import { VoiceAllocator } from './voice-allocator.kernel';
import { MAX_UNISON, type OscillatorState, type WavetableVoice } from './voice.kernel';

type Params = typeof wavetableParams;

/** Modulation, envelopes and pitch update every CONTROL samples; levels and morphs glide in between. */
const CONTROL = 32;

/** Positions in the filterType param's options (FILTER_TYPES in params.ts); the first, 'lp12', is the default shape. */
const FILTER_LP24 = 1;
const FILTER_HP = 2;
const FILTER_BP = 3;
const FILTER_NOTCH = 4;

/** MIDI controller number of the mod wheel. */
const CC_MOD_WHEEL = 1;

/**
 * A frame's cache key packs the table, frame and mip level: `(table * 64 + frame) * 16 + level`. A table has
 * at most 64 frames and there are 16 mip levels (WT_LEVELS), so every combination gets its own number.
 */
const MAX_FRAMES_PER_TABLE = 64;
const MIP_LEVEL_SLOTS = 16;
/** Frame keys of the user table start here, so they never equal a factory table's (those are below 10 tables × 64 frames × 16 levels). */
const USER_KEY = 1e9;

/** Filter cutoff limits: the bottom of the audible range, and a margin below Nyquist (as a share of the sample rate). */
const MIN_CUTOFF_HZ = 20;
const MAX_FREQUENCY_SHARE = 0.45;
/** The mod matrix moves the cutoff by up to this many octaves at 100% (the same text is in the param's label). */
const CUTOFF_MOD_OCTAVES = 8;

/**
 * The Wavetable synth's kernel. Two morphing wavetable oscillators (bank from the main thread, see
 * index.ts) with unison, a sub and noise, a driven state-variable filter, amp and mod envelopes,
 * two LFOs (free or locked to the song position), a 6-slot mod matrix and poly/mono/legato voices
 * with glide. Note events are queued and handled at the start of the next render, with that block's
 * params, so voice modes and settings apply from the very first note of an export.
 */
export class WavetableKernel extends InstrumentKernel<Params> {
  private bank: WavetableBank | null = null;
  /** The drawn table (one table, any number of frames) when the plugin's state has one; the table after the factory ones. */
  private user: WavetableBank | null = null;
  /** Counts the user tables received, so a voice rereads its frames when the table is replaced. */
  private userEpoch = 0;
  private readonly allocator: VoiceAllocator;
  private readonly controlRate: number;
  private modWheel = 0;
  private modWheelSmoothed = 0;
  /** Free-running LFO phases shared by voices that don't restart their LFOs. */
  private readonly sharedLfoPhase = new Float64Array(2);
  /** The mod matrix sums of the voice being controlled, one per destination. */
  private readonly modSums = new Float64Array(DESTINATION_COUNT);
  /** The mix of one voice's oscillators for the segment being rendered. */
  private readonly mixLeft = new Float64Array(CONTROL);
  private readonly mixRight = new Float64Array(CONTROL);

  // Shared per-block settings read by the control step and the segment renderer.
  // They are written by whichever voice controlled last, so a voice that skips a control step uses the last one's
  // (the same for every voice unless these params are automated).
  private subShape = 0;
  private isFilterSteep = false;
  /** The last resonance seen and its Q (shared by voices: one pow per change, not per voice and step). */
  private lastResonance = NaN;
  private lastQ = 0;

  private readonly snapshotOfParams = new ParamSnapshot();
  /** Which render call and frame the snapshot was taken at (see ParamSnapshot). */
  private snapshotRenderCall = -1;
  private snapshotFrame = -1;
  private renderCall = 0;
  /** True while no param is automated in this render call: the snapshot is then good for every frame. */
  private paramsAreConstant = true;
  private readonly paramNames = Object.keys(wavetableParams);

  constructor(host: KernelHost) {
    super(host);
    this.controlRate = host.sampleRate / CONTROL;
    this.allocator = new VoiceAllocator(this.controlRate);
  }

  /**
   * The factory bank arrives from the main thread once (`{ type: 'bank', data, tables, frames }`), and the user's
   * drawn table every time it changes (`{ type: 'userBank', data, frames }`: one table of `frames` frames).
   */
  override onMessage(msg: unknown): void {
    const m = msg as { type?: string; data?: Float32Array; tables?: number; frames?: number } | null;
    if (!m || !(m.data instanceof Float32Array) || !m.frames) return;
    try {
      if (m.type === 'bank' && m.tables) this.useBank(WavetableBank.wrap(m.data, m.tables, m.frames));
      else if (m.type === 'userBank') this.useUserBank(WavetableBank.wrap(m.data, 1, m.frames));
    } catch {
      // Data too short for what it claims: keep what plays.
    }
  }

  /** Plays the factory tables of this bank. */
  useBank(bank: WavetableBank): void {
    this.bank = bank;
  }

  /** Plays this bank (one table) for oscillators set to the user table, from the next control step. */
  useUserBank(bank: WavetableBank | null): void {
    this.user = bank;
    this.userEpoch++;
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    this.allocator.noteOn(key, velocity, noteId, pan, fine);
  }

  noteOff(noteId: number, key: number, _release: number): void {
    this.allocator.noteOff(noteId, key);
  }

  override allNotesOff(hard: boolean): void {
    this.allocator.allNotesOff(hard);
  }

  override controlChange(cc: number, value: number): void {
    if (cc === CC_MOD_WHEEL) this.modWheel = value;
  }

  override reset(): void {
    this.allocator.reset();
  }

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<Params>): void {
    if (this.allocator.hasPendingEvents) this.handleEvents(params, from);
    const bank = this.bank;
    if (!bank) return;
    const frameCount = to - from;
    this.renderCall++;
    this.paramsAreConstant = !this.hasAutomatedParam(params);
    this.advanceSharedState(params, from, frameCount);

    const outLeft = out[0] as Float32Array;
    const outRight = (out[1] ?? out[0]) as Float32Array;
    const master = dbToGain(at(params.level as Float32Array, from)) * 0.5;
    const voices = this.allocator.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as WavetableVoice;
      if (!voice.active) continue;
      this.renderVoice(voice, outLeft, outRight, params, from, frameCount, master, bank);
    }
  }

  /** Applies the queued note events with this block's voice mode and glide time. */
  private handleEvents(params: ParamBlock<Params>, frame: number): void {
    const mode = Math.round(this.param(params, 'voiceMode', frame));
    const glideSteps = Math.round((this.param(params, 'glide', frame) * this.sampleRate) / CONTROL);
    this.allocator.handleEvents(mode, glideSteps);
  }

  /** True when any param has a value per frame in this block (it is automated) rather than one for the block. */
  private hasAutomatedParam(params: ParamBlock<Params>): boolean {
    const names = this.paramNames;
    for (let k = 0; k < names.length; k++) {
      if ((params[names[k] as string] as Float32Array).length > 1) return true;
    }
    return false;
  }

  /** Moves what all voices share on by one block: the free-running LFO phases and the smoothed mod wheel. */
  private advanceSharedState(params: ParamBlock<Params>, from: number, frameCount: number): void {
    for (let lfo = 0; lfo < 2; lfo++) {
      const rateHz = at(params[LFO_IDS[lfo as 0 | 1].rate] as Float32Array, from);
      this.sharedLfoPhase[lfo] = ((this.sharedLfoPhase[lfo] as number) + (rateHz * frameCount) / this.sampleRate) % 1;
    }
    const wheelSmoothingSec = 0.02;
    this.modWheelSmoothed +=
      (this.modWheel - this.modWheelSmoothed) * Math.min(1, frameCount / (wheelSmoothingSec * this.sampleRate));
  }

  /** Renders one voice for the block: control steps every CONTROL samples, the samples in between. */
  private renderVoice(
    voice: WavetableVoice,
    outLeft: Float32Array,
    outRight: Float32Array,
    params: ParamBlock<Params>,
    from: number,
    frameCount: number,
    master: number,
    bank: WavetableBank,
  ): void {
    let done = 0;
    while (done < frameCount) {
      if (voice.countdown <= 0) {
        if (!this.control(voice, params, from + done, bank)) break;
        voice.countdown = CONTROL;
      }
      const segmentLength = Math.min(voice.countdown, frameCount - done);
      this.renderSegment(voice, outLeft, outRight, from + done, segmentLength, master);
      voice.countdown -= segmentLength;
      done += segmentLength;
    }
  }

  /** Synthesizes `count` samples of a voice into the output at `start`. */
  private renderSegment(
    voice: WavetableVoice,
    outLeft: Float32Array,
    outRight: Float32Array,
    start: number,
    count: number,
    master: number,
  ): void {
    const mixLeft = this.mixLeft;
    const mixRight = this.mixRight;
    mixLeft.fill(0, 0, count);
    mixRight.fill(0, 0, count);
    if (voice.osc1.isOn) addOscillatorToMix(voice.osc1, voice.unison, count, mixLeft, mixRight);
    if (voice.osc2.isOn) addOscillatorToMix(voice.osc2, voice.unison, count, mixLeft, mixRight);
    this.mixSubNoiseFilterAndPan(voice, outLeft, outRight, start, count, master);
  }

  /**
   * Adds the sub oscillator and noise to the oscillator mix, then drives and filters it and adds it into the
   * output with the voice's level and pan.
   */
  private mixSubNoiseFilterAndPan(
    voice: WavetableVoice,
    outLeft: Float32Array,
    outRight: Float32Array,
    start: number,
    count: number,
    master: number,
  ): void {
    const mixLeft = this.mixLeft;
    const mixRight = this.mixRight;
    const subGain = voice.subGain;
    const noiseGain = voice.noiseGain;
    const subShape = this.subShape;
    const drive = voice.drive;
    const driveMakeup = voice.driveMakeup;
    const isSteep = this.isFilterSteep;
    let gain = voice.gain;
    const gainStep = voice.gainStep;
    const panLeft = voice.panLeft * master;
    const panRight = voice.panRight * master;
    for (let s = 0; s < count; s++) {
      let centred = 0;
      if (subGain > 0) {
        const phase = voice.subPhase;
        const step = voice.subPhaseStep;
        let wave: number;
        if (subShape === 0) wave = Math.sin(2 * Math.PI * phase);
        else if (subShape === 1) wave = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
        else {
          // Square, with band-limited edges at the start of the cycle and at the half.
          wave = phase < 0.5 ? 1 : -1;
          wave += polyBlep(phase, step);
          let halfPhase = phase - 0.5;
          if (halfPhase < 0) halfPhase += 1;
          wave -= polyBlep(halfPhase, step);
        }
        centred += wave * subGain;
        let nextPhase = phase + step;
        if (nextPhase >= 1) nextPhase -= 1;
        voice.subPhase = nextPhase;
      }
      if (noiseGain > 0) {
        let coloured = voice.noiseState + voice.noiseCoefficient * (voice.noise.white() - voice.noiseState);
        if (!(Math.abs(coloured) > 1e-20)) coloured = 0;
        voice.noiseState = coloured;
        centred += coloured * noiseGain;
      }
      let left = (mixLeft[s] as number) + centred;
      let right = (mixRight[s] as number) + centred;
      if (drive > 0) {
        left = softClip(left * drive) * driveMakeup;
        right = softClip(right * drive) * driveMakeup;
      }
      left = voice.stage1Left.process(left);
      right = voice.stage1Right.process(right);
      if (isSteep) {
        left = voice.stage2Left.process(left);
        right = voice.stage2Right.process(right);
      }
      gain += gainStep;
      outLeft[start + s] = (outLeft[start + s] as number) + left * gain * panLeft;
      outRight[start + s] = (outRight[start + s] as number) + right * gain * panRight;
    }
    voice.gain = gain;
  }

  /**
   * One control step for a voice: sets a new voice up, runs its envelopes and LFOs, sums the mod
   * matrix, and computes pitch, wavetable frames, levels, pan and filter for the next CONTROL samples.
   * Returns false once the voice has finished.
   */
  private control(voice: WavetableVoice, params: ParamBlock<Params>, frame: number, bank: WavetableBank): boolean {
    if (voice.needsSetUp) this.setUp(voice, params, frame);
    if (!voice.ampEnv.active) {
      this.allocator.silence(voice);
      return false;
    }
    const settings = this.snapshot(params, frame);

    const ampLevel = voice.ampEnv.next();
    const modEnvLevel = voice.modEnv.next();
    voice.lfo1Value = this.lfoValue(voice.lfo1, settings.lfo[0] as LfoParams, frame, voice.lfo1RateFactor);
    voice.lfo2Value = this.lfoValue(voice.lfo2, settings.lfo[1] as LfoParams, frame, voice.lfo2RateFactor);

    sumModMatrix(this.modSums, settings, voice, modEnvLevel, this.modWheelSmoothed);
    const mods = this.modSums;
    // Modulation speeds an LFO up or down by up to 4 octaves.
    voice.lfo1RateFactor = mods[DEST_LFO1_RATE] === 0 ? 1 : Math.pow(2, 4 * (mods[DEST_LFO1_RATE] as number));
    voice.lfo2RateFactor = mods[DEST_LFO2_RATE] === 0 ? 1 : Math.pow(2, 4 * (mods[DEST_LFO2_RATE] as number));

    const semitones = this.stepPitch(voice, frame, mods[DEST_PITCH] as number);
    this.setUpOscillators(voice, settings, semitones, bank);
    this.setUpSubAndNoise(voice, settings, semitones);
    this.setUpFilter(voice, settings, modEnvLevel);
    this.setUpLevelAndPan(voice, settings, ampLevel);
    return true;
  }

  /**
   * Moves the voice's glide on by one control step and returns its pitch in semitones: the gliding note, the
   * channel pitch bend, the note's fine tuning and the pitch modulation (100% = 2 octaves).
   */
  private stepPitch(voice: WavetableVoice, frame: number, pitchMod: number): number {
    if (voice.glideStep < voice.glideSteps) {
      voice.glideStep++;
      voice.pitch = voice.glideFrom + ((voice.key - voice.glideFrom) * voice.glideStep) / voice.glideSteps;
    } else voice.pitch = voice.key;
    return voice.pitch + (at(this.pitch, frame) + voice.fineCents) / 100 + 24 * pitchMod;
  }

  /** Each oscillator's pitch, unison tuning and levels, and the wavetable frames it morphs between. */
  private setUpOscillators(
    voice: WavetableVoice,
    settings: ParamSnapshot,
    semitones: number,
    bank: WavetableBank,
  ): void {
    const unison = settings.unison;
    voice.unison = unison;
    for (let which = 0; which < 2; which++) {
      const osc = which === 0 ? voice.osc1 : voice.osc2;
      const params = settings.osc[which] as OscillatorParams;
      osc.isOn = params.level > 0;
      if (!osc.isOn) continue;
      const baseHz = 440 * Math.pow(2, (semitones + params.coarse + params.fine / 100 - 69) / 12);
      const highestStep = this.setUnisonTuningAndGains(osc, params, settings, baseHz, unison);
      const destination = which === 0 ? DEST_OSC1_POSITION : DEST_OSC2_POSITION;
      this.pickFrames(osc, params, this.modSums[destination] as number, highestStep, bank);
    }
  }

  /** Sets each unison copy's phase step and gains. Returns the largest step: it decides the mip level. */
  private setUnisonTuningAndGains(
    osc: OscillatorState,
    params: OscillatorParams,
    settings: ParamSnapshot,
    baseHz: number,
    unison: number,
  ): number {
    let highestStep = 0;
    for (let copy = 0; copy < unison; copy++) {
      const step = (baseHz * (settings.detuneRatio[copy] as number)) / this.sampleRate;
      osc.phaseStep[copy] = step;
      if (step > highestStep) highestStep = step;
      osc.gainLeft[copy] = params.gainLeft[copy] as number;
      osc.gainRight[copy] = params.gainRight[copy] as number;
    }
    return highestStep;
  }

  /**
   * Chooses the wavetable frames to morph between, at the mip level the highest unison copy needs (so it
   * does not alias), and how far between them the oscillator is.
   */
  private pickFrames(
    osc: OscillatorState,
    params: OscillatorParams,
    positionMod: number,
    highestStep: number,
    bank: WavetableBank,
  ): void {
    // Tables 0…tables−1 are the factory ones; the next index is the user's drawn table (the factory one 'basic'
    // until it arrives).
    const index = Math.max(0, Math.min(bank.tables, Math.round(params.table)));
    const isUserTable = index >= bank.tables && this.user !== null;
    const tableBank = isUserTable ? (this.user as WavetableBank) : bank;
    const table = isUserTable ? 0 : Math.min(index, bank.tables - 1);
    const position = Math.max(0, Math.min(1, params.position + positionMod));
    const framePosition = position * (tableBank.frames - 1);
    const lastPairStart = tableBank.frames - 2 < 0 ? 0 : tableBank.frames - 2;
    const firstFrame = Math.min(lastPairStart, Math.floor(framePosition));
    const morph = tableBank.frames > 1 ? framePosition - firstFrame : 0;
    const level = WavetableBank.levelFor(highestStep);
    const frameKey = isUserTable
      ? USER_KEY + (this.userEpoch * MAX_FRAMES_PER_TABLE + firstFrame) * MIP_LEVEL_SLOTS + level
      : (table * MAX_FRAMES_PER_TABLE + firstFrame) * MIP_LEVEL_SLOTS + level;
    if (frameKey !== osc.frameKey) {
      // Crossing to another frame pair (or level): continuous, since neighbours share a frame.
      osc.frameKey = frameKey;
      osc.data = tableBank.data;
      osc.frameAOffset = tableBank.offset(table, firstFrame, level);
      osc.frameBOffset = tableBank.offset(table, Math.min(tableBank.frames - 1, firstFrame + 1), level);
      osc.cycleSize = WavetableBank.size(level);
      osc.morph = morph;
      osc.morphStep = 0;
    } else osc.morphStep = (morph - osc.morph) / CONTROL;
  }

  /** The sub oscillator (an octave or two below the note) and the noise, both centred. */
  private setUpSubAndNoise(voice: WavetableVoice, settings: ParamSnapshot, semitones: number): void {
    const sampleRate = this.sampleRate;
    const subLevel = settings.subLevel;
    voice.subGain = subLevel * 0.7;
    this.subShape = settings.subShape;
    if (subLevel > 0) {
      // One octave down is half the note's frequency, two octaves a quarter.
      const frequencyRatio = settings.subOctave >= 0.5 ? 0.25 : 0.5;
      voice.subPhaseStep = Math.min(0.45, ((440 * Math.pow(2, (semitones - 69) / 12)) / sampleRate) * frequencyRatio);
    }
    const noiseLevel = settings.noiseLevel;
    voice.noiseGain = noiseLevel * 0.5;
    if (noiseLevel > 0) {
      // Tone sets the low-pass that colours the noise: 200 Hz (dark) to 20 kHz (bright).
      const toneHz = Math.min(MAX_FREQUENCY_SHARE * sampleRate, 200 * Math.pow(100, settings.noiseTone));
      voice.noiseCoefficient = 1 - Math.exp((-2 * Math.PI * toneHz) / sampleRate);
    }
  }

  /**
   * The filter: cutoff with key tracking, the envelope amount and modulation (in octaves), resonance, and the
   * drive in front of it.
   */
  private setUpFilter(voice: WavetableVoice, settings: ParamSnapshot, modEnvLevel: number): void {
    const sampleRate = this.sampleRate;
    const mods = this.modSums;
    const type = settings.filterType;
    this.isFilterSteep = type === FILTER_LP24;
    const octaves = CUTOFF_MOD_OCTAVES * (settings.envAmount * modEnvLevel + (mods[DEST_CUTOFF] as number));
    const trackedOctaves = (settings.keyTrack * (voice.pitch - 60)) / 12;
    const cutoffHz = Math.max(
      MIN_CUTOFF_HZ,
      Math.min(MAX_FREQUENCY_SHARE * sampleRate, settings.cutoff * Math.pow(2, octaves + trackedOctaves)),
    );
    const resonance = Math.max(0, Math.min(1, settings.resonance + (mods[DEST_RESONANCE] as number)));
    if (resonance !== this.lastResonance) {
      this.lastResonance = resonance;
      this.lastQ = 0.6 * Math.pow(30, resonance);
    }
    const q = this.lastQ;
    // Both channels share one filter design, which is only recomputed when it changes (a filter that
    // nothing modulates keeps the same cutoff for the whole note).
    if (type !== voice.filterType || cutoffHz !== voice.filterCutoff || q !== voice.filterQ) {
      voice.filterType = type;
      voice.filterCutoff = cutoffHz;
      voice.filterQ = q;
      this.designFilter(voice, type, cutoffHz, q);
    }
    const drive = settings.drive;
    voice.drive = drive > 0 ? 1 + 6 * drive : 0;
    voice.driveMakeup = drive > 0 ? 1 / softClip(voice.drive) : 1;
  }

  /** Sets the voice's filter stages for `type` (a position in FILTER_TYPES), mirrored into both channels. */
  private designFilter(voice: WavetableVoice, type: number, cutoffHz: number, q: number): void {
    const sampleRate = this.sampleRate;
    if (this.isFilterSteep) {
      // Two low-pass stages in a row: a gentle first, a resonant second.
      voice.stage1Left.set('lowpass', cutoffHz, 0.6, sampleRate);
      voice.stage1Right.copyDesign(voice.stage1Left);
      voice.stage2Left.set('lowpass', cutoffHz, q, sampleRate);
      voice.stage2Right.copyDesign(voice.stage2Left);
      return;
    }
    const kind =
      type === FILTER_HP ? 'highpass' : type === FILTER_BP ? 'bandpass' : type === FILTER_NOTCH ? 'notch' : 'lowpass';
    voice.stage1Left.set(kind, cutoffHz, q, sampleRate);
    voice.stage1Right.copyDesign(voice.stage1Left);
  }

  /** Level (envelope, velocity, modulation) gliding over the step, and pan. */
  private setUpLevelAndPan(voice: WavetableVoice, settings: ParamSnapshot, ampLevel: number): void {
    const mods = this.modSums;
    const velocitySensitivity = settings.velocity;
    const ampMod = Math.max(0, Math.min(2, 1 + (mods[DEST_AMP] as number)));
    const target = ampLevel * (1 - velocitySensitivity + velocitySensitivity * voice.velocity) * ampMod;
    voice.gainStep = (target - voice.gain) / CONTROL;
    const pan = Math.max(-1, Math.min(1, voice.notePan + (mods[DEST_PAN] as number)));
    voice.panLeft = Math.min(1, 1 - pan);
    voice.panRight = Math.min(1, 1 + pan);
  }

  /** The params at frame `frame` of this render call (one shared read per frame, or per call when constant). */
  private snapshot(params: ParamBlock<Params>, frame: number): ParamSnapshot {
    const snapshotFrame = this.paramsAreConstant ? 0 : frame;
    if (this.snapshotRenderCall !== this.renderCall || this.snapshotFrame !== snapshotFrame) {
      this.snapshotOfParams.read(params, frame);
      this.snapshotRenderCall = this.renderCall;
      this.snapshotFrame = snapshotFrame;
    }
    return this.snapshotOfParams;
  }

  /** The LFO's value: locked to the song while it plays when synced, else free-running. */
  private lfoValue(lfo: Lfo, params: LfoParams, frame: number, rateFactor: number): number {
    lfo.shape = LFO_SHAPES[params.shape] as LfoShape;
    const beats = LFO_BEATS[params.length] ?? 1;
    if (params.isSynced && this.transport.playing) return lfo.atBeat(this.transport.beatAt(frame), beats / rateFactor);
    const hz = params.isSynced ? this.transport.bpm / 60 / beats : params.rate;
    return lfo.next(hz * rateFactor);
  }

  /** One param's value at `frame` of the block. */
  private param(params: ParamBlock<Params>, id: string, frame: number): number {
    return at(params[id] as Float32Array, frame);
  }

  /** A new note's voice, at its first rendered frame. */
  private setUp(voice: WavetableVoice, params: ParamBlock<Params>, frame: number): void {
    voice.needsSetUp = false;
    // A voice taken over from a sounding note (or a mono retrigger) keeps its level and phases.
    const isTakenOver = voice.gain > 0;
    voice.ampEnv.set(
      this.param(params, 'ampAttack', frame),
      this.param(params, 'ampDecay', frame),
      this.param(params, 'ampSustain', frame),
      this.param(params, 'ampRelease', frame),
    );
    voice.modEnv.set(
      this.param(params, 'modAttack', frame),
      this.param(params, 'modDecay', frame),
      this.param(params, 'modSustain', frame),
      this.param(params, 'modRelease', frame),
    );
    if (!isTakenOver) this.clearVoiceState(voice);
    voice.ampEnv.start();
    voice.modEnv.start();
    for (let lfo = 0; lfo < 2; lfo++) {
      const ids = LFO_IDS[lfo as 0 | 1];
      const lfoOfVoice = lfo === 0 ? voice.lfo1 : voice.lfo2;
      lfoOfVoice.reset(this.param(params, ids.retrigger, frame) >= 0.5 ? 0 : (this.sharedLfoPhase[lfo] as number));
    }
  }

  /** Starts a fresh note from silence: envelopes, filters, noise and oscillator phases back to the start. */
  private clearVoiceState(voice: WavetableVoice): void {
    voice.ampEnv.reset();
    voice.modEnv.reset();
    voice.gain = 0;
    voice.subPhase = 0;
    voice.noiseState = 0;
    voice.stage1Left.reset();
    voice.stage1Right.reset();
    voice.stage2Left.reset();
    voice.stage2Right.reset();
    for (let which = 0; which < 2; which++) {
      const osc = which === 0 ? voice.osc1 : voice.osc2;
      osc.frameKey = -1;
      // One copy starts at phase 0 (a consistent attack); the other unison copies start anywhere.
      for (let copy = 0; copy < MAX_UNISON; copy++) osc.phase[copy] = copy === 0 ? 0 : this.host.rand();
    }
  }
}
