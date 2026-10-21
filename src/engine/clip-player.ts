import { GraphVoices, type InstrumentInstance, type NoteOff, type NoteOn, type Sleeper } from '@agstudio/sdk';
import {
  sourceRateAt,
  sourceSecondsAt,
  stretchScale,
  tickAtSourceSeconds,
  type PlaybackMode,
} from '@core/audio/playback';
import type { AudioClip } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import {
  previewGainSchedule,
  releaseGain,
  RELEASE_SEC,
  scheduleClipGain,
  snapToWholeFrame,
  type GainSchedule,
} from './clip-voice-schedule';
import type { AudioOn } from './sched/transport';

/** Lead time of a start or switch once a buffer became ready (late sample, stretched copy), in seconds. */
const SWAP_LEAD_SEC = 0.03;
/** A voice that is replaced by a restarted one is still read this long after the swap (its crossfade), in seconds. */
const SWAP_OVERLAP_SEC = 0.1;
/** At most this many tempo changes are scheduled per clip start (a long clip under a tempo ramp). */
const MAX_RATE_EVENTS = 4096;
/** A finished voice's bookkeeping is kept this long before `sweep` forgets it (seconds). */
const FORGET_FINISHED_AFTER_SEC = 1;
/** A buffer is released this long after its voice has finished (seconds). */
const HOLD_RELEASE_GRACE_SEC = 0.05;
/** A buffer stays held a little past its voice's end (seconds), so the release ramp is covered. */
const HOLD_PAD_SEC = 0.01;
/** A source node is stopped this long after its release ramp (seconds): once the ramp has reached silence. */
const STOP_AFTER_RELEASE_SEC = 0.001;
/** At most this many clip voices sound at once on one channel. */
const MAX_VOICES = 16;
/** Seconds of tail an audio clip channel adds after its last clip (the release ramp). */
const TAIL_SEC = 0.05;

/** The "instrument" of an audio clip channel. */
export interface ClipPlayer extends InstrumentInstance {
  /** A playlist clip starts (or playback starts inside it). */
  startClip(e: AudioOn): void;
  /**
   * Buffers became available: clips waiting for their sample start where the song is now (in time),
   * clips playing the plain sample switch to their stretched copy, held previews start.
   */
  refresh(): void;
  /** Lets go of the buffers of voices that have finished (call it now and then). */
  sweep(): void;
}

/** Where a clip player's audio comes from (the channel strip, through sample-residency.ts). */
export interface ClipSources {
  mode(): PlaybackMode;
  /**
   * The sample as played (reversed when reverse is on) and its cache key; null while it isn't decoded.
   * A clip with a pitch correction plays the render of it (`pitchEdit.renderedSampleId`) instead of
   * the channel's own sample; without a clip it is the channel's.
   */
  base(clip?: AudioClip): { buffer: AudioBuffer; key: string } | null;
  /**
   * The clip's time-stretched copy at `scale`: its buffer, key and the second of the sample its first frame is. `tempo` is
   * the tempo map the clip plays under (a clip of the clip launcher is found by the part of the sample it plays).
   */
  stretched(clip: AudioClip, scale: number, tempo: TempoMap): { buffer: AudioBuffer; key: string; from: number } | null;
  /** Voices wait for buffers: make sure they are on their way. */
  request(clip?: AudioClip): void;
  /** Keeps a buffer in memory while a voice reads it; returns the release. */
  hold(key: string): () => void;
}

/** Where a clip voice is in getting its sound. */
type VoiceState = 'waiting' | 'fallback' | 'ok';

/** A clip that has been asked to start and may still need to (re)start when its buffers arrive. */
interface LiveClip {
  /** The start of this voice (time and tick it was started at). */
  start: AudioOn;
  scale: number;
  /** waiting: no sample yet (it starts in time once it arrives); fallback: the plain sample until the stretched copy is ready. */
  state: VoiceState;
  /** Context time it ends at the latest (clip end or end of the sound). */
  end: number;
}

/** A buffer a voice reads, kept in memory until the voice has finished. */
interface BufferHold {
  release(): void;
  /** Context time after which the buffer is no longer read. */
  until: number;
}

