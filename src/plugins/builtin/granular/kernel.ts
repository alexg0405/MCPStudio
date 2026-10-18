import {
  at,
  dbToGain,
  InstrumentKernel,
  Readings,
  VoicePool,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { MAX_VOICES, SCAN_LENGTHS, TELEMETRY_GRAINS, telemetryNames, type GranularParams } from './params';
import { SHAPE_TABLES } from './shapes.kernel';
import { GRAINS_PER_VOICE, GrainSettings, GrainVoice, STEAL_FRAMES, type GrainSource } from './voice.kernel';

const MAX_EVENTS = 128;
const EVENT_SIZE = 6;
const EV_ON = 1;
const EV_OFF = 2;
const EV_ALL_OFF = 3;
const EV_ALL_OFF_HARD = 4;
/** The most frames rendered in one go (a block is normally 128; larger ones are cut into pieces of this size). */
const MAX_CHUNK = 2048;
/** How often the editor's grain dots are refreshed, per second (the posts go out at 30 a second). */
const TELEMETRY_HZ = 60;
/** The wide-open filter settings that skip filtering altogether. */
const FILTER_OFF = 0;
/** How much of the full-scale a note at full volume reaches: the grains of a cloud add up, so leave room. */
const MASTER = 2.5;
/** How far a random gap between grains may reach (a share of the average gap): never quite 0, so grains don't stack. */
const MAX_JITTER = 0.95;

/** A texture from the main thread: `{ type: 'texture', channels: [left, right], sampleRate }`. */
export interface TextureMessage {
  type: 'texture';
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * The Granular instrument's kernel: every note is a cloud of short grains cut from a sample (or a built-in texture)
 * at a position that can wander, scan or freeze, each grain with its own pitch, pan and direction. Grains start at
 * exact frames; all randomness is seeded, so two renders are identical.
 */
export class GranularKernel extends InstrumentKernel<GranularParams> {
  private readonly pool: VoicePool<GrainVoice>;
  private readonly settings = new GrainSettings();
  private readonly events = new Float64Array(MAX_EVENTS * EVENT_SIZE);
  private eventCount = 0;
  private sample: GrainSource | null = null;
  private texture: GrainSource | null = null;
  private source: GrainSource | null = null;
  private readonly bufLeft = new Float32Array(MAX_CHUNK);
  private readonly bufRight = new Float32Array(MAX_CHUNK);
  /** Where a free-running (stopped) synced scan is, as a fraction of one pass. */
  private freeScanPhase = 0;
  private notesStarted = 0;
  private spawnedTotal = 0;
  private lastSpawnPosition = 0;
  private readonly meter: Readings<string>;
  private meterCountdown = 0;
  private readonly meterEvery: number;
  private readonly positionNames: string[] = [];
  private readonly progressNames: string[] = [];
  private readonly panNames: string[] = [];

  constructor(host: KernelHost) {
    super(host);
    this.pool = new VoicePool(MAX_VOICES, () => new GrainVoice(host.sampleRate / 32));
    this.meter = new Readings(host, telemetryNames, 30);
    this.meterEvery = Math.round(host.sampleRate / TELEMETRY_HZ);
    for (let i = 0; i < TELEMETRY_GRAINS; i++) {
      this.positionNames.push(`gp${i}`);
      this.progressNames.push(`gq${i}`);
      this.panNames.push(`gx${i}`);
    }
  }

  // --- Setup and tests --------------------------------------------------------------------------------

  /** Grains started since the kernel was made (for tests and tools). */
  get grainsStarted(): number {
    return this.spawnedTotal;
  }

  /** Grains sounding right now, over all voices. */
  get grainsActive(): number {
    let n = 0;
    for (let v = 0; v < this.pool.voices.length; v++) n += (this.pool.voices[v] as GrainVoice).grainCount;
    return n;
  }

  /** The sample position (0–1) the most recent grain started at. */
  get lastGrainPosition(): number {
    return this.lastSpawnPosition;
  }

  override onSample(slot: string, channels: Float32Array[] | null, sampleRate: number): void {
    if (slot !== 'main') return;
    this.sample = this.makeSource(channels, sampleRate);
    this.chooseSource();
  }

  override onMessage(msg: unknown): void {
    const m = msg as Partial<TextureMessage> | null;
    if (m?.type !== 'texture' || !Array.isArray(m.channels)) return;
    this.texture = this.makeSource(m.channels, m.sampleRate ?? 48000);
    this.chooseSource();
  }

  private makeSource(channels: Float32Array[] | null, sampleRate: number): GrainSource | null {
    const left = channels?.[0];
    if (!left || left.length < 2) return null;
    const right = channels?.[1] ?? left;
    return {
      left,
      right,
      length: Math.min(left.length, right.length),
      mono: right === left,
      rateRatio: sampleRate / this.sampleRate,
    };
  }

  /** A loaded sample wins over the built-in texture. New audio ends the grains that were reading the old. */
  private chooseSource(): void {
    const next = this.sample ?? this.texture;
    if (next === this.source) return;
    this.source = next;
    for (let v = 0; v < this.pool.voices.length; v++) (this.pool.voices[v] as GrainVoice).clearGrains();
  }

  // --- Notes ------------------------------------------------------------------------------------------

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    this.push(EV_ON, noteId, key, velocity, pan, fine);
  }

  noteOff(noteId: number, key: number, _release: number): void {
    this.push(EV_OFF, noteId, key, 0, 0, 0);
  }

  override allNotesOff(hard: boolean): void {
    this.push(hard ? EV_ALL_OFF_HARD : EV_ALL_OFF, 0, 0, 0, 0, 0);
  }

  override reset(): void {
    this.eventCount = 0;
    for (let v = 0; v < this.pool.voices.length; v++) this.silence(this.pool.voices[v] as GrainVoice);
  }

  private push(type: number, id: number, key: number, velocity: number, pan: number, fine: number): void {
    if (this.eventCount >= MAX_EVENTS) return;
    const o = this.eventCount++ * EVENT_SIZE;
    const e = this.events;
    e[o] = type;
    e[o + 1] = id;
    e[o + 2] = key;
    e[o + 3] = velocity;
    e[o + 4] = pan;
    e[o + 5] = fine;
  }

  // --- Audio thread: nothing below allocates (checked by granular-kernel.test.ts) -------------------------

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<GranularParams>): void {
    if (this.eventCount > 0) this.handleEvents(p, from);
    const source = this.source;
    if (!source) return;
    const frames = to - from;
    this.readSettings(p, from);
    const table = SHAPE_TABLES[Math.round(at(p.shape, from))] ?? (SHAPE_TABLES[0] as Float32Array);
    const syncPhase = this.syncPhase(p, from, frames);
    const left = out[0] as Float32Array;
    const right = (out[1] ?? out[0]) as Float32Array;
    const voices = this.pool.voices;
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i] as GrainVoice;
      if (!voice.active) continue;
      if (voice.fresh) this.setUp(voice, p, from);
      for (let done = 0; done < frames; done += MAX_CHUNK) {
        const count = Math.min(MAX_CHUNK, frames - done);
        this.renderChunk(voice, source, table, syncPhase, p, from, left, right, from + done, count);
        if (!voice.active) break;
      }
    }
    this.report(frames);
  }

  /** Reads the knobs once per render call into the shared settings. */
  private readSettings(p: ParamBlock<GranularParams>, i: number): void {
    const s = this.settings;
    const sr = this.sampleRate;
    s.position = at(p.position, i);
    s.spray = at(p.spray, i);
    const sizeSec = at(p.size, i) / 1000;
    s.sizeFrames = Math.max(8, sizeSec * sr);
    s.density = at(p.density, i);
    s.jitter = at(p.jitter, i);
    s.reverse = at(p.reverse, i);
    s.pitchSemis = at(p.pitch, i) + at(p.fine, i) / 100;
    s.pitchSpray = at(p.pitchSpray, i);
    s.keyTrack = at(p.keyTrack, i);
    s.spread = at(p.spread, i);
    s.interval = sr / s.density;
    s.grainGain = 1 / Math.sqrt(Math.max(1, s.density * sizeSec));
    s.filterKind = Math.round(at(p.filterType, i));
    s.cutoffHz = Math.min(0.45 * sr, at(p.cutoff, i));
    s.q = 0.6 * Math.pow(30, at(p.resonance, i));
    s.velocitySense = at(p.velocity, i);
    s.levelGain = dbToGain(at(p.level, i)) * MASTER;
  }

  /**
   * Where the tempo-synced scan is (a fraction of one pass, 0–1): locked to the song while it plays, free-running
   * at the song's tempo while it is stopped (so previewing still moves). 0 when the scan is not synced.
   */
  private syncPhase(p: ParamBlock<GranularParams>, i: number, frames: number): number {
    if (at(p.scanSync, i) < 0.5) return 0;
    const beats = (SCAN_LENGTHS[Math.round(at(p.scanLength, i))] ?? SCAN_LENGTHS[2])[1];
    if (this.transport.playing) return (this.transport.beatAt(i) / beats) % 1;
    this.freeScanPhase = (this.freeScanPhase + (frames * this.transport.bpm) / 60 / beats / this.sampleRate) % 1;
    return this.freeScanPhase;
  }

  /** Renders `count` frames of one voice: moves the scan, starts grains, mixes them, filters and shapes the level. */
  private renderChunk(
    voice: GrainVoice,
    source: GrainSource,
    table: Float32Array,
    syncPhase: number,
    p: ParamBlock<GranularParams>,
    blockStart: number,
    left: Float32Array,
    right: Float32Array,
    start: number,
    count: number,
  ): void {
    const s = this.settings;
    const frozen = at(p.freeze, blockStart) >= 0.5;
    const scan = at(p.scan, blockStart);
    const synced = at(p.scanSync, blockStart) >= 0.5;
    let offset: number;
    if (frozen) offset = voice.heldOffset;
    else {
      if (synced) offset = (scan < 0 ? -1 : 1) * syncPhase;
      else {
        // 1x moves through the sample at its own speed: one second of sample per second.
        voice.scanOffset += (scan * count * source.rateRatio) / source.length;
        voice.scanOffset -= Math.floor(voice.scanOffset);
        offset = voice.scanOffset;
      }
      voice.heldOffset = offset;
    }

    const channelCents = at(this.pitch, blockStart);
    if (voice.env.active && voice.fadeLeft >= 0) {
      while (voice.countdown < count) {
        const delay = Math.max(0, voice.countdown);
        this.lastSpawnPosition = voice.spawn(s, source, offset, delay, channelCents);
        this.spawnedTotal++;
        const gap = 1 + MAX_JITTER * s.jitter * (2 * voice.random() - 1);
        voice.countdown += s.interval * gap;
      }
    }
    voice.countdown -= count;

    const bufL = this.bufLeft;
    const bufR = this.bufRight;
    bufL.fill(0, 0, count);
    bufR.fill(0, 0, count);
    voice.renderGrains(count, source, table, bufL, bufR);

    voice.setFilter(s, this.sampleRate);
    const filtered = s.filterKind !== FILTER_OFF;
    const velocityGain = 1 - s.velocitySense + s.velocitySense * voice.velocity;
    const gain = velocityGain * s.levelGain;
    for (let n = 0; n < count; n++) {
      let l = bufL[n] as number;
      let r = bufR[n] as number;
      if (filtered) {
        l = voice.filterLeft.process(l);
        r = voice.filterRight.process(r);
      }
      let g = voice.env.next() * gain;
      if (voice.fadeLeft > 0) {
        g *= voice.fadeLeft / STEAL_FRAMES;
        voice.fadeLeft--;
        if (voice.fadeLeft === 0) voice.fadeLeft = -1;
      }
      left[start + n] = (left[start + n] as number) + l * g;
      right[start + n] = (right[start + n] as number) + r * g;
    }
    if (!voice.env.active || voice.fadeLeft < 0) this.silence(voice);
  }

  /** The editor's grain dots: the newest grains' positions, progress and pan, a few dozen times a second. */
  private report(frames: number): void {
    this.meterCountdown -= frames;
    if (this.meterCountdown > 0) {
      this.meter.tick(frames);
      return;
    }
    this.meterCountdown += this.meterEvery;
    const values = this.meter.values;
    const source = this.source;
    const voices = this.pool.voices;
    let shown = 0;
    let sounding = 0;
    for (let g = 0; g < GRAINS_PER_VOICE; g++) {
      for (let v = 0; v < voices.length; v++) {
        const voice = voices[v] as GrainVoice;
        if (g === 0 && voice.active) sounding++;
        if (voice.isActive[g] === 0 || !voice.active || !source) continue;
        if (shown >= TELEMETRY_GRAINS) continue;
        values[this.positionNames[shown] as string] = (voice.position[g] as number) / source.length;
        values[this.progressNames[shown] as string] = (voice.fade[g] as number) / 1023;
        values[this.panNames[shown] as string] = voice.pan01[g] as number;
        shown++;
      }
    }
    for (let k = shown; k < TELEMETRY_GRAINS; k++) values[this.positionNames[k] as string] = -1;
    values.grains = shown;
    values.voices = sounding;
    this.meter.tick(frames);
  }

  /** A new note's voice, at its first rendered frame (with that block's settings). */
  private setUp(voice: GrainVoice, p: ParamBlock<GranularParams>, i: number): void {
    voice.fresh = false;
    voice.env.set(at(p.ampAttack, i), at(p.ampDecay, i), at(p.ampSustain, i), at(p.ampRelease, i));
    voice.env.reset();
    voice.env.start();
    voice.resetFilter();
    voice.clearGrains();
    voice.scanOffset = 0;
    voice.heldOffset = 0;
    voice.countdown = 0;
    // The seed knob and the count of notes so far choose the cloud: repeatable, but every note differs.
    voice.seedRandom(Math.imul(at(p.seed, i) + 1, 0x9e3779b1) ^ Math.imul(++this.notesStarted, 0x85ebca6b));
  }

  private silence(voice: GrainVoice): void {
    this.pool.free(voice);
    voice.fresh = false;
    voice.fadeLeft = 0;
    voice.env.reset();
    voice.clearGrains();
  }

  /** Starts and releases voices for the queued note events. */
  private handleEvents(p: ParamBlock<GranularParams>, i: number): void {
    const maxVoices = Math.max(1, Math.min(MAX_VOICES, Math.round(at(p.voices, i))));
    const e = this.events;
    for (let n = 0; n < this.eventCount; n++) {
      const o = n * EVENT_SIZE;
      const type = e[o] as number;
      if (type === EV_ON)
        this.start(e[o + 1] as number, e[o + 2] as number, e[o + 3] as number, e[o + 4] as number, e[o + 5] as number, maxVoices);
      else if (type === EV_OFF) this.stop(e[o + 1] as number);
      else this.stopAll(type === EV_ALL_OFF_HARD);
    }
    this.eventCount = 0;
  }

  private start(id: number, key: number, velocity: number, pan: number, fine: number, maxVoices: number): void {
    // Over the voice limit: the oldest note makes way with a short fade.
    while (this.pool.activeCount - this.fadingCount() >= maxVoices) {
      const oldest = this.oldestSounding();
      if (!oldest) break;
      oldest.fadeLeft = STEAL_FRAMES;
    }
    const voice = this.pool.start(id, key);
    voice.fresh = true;
    voice.velocity = velocity;
    voice.pan = pan;
    voice.fine = fine;
    voice.fadeLeft = 0;
  }

  private fadingCount(): number {
    let n = 0;
    const voices = this.pool.voices;
    for (let v = 0; v < voices.length; v++) {
      const voice = voices[v] as GrainVoice;
      if (voice.active && voice.fadeLeft !== 0) n++;
    }
    return n;
  }

  private oldestSounding(): GrainVoice | null {
    let oldest: GrainVoice | null = null;
    const voices = this.pool.voices;
    for (let v = 0; v < voices.length; v++) {
      const voice = voices[v] as GrainVoice;
      if (!voice.active || voice.fadeLeft !== 0) continue;
      if (!oldest || voice.age < oldest.age) oldest = voice;
    }
    return oldest;
  }

  private stop(id: number): void {
    const voice = this.pool.find(id);
    if (!voice) return;
    // Released before it ever sounded: the note was cancelled.
    if (voice.fresh) {
      this.silence(voice);
      return;
    }
    voice.releasing = true;
    voice.env.release();
  }

  private stopAll(hard: boolean): void {
    const voices = this.pool.voices;
    for (let v = 0; v < voices.length; v++) {
      const voice = voices[v] as GrainVoice;
      if (!voice.active) continue;
      if (hard) this.silence(voice);
      else if (voice.fresh) this.silence(voice);
      else {
        voice.releasing = true;
        voice.env.release();
      }
    }
  }
  // --- End of the audio thread's code -------------------------------------------------------------------
}
