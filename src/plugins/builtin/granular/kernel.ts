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
const EVENT_NOTE_ON = 1;
const EVENT_NOTE_OFF = 2;
const EVENT_ALL_OFF = 3;
const EVENT_ALL_OFF_HARD = 4;
/** The most frames rendered in one go (a block is normally 128; larger ones are cut into pieces of this size). */
const MAX_CHUNK_FRAMES = 2048;
/** How often the editor's grain dots are refreshed, per second (the posts go out at 30 a second). */
const TELEMETRY_HZ = 60;
/** The wide-open filter settings that skip filtering altogether. */
const FILTER_OFF = 0;
/** How much of the full-scale a note at full volume reaches: the grains of a cloud add up, so leave room. */
const MASTER_GAIN = 2.5;
/** How far a random gap between grains may reach (a share of the average gap): never quite 0, so grains don't stack. */
const MAX_JITTER_SHARE = 0.95;

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
  private readonly chunkLeft = new Float32Array(MAX_CHUNK_FRAMES);
  private readonly chunkRight = new Float32Array(MAX_CHUNK_FRAMES);
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
    this.push(EVENT_NOTE_ON, noteId, key, velocity, pan, fine);
  }

  noteOff(noteId: number, key: number, _release: number): void {
    this.push(EVENT_NOTE_OFF, noteId, key, 0, 0, 0);
  }

  override allNotesOff(hard: boolean): void {
    this.push(hard ? EVENT_ALL_OFF_HARD : EVENT_ALL_OFF, 0, 0, 0, 0, 0);
  }

  override reset(): void {
    this.eventCount = 0;
    for (let voiceIndex = 0; voiceIndex < this.pool.voices.length; voiceIndex++)
      this.silence(this.pool.voices[voiceIndex] as GrainVoice);
  }

  private push(type: number, id: number, key: number, velocity: number, pan: number, fine: number): void {
    if (this.eventCount >= MAX_EVENTS) return;
    const offset = this.eventCount++ * EVENT_SIZE;
    const events = this.events;
    events[offset] = type;
    events[offset + 1] = id;
    events[offset + 2] = key;
    events[offset + 3] = velocity;
    events[offset + 4] = pan;
    events[offset + 5] = fine;
  }

  // --- Audio thread: nothing below allocates (checked by granular-kernel.test.ts) -------------------------

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<GranularParams>): void {
    if (this.eventCount > 0) this.handleEvents(params, from);
    const source = this.source;
    if (!source) return;
    const frames = to - from;
    this.readSettings(params, from);
    const table = SHAPE_TABLES[Math.round(at(params.shape, from))] ?? (SHAPE_TABLES[0] as Float32Array);
    const syncPhase = this.syncPhase(params, from, frames);
    const left = out[0] as Float32Array;
    const right = (out[1] ?? out[0]) as Float32Array;
    const voices = this.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as GrainVoice;
      if (!voice.active) continue;
      if (voice.fresh) this.setUp(voice, params, from);
      for (let done = 0; done < frames; done += MAX_CHUNK_FRAMES) {
        const count = Math.min(MAX_CHUNK_FRAMES, frames - done);
        this.renderChunk(voice, source, table, syncPhase, params, from, left, right, from + done, count);
        if (!voice.active) break;
      }
    }
    this.report(frames);
  }

  /** Reads the knobs once per render call into the shared settings. */
  private readSettings(params: ParamBlock<GranularParams>, frame: number): void {
    const settings = this.settings;
    const sampleRate = this.sampleRate;
    settings.position = at(params.position, frame);
    settings.spray = at(params.spray, frame);
    const sizeSec = at(params.size, frame) / 1000;
    settings.sizeFrames = Math.max(8, sizeSec * sampleRate);
    settings.density = at(params.density, frame);
    settings.jitter = at(params.jitter, frame);
    settings.reverse = at(params.reverse, frame);
    settings.pitchSemis = at(params.pitch, frame) + at(params.fine, frame) / 100;
    settings.pitchSpray = at(params.pitchSpray, frame);
    settings.keyTrack = at(params.keyTrack, frame);
    settings.spread = at(params.spread, frame);
    settings.interval = sampleRate / settings.density;
    settings.grainGain = 1 / Math.sqrt(Math.max(1, settings.density * sizeSec));
    settings.filterKind = Math.round(at(params.filterType, frame));
    settings.cutoffHz = Math.min(0.45 * sampleRate, at(params.cutoff, frame));
    settings.q = 0.6 * Math.pow(30, at(params.resonance, frame));
    settings.velocitySense = at(params.velocity, frame);
    settings.levelGain = dbToGain(at(params.level, frame)) * MASTER_GAIN;
  }

  /**
   * Where the tempo-synced scan is (a fraction of one pass, 0–1): locked to the song while it plays, free-running
   * at the song's tempo while it is stopped (so previewing still moves). 0 when the scan is not synced.
   */
  private syncPhase(params: ParamBlock<GranularParams>, frame: number, frames: number): number {
    if (at(params.scanSync, frame) < 0.5) return 0;
    const beats = (SCAN_LENGTHS[Math.round(at(params.scanLength, frame))] ?? SCAN_LENGTHS[2])[1];
    if (this.transport.playing) return (this.transport.beatAt(frame) / beats) % 1;
    this.freeScanPhase = (this.freeScanPhase + (frames * this.transport.bpm) / 60 / beats / this.sampleRate) % 1;
    return this.freeScanPhase;
  }

  /** Renders `count` frames of one voice: moves the scan, starts grains, mixes them, filters and shapes the level. */
  private renderChunk(
    voice: GrainVoice,
    source: GrainSource,
    table: Float32Array,
    syncPhase: number,
    params: ParamBlock<GranularParams>,
    blockStart: number,
    left: Float32Array,
    right: Float32Array,
    start: number,
    count: number,
  ): void {
    const settings = this.settings;
    const isFrozen = at(params.freeze, blockStart) >= 0.5;
    const scanSpeed = at(params.scan, blockStart);
    const isSynced = at(params.scanSync, blockStart) >= 0.5;
    let offset: number;
    if (isFrozen) offset = voice.heldOffset;
    else {
      if (isSynced) offset = (scanSpeed < 0 ? -1 : 1) * syncPhase;
      else {
        // 1x moves through the sample at its own speed: one second of sample per second.
        voice.scanOffset += (scanSpeed * count * source.rateRatio) / source.length;
        voice.scanOffset -= Math.floor(voice.scanOffset);
        offset = voice.scanOffset;
      }
      voice.heldOffset = offset;
    }

    const channelCents = at(this.pitch, blockStart);
    if (voice.env.active && voice.fadeLeft >= 0) {
      while (voice.countdown < count) {
        const delay = Math.max(0, voice.countdown);
        this.lastSpawnPosition = voice.spawn(settings, source, offset, delay, channelCents);
        this.spawnedTotal++;
        const gap = 1 + MAX_JITTER_SHARE * settings.jitter * (2 * voice.random() - 1);
        voice.countdown += settings.interval * gap;
      }
    }
    voice.countdown -= count;

    const mixLeft = this.chunkLeft;
    const mixRight = this.chunkRight;
    mixLeft.fill(0, 0, count);
    mixRight.fill(0, 0, count);
    voice.renderGrains(count, source, table, mixLeft, mixRight);

    voice.setFilter(settings, this.sampleRate);
    const isFiltered = settings.filterKind !== FILTER_OFF;
    const velocityGain = 1 - settings.velocitySense + settings.velocitySense * voice.velocity;
    const gain = velocityGain * settings.levelGain;
    for (let frameInChunk = 0; frameInChunk < count; frameInChunk++) {
      let leftSample = mixLeft[frameInChunk] as number;
      let rightSample = mixRight[frameInChunk] as number;
      if (isFiltered) {
        leftSample = voice.filterLeft.process(leftSample);
        rightSample = voice.filterRight.process(rightSample);
      }
      let envelopeGain = voice.env.next() * gain;
      if (voice.fadeLeft > 0) {
        envelopeGain *= voice.fadeLeft / STEAL_FRAMES;
        voice.fadeLeft--;
        if (voice.fadeLeft === 0) voice.fadeLeft = -1;
      }
      left[start + frameInChunk] = (left[start + frameInChunk] as number) + leftSample * envelopeGain;
      right[start + frameInChunk] = (right[start + frameInChunk] as number) + rightSample * envelopeGain;
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
    for (let grain = 0; grain < GRAINS_PER_VOICE; grain++) {
      for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
        const voice = voices[voiceIndex] as GrainVoice;
        if (grain === 0 && voice.active) sounding++;
        if (voice.isActive[grain] === 0 || !voice.active || !source) continue;
        if (shown >= TELEMETRY_GRAINS) continue;
        values[this.positionNames[shown] as string] = (voice.position[grain] as number) / source.length;
        values[this.progressNames[shown] as string] = (voice.fade[grain] as number) / 1023;
        values[this.panNames[shown] as string] = voice.pan01[grain] as number;
        shown++;
      }
    }
    for (let k = shown; k < TELEMETRY_GRAINS; k++) values[this.positionNames[k] as string] = -1;
    values.grains = shown;
    values.voices = sounding;
    this.meter.tick(frames);
  }

  /** A new note's voice, at its first rendered frame (with that block's settings). */
  private setUp(voice: GrainVoice, params: ParamBlock<GranularParams>, frame: number): void {
    voice.fresh = false;
    voice.env.set(
      at(params.ampAttack, frame),
      at(params.ampDecay, frame),
      at(params.ampSustain, frame),
      at(params.ampRelease, frame),
    );
    voice.env.reset();
    voice.env.start();
    voice.resetFilter();
    voice.clearGrains();
    voice.scanOffset = 0;
    voice.heldOffset = 0;
    voice.countdown = 0;
    // The seed knob and the count of notes so far choose the cloud: repeatable, but every note differs.
    voice.seedRandom(Math.imul(at(params.seed, frame) + 1, 0x9e3779b1) ^ Math.imul(++this.notesStarted, 0x85ebca6b));
  }

  private silence(voice: GrainVoice): void {
    this.pool.free(voice);
    voice.fresh = false;
    voice.fadeLeft = 0;
    voice.env.reset();
    voice.clearGrains();
  }

  /** Starts and releases voices for the queued note events. */
  private handleEvents(params: ParamBlock<GranularParams>, frame: number): void {
    const maxVoices = Math.max(1, Math.min(MAX_VOICES, Math.round(at(params.voices, frame))));
    const events = this.events;
    for (let eventIndex = 0; eventIndex < this.eventCount; eventIndex++) {
      const offset = eventIndex * EVENT_SIZE;
      const type = events[offset] as number;
      if (type === EVENT_NOTE_ON)
        this.start(
          events[offset + 1] as number,
          events[offset + 2] as number,
          events[offset + 3] as number,
          events[offset + 4] as number,
          events[offset + 5] as number,
          maxVoices,
        );
      else if (type === EVENT_NOTE_OFF) this.stop(events[offset + 1] as number);
      else this.stopAll(type === EVENT_ALL_OFF_HARD);
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
    let count = 0;
    const voices = this.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as GrainVoice;
      if (voice.active && voice.fadeLeft !== 0) count++;
    }
    return count;
  }

  private oldestSounding(): GrainVoice | null {
    let oldest: GrainVoice | null = null;
    const voices = this.pool.voices;
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as GrainVoice;
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
    for (let voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
      const voice = voices[voiceIndex] as GrainVoice;
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