/** The buffer a clip voice plays and how it relates to the sample. */
interface ClipSource {
  buffer: AudioBuffer;
  /** The cache key of the buffer (held while the voice reads it). */
  key: string;
  /** Playing speed of the buffer against the sample: the stretch scale for a stretched copy, else 1. */
  factor: number;
  /** Seconds into the buffer where the voice starts. */
  offset: number;
  /** Seconds of the sample where the sound ends. */
  soundEndSec: number;
  /** The plain sample plays until the stretched copy is ready. */
  isFallback: boolean;
}

/**
 * Plays an audio clip channel's sample for each clip: from the clip's trim (`offsetSec`), with the
 * clip's gain and fades (envelope ramps), the channel's pitch, reverse and tempo follow
 * (core/audio/playback.ts). 'resample' and 'stretch' change speed at every tempo change; 'stretch'
 * plays the clip's WSOLA copy and, while that is being made, the plain sample in time (then switches
 * over with a short crossfade). A clip whose sample isn't decoded yet (long songs are loaded around
 * the playhead) starts as soon as it is, at the spot the song has reached by then: it never plays
 * late. The transport's noteOff at the clip end (or a loop wrap, stop or seek) releases a voice.
 * Every voice pins the buffer it reads until it has finished, so eviction never takes audio that is
 * playing.
 */
class AudioClipPlayer implements ClipPlayer {
  readonly output: GainNode;
  readonly tailTime = TAIL_SEC;
  readonly sleep: Sleeper;
  private readonly voices: GraphVoices;
  private readonly live = new Map<number, LiveClip>();
  private readonly holds = new Map<number, BufferHold[]>();
  /** Previews waiting for the sample (the key is held down while it decodes). */
  private readonly pendingPreviews = new Map<number, NoteOn>();
  private disposed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly sources: ClipSources,
  ) {
    this.output = new GainNode(ctx);
    this.voices = new GraphVoices(ctx, this.output, { max: MAX_VOICES });
    this.sleep = this.voices.sleep;
  }

  // ---- Playlist clips ----

  startClip(e: AudioOn): void {
    if (this.disposed) return;
    const mode = this.sources.mode();
    const { clip, tempo } = e;
    const now = this.ctx.currentTime;
    this.sweep();
    // Late events start further into the clip so they stay in time.
    const time = Math.max(e.time, now);
    const tick = time > e.time ? tempo.secondsToTick(tempo.tickToSeconds(e.tick) + (time - e.time)) : e.tick;
    const clipEndTick = clip.start + clip.length;
    if (tick >= clipEndTick) return;
    const startSec = tempo.tickToSeconds(tick);
    const timeOfTick = (tk: number) => time + tempo.tickToSeconds(tk) - startSec;
    const scale = mode.follow === 'stretch' ? stretchScale(mode, tempo, clip.start) : 1;
    const copy = scale === 1 ? null : this.sources.stretched(clip, scale, tempo);
    const base = copy ? null : this.sources.base(clip);
    const started = { ...e, time, tick };
    if (!copy && !base) {
      // Not decoded yet: wait for it (it starts at the song's position then).
      this.live.set(e.noteId, { start: started, scale, state: 'waiting', end: timeOfTick(clipEndTick) });
      this.sources.request(clip);
      return;
    }
    const sourceSec = Math.max(0, sourceSecondsAt(clip, mode, tempo, tick));
    const source = chooseSource(copy, base, scale, sourceSec);
    if (!source) return;
    const rateAtTick = (tk: number) => source.factor * sourceRateAt(mode, tempo, tk);
    const steady = mode.follow === 'off' || tempo.constant;
    const bufferStart = snapToWholeFrame(
      rateAtTick(tick),
      time,
      source.offset,
      now,
      steady,
      source.buffer.sampleRate,
      this.ctx.sampleRate,
    );
    const node = new AudioBufferSourceNode(this.ctx, { buffer: source.buffer, playbackRate: bufferStart.rate });
    if (mode.follow !== 'off' && !tempo.constant) {
      this.scheduleRateChanges(node, tempo, tick, clipEndTick, rateAtTick, timeOfTick);
    }
    const clipSec = tempo.tickToSeconds(clip.start);
    const clipSeconds = tempo.tickToSeconds(clipEndTick) - clipSec;
    const voiceGain = new GainNode(this.ctx, { gain: 0 });
    const schedule = scheduleClipGain(voiceGain.gain, clip, clipSeconds, startSec - clipSec, sourceSec, time);
    node.connect(voiceGain);
    node.start(bufferStart.startAt, bufferStart.startOffset);
    const soundEndTick = tickAtSourceSeconds(clip, mode, tempo, source.soundEndSec);
    const end = timeOfTick(Math.min(clipEndTick, soundEndTick));
    this.addVoice(e.noteId, time, node, voiceGain, schedule, end + RELEASE_SEC, { stopSource: true });
    this.hold(e.noteId, source.key, end + RELEASE_SEC + HOLD_PAD_SEC);
    this.live.set(e.noteId, { start: started, scale, state: source.isFallback ? 'fallback' : 'ok', end });
    if (source.isFallback) this.sources.request(clip);
  }

  /** Follows the tempo: the playback rate changes at every tempo change of the clip (up to MAX_RATE_EVENTS). */
  private scheduleRateChanges(
    node: AudioBufferSourceNode,
    tempo: TempoMap,
    fromTick: number,
    clipEndTick: number,
    rateAtTick: (tick: number) => number,
    timeOfTick: (tick: number) => number,
  ): void {
    let events = 0;
    for (let tk = tempo.nextChange(fromTick); tk < clipEndTick && events < MAX_RATE_EVENTS; tk = tempo.nextChange(tk), events++) {
      node.playbackRate.setValueAtTime(rateAtTick(tk), timeOfTick(tk));
    }
  }

  /** Hands a started source and its gain to the voice pool, with the release that fades it out. */
  private addVoice(
    noteId: number,
    startTime: number,
    node: AudioBufferSourceNode,
    gainNode: GainNode,
    schedule: GainSchedule,
    endTime: number,
    options: { stopSource: boolean },
  ): void {
    this.voices.add(noteId, {
      start: startTime,
      sources: [node],
      out: gainNode,
      end: endTime,
      release: (releaseTime) => {
        releaseGain(gainNode.gain, schedule, releaseTime);
        if (!options.stopSource) return releaseTime + RELEASE_SEC + STOP_AFTER_RELEASE_SEC;
        stopAt(node, releaseTime + RELEASE_SEC + STOP_AFTER_RELEASE_SEC);
        return releaseTime + RELEASE_SEC + STOP_AFTER_RELEASE_SEC;
      },
    });
  }

  // ---- Previews ----

  /** Previews (and transports without clip info): the sample from `offset`, at the channel's pitch. */
  noteOn(e: NoteOn): void {
    if (this.disposed) return;
    const base = this.sources.base();
    if (!base) {
      this.pendingPreviews.set(e.noteId, e);
      this.sources.request();
      return;
    }
    const { time, noteId, offset } = e;
    const mode = this.sources.mode();
    const buffer = base.buffer;
    const startTime = Math.max(time, this.ctx.currentTime);
    const startOffset = Math.max(0, (offset ?? 0) + (startTime - time) * mode.pitch);
    if (startOffset >= buffer.duration) return;
    const node = new AudioBufferSourceNode(this.ctx, { buffer, playbackRate: mode.pitch });
    const voiceGain = new GainNode(this.ctx, { gain: 0 });
    node.connect(voiceGain);
    const schedule = previewGainSchedule(startTime);
    voiceGain.gain.setValueAtTime(0, startTime);
    voiceGain.gain.linearRampToValueAtTime(1, schedule[1]![0]);
    node.start(startTime, startOffset);
    const end = startTime + (buffer.duration - startOffset) / mode.pitch;
    this.addVoice(noteId, startTime, node, voiceGain, schedule, end, { stopSource: false });
    this.hold(noteId, base.key, end + HOLD_PAD_SEC);
  }

  noteOff({ noteId, time }: NoteOff): void {
    this.live.delete(noteId);
    this.pendingPreviews.delete(noteId);
    this.voices.release(noteId, time);
    this.endHolds(noteId, Math.max(time, this.ctx.currentTime) + RELEASE_SEC + HOLD_PAD_SEC);
  }

  allNotesOff(time: number, hard?: boolean): void {
    this.live.clear();
    this.pendingPreviews.clear();
    this.voices.releaseAll(time, hard);
    for (const noteId of this.holds.keys()) {
      this.endHolds(noteId, Math.max(time, this.ctx.currentTime) + RELEASE_SEC + HOLD_PAD_SEC);
    }
  }

  // ---- Buffers arriving ----

  refresh(): void {
    if (this.disposed) return;
    const at = this.ctx.currentTime + SWAP_LEAD_SEC;
    for (const clip of [...this.live.values()]) this.restartIfReady(clip, at);
    this.startPendingPreviews();
  }

  /** A waiting clip starts, or one playing the plain sample switches to its stretched copy, once that buffer is there. */
  private restartIfReady(clip: LiveClip, at: number): void {
    if (clip.state === 'ok' || at >= clip.end) return;
    const { tempo } = clip.start;
    const copy = clip.scale !== 1 ? this.sources.stretched(clip.start.clip, clip.scale, tempo) : null;
    if (clip.state === 'waiting' && !copy && !this.sources.base(clip.start.clip)) return;
    if (clip.state === 'fallback' && !copy) return;
    const tick = tempo.secondsToTick(tempo.tickToSeconds(clip.start.tick) + (at - clip.start.time));
    // Same note id: the voice replaces the old one, which fades out as it fades in.
    this.startClip({ ...clip.start, time: at, tick });
  }

  /** Previews that waited for the sample start where they would be by now. */
  private startPendingPreviews(): void {
    if (this.pendingPreviews.size === 0 || !this.sources.base()) return;
    const now = this.ctx.currentTime;
    for (const [id, e] of [...this.pendingPreviews]) {
      this.pendingPreviews.delete(id);
      this.noteOn({ ...e, time: now, offset: (e.offset ?? 0) + (now - e.time) * this.sources.mode().pitch });
    }
  }

  // ---- Memory ----

  /** Lets go of finished voices' bookkeeping and of the buffers nothing reads any more. */
  sweep(): void {
    const now = this.ctx.currentTime;
    for (const [id, clip] of this.live) if (clip.end < now - FORGET_FINISHED_AFTER_SEC) this.live.delete(id);
    for (const [id, list] of this.holds) {
      const kept = list.filter((hold) => {
        if (hold.until >= now - HOLD_RELEASE_GRACE_SEC) return true;
        hold.release();
        return false;
      });
      if (kept.length === 0) this.holds.delete(id);
      else this.holds.set(id, kept);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.live.clear();
    this.pendingPreviews.clear();
    this.voices.disposeAll();
    this.output.disconnect();
    for (const list of this.holds.values()) for (const hold of list) hold.release();
    this.holds.clear();
  }

  /** Keeps the buffer in memory for a voice until `until` (context time). */
  private hold(noteId: number, key: string, until: number): void {
    let list = this.holds.get(noteId);
    if (!list) this.holds.set(noteId, (list = []));
    // A restarted voice (swap) replaces the old one, which is read until its crossfade has ended.
    for (const old of list) old.until = Math.min(old.until, this.ctx.currentTime + SWAP_LEAD_SEC + SWAP_OVERLAP_SEC);
    list.push({ release: this.sources.hold(key), until });
  }

  private endHolds(noteId: number, at: number): void {
    for (const hold of this.holds.get(noteId) ?? []) hold.until = Math.min(hold.until, at);
  }
}

function stopAt(node: AudioScheduledSourceNode, time: number): void {
  try {
    node.stop(time);
  } catch {
    /* already stopped */
  }
}

/**
 * Picks what a voice plays: the stretched copy when there is one, else the plain sample (which stands in until the
 * copy is ready, when the clip follows the tempo by stretching). Null when the clip starts after the sound has ended.
 */
function chooseSource(
  copy: { buffer: AudioBuffer; key: string; from: number } | null,
  base: { buffer: AudioBuffer; key: string } | null,
  scale: number,
  sourceSec: number,
): ClipSource | null {
  // Where the sound ends: the sample's end, or the end of what the stretched copy covers (its
  // range is clamped to the sample; otherwise it reaches past the clip, which ends first).
  const soundEndSec = copy ? copy.from + copy.buffer.duration / scale : base!.buffer.duration;
  if (sourceSec >= soundEndSec) return null;
  if (copy) {
    // Seconds into the buffer the voice starts at (a stretched copy begins at `copy.from` of the sample).
    const offset = Math.max(0, sourceSec - copy.from) * scale;
    return { buffer: copy.buffer, key: copy.key, factor: scale, offset, soundEndSec, isFallback: false };
  }
  return { buffer: base!.buffer, key: base!.key, factor: 1, offset: sourceSec, soundEndSec, isFallback: scale !== 1 };
}

/** Creates the player of an audio clip channel (see AudioClipPlayer). */
export function createClipPlayer(ctx: BaseAudioContext, sources: ClipSources): ClipPlayer {
  return new AudioClipPlayer(ctx, sources);
}
