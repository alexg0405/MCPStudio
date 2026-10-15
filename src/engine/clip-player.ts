import { GraphVoices, type InstrumentInstance, type NoteOn } from '@agstudio/sdk';
import { envelopeBreakpoints, clipEnvelopeAt } from '@core/audio/envelope';
import {
  sourceRateAt,
  sourceSecondsAt,
  stretchScale,
  tickAtSourceSeconds,
  type PlaybackMode,
} from '@core/audio/playback';
import type { AudioClip } from '@core/model/types';
import type { AudioOn } from './sched/transport';

/** Ramp from silence when a clip starts inside its sound on a non-zero envelope (no fade-in). */
const ANTI_CLICK = 0.002;
/** Fade when a clip is cut short (stop, loop wrap, seek) or ends without a fade-out. */
const RELEASE = 0.004;
/** Lead time of a start or switch once a buffer became ready (late sample, stretched copy). */
const SWAP_LEAD = 0.03;
/** At most this many tempo changes are scheduled per clip start (a long clip under a tempo ramp). */
const MAX_RATE_EVENTS = 4096;

/** A gain schedule as written: [time, value] points joined by linear ramps (held after the last one). */
type Schedule = Array<[number, number]>;

function valueAt(s: Schedule, time: number): number {
  let prev = s[0];
  if (!prev || time <= prev[0]) return prev?.[1] ?? 0;
  for (let i = 1; i < s.length; i++) {
    const p = s[i] as [number, number];
    if (time <= p[0]) return prev[1] + ((p[1] - prev[1]) * (time - prev[0])) / (p[0] - prev[0] || 1);
    prev = p;
  }
  return prev[1];
}

/**
 * Fades a gain out over RELEASE from `rt`. cancelAndHoldAtTime alone isn't enough: when nothing is
 * scheduled after `rt` (the last ramp ended long ago) Chrome inserts no hold point, and the release
 * ramp would then run from that old ramp's end, fading the whole clip. So the held value is set too.
 */
function releaseGain(g: AudioParam, s: Schedule, rt: number): void {
  g.cancelAndHoldAtTime(rt);
  g.setValueAtTime(valueAt(s, rt), rt);
  g.linearRampToValueAtTime(0, rt + RELEASE);
}

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
  /** The sample as played (reversed when reverse is on) and its cache key; null while it isn't decoded. */
  base(): { buffer: AudioBuffer; key: string } | null;
  /** The clip's time-stretched copy at `scale`: its buffer, key and the second of the sample its first frame is. */
  stretched(clip: AudioClip, scale: number): { buffer: AudioBuffer; key: string; from: number } | null;
  /** Voices wait for buffers: make sure they are on their way. */
  request(): void;
  /** Keeps a buffer in memory while a voice reads it; returns the release. */
  hold(key: string): () => void;
}

type VoiceState = 'waiting' | 'fallback' | 'ok';

interface Live {
  /** The start of this voice (time and tick it was started at). */
  e: AudioOn;
  scale: number;
  /** waiting: no sample yet (it starts in time once it arrives); fallback: the plain sample until the stretched copy is ready. */
  state: VoiceState;
  /** Context time it ends at the latest (clip end or end of the sound). */
  end: number;
}

interface Hold {
  release(): void;
  /** Context time after which the buffer is no longer read. */
  until: number;
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
export function createClipPlayer(ctx: BaseAudioContext, opts: ClipSources): ClipPlayer {
  const out = new GainNode(ctx);
  const voices = new GraphVoices(ctx, out, { max: 16 });
  const live = new Map<number, Live>();
  const holds = new Map<number, Hold[]>();
  /** Previews waiting for the sample (the key is held down while it decodes). */
  const pendingPreviews = new Map<number, NoteOn>();
  let disposed = false;

  const stopAt = (node: AudioScheduledSourceNode, t: number) => {
    try {
      node.stop(t);
    } catch {
      /* already stopped */
    }
  };

  const hold = (noteId: number, key: string, until: number) => {
    let list = holds.get(noteId);
    if (!list) holds.set(noteId, (list = []));
    // A restarted voice (swap) replaces the old one, which is read until its crossfade has ended.
    for (const h of list) h.until = Math.min(h.until, ctx.currentTime + SWAP_LEAD + 0.1);
    list.push({ release: opts.hold(key), until });
  };

  const endHolds = (noteId: number, at: number) => {
    for (const h of holds.get(noteId) ?? []) h.until = Math.min(h.until, at);
  };

  function sweep(): void {
    const now = ctx.currentTime;
    for (const [id, v] of live) if (v.end < now - 1) live.delete(id);
    for (const [id, list] of holds) {
      const keep = list.filter((h) => {
        if (h.until >= now - 0.05) return true;
        h.release();
        return false;
      });
      if (keep.length === 0) holds.delete(id);
      else holds.set(id, keep);
    }
  }

  function startClip(e: AudioOn): void {
    if (disposed) return;
    const mode = opts.mode();
    const { clip, tempo } = e;
    const now = ctx.currentTime;
    sweep();
    // Late events start further into the clip so they stay in time.
    const t = Math.max(e.time, now);
    const tick = t > e.time ? tempo.secondsToTick(tempo.tickToSeconds(e.tick) + (t - e.time)) : e.tick;
    const clipEnd = clip.start + clip.length;
    if (tick >= clipEnd) return;
    const secAt = tempo.tickToSeconds(tick);
    const timeOf = (tk: number) => t + tempo.tickToSeconds(tk) - secAt;
    const scale = mode.follow === 'stretch' ? stretchScale(mode, tempo, clip.start) : 1;
    const copy = scale === 1 ? null : opts.stretched(clip, scale);
    const base = copy ? null : opts.base();
    if (!copy && !base) {
      // Not decoded yet: wait for it (it starts at the song's position then).
      live.set(e.noteId, { e: { ...e, time: t, tick }, scale, state: 'waiting', end: timeOf(clipEnd) });
      opts.request();
      return;
    }
    // Where the sound ends: the sample's end, or the end of what the stretched copy covers (its
    // range is clamped to the sample; otherwise it reaches past the clip, which ends first).
    const duration = copy ? copy.from + copy.buffer.duration / scale : base!.buffer.duration;
    const srcSec = Math.max(0, sourceSecondsAt(clip, mode, tempo, tick));
    if (srcSec >= duration) return;
    const fallback = scale !== 1 && !copy;
    const buffer = copy ? copy.buffer : base!.buffer;
    const factor = copy ? scale : 1;
    // Seconds into the buffer the voice starts at (a stretched copy begins at `copy.from` of the sample).
    const offset = copy ? Math.max(0, srcSec - copy.from) * scale : srcSec;
    const rateAt = (tk: number) => factor * sourceRateAt(mode, tempo, tk);

    const node = new AudioBufferSourceNode(ctx, { buffer, playbackRate: rateAt(tick) });
    if (mode.follow !== 'off' && !tempo.constant) {
      let n = 0;
      for (let tk = tempo.nextChange(tick); tk < clipEnd && n < MAX_RATE_EVENTS; tk = tempo.nextChange(tk), n++)
        node.playbackRate.setValueAtTime(rateAt(tk), timeOf(tk));
    }

    // The clip's gain and fades, from where this voice starts.
    const vca = new GainNode(ctx, { gain: 0 });
    const g = vca.gain;
    const clipSec = tempo.tickToSeconds(clip.start);
    const dur = tempo.tickToSeconds(clipEnd) - clipSec;
    const x0 = secAt - clipSec;
    const points = envelopeBreakpoints(clip, dur, x0);
    const v0 = points[0]?.[1] ?? 0;
    // Starting inside the sound on a non-zero envelope would click: ramp in from silence. At the
    // very beginning of the sound it starts there anyway (and a frozen or consolidated render must
    // keep its attack), so it starts at the envelope's value.
    const ramp = v0 > 0 && (x0 > 1e-9 || srcSec > 1e-9);
    const sched: Schedule = [[t, ramp ? 0 : v0]];
    g.setValueAtTime(sched[0]![1], t);
    let lastX = x0;
    if (ramp) {
      lastX = Math.min(dur, x0 + ANTI_CLICK);
      sched.push([t + (lastX - x0), clipEnvelopeAt(clip, lastX, dur)]);
    }
    for (const [x, v] of points) if (x > lastX) sched.push([t + (x - x0), v]);
    for (let i = 1; i < sched.length; i++) g.linearRampToValueAtTime(sched[i]![1], sched[i]![0]);

    node.connect(vca);
    node.start(t, offset);
    const soundEnd = tickAtSourceSeconds(clip, mode, tempo, duration);
    const end = timeOf(Math.min(clipEnd, soundEnd));
    voices.add(e.noteId, {
      start: t,
      sources: [node],
      out: vca,
      end: end + RELEASE,
      release: (rt) => {
        releaseGain(g, sched, rt);
        stopAt(node, rt + RELEASE + 0.001);
        return rt + RELEASE + 0.001;
      },
    });
    hold(e.noteId, copy ? copy.key : base!.key, end + RELEASE + 0.01);
    live.set(e.noteId, { e: { ...e, time: t, tick }, scale, state: fallback ? 'fallback' : 'ok', end });
    if (fallback) opts.request();
  }

  /** Previews (and transports without clip info): the sample from `offset`, at the channel's pitch. */
  function preview(e: NoteOn): void {
    if (disposed) return;
    const base = opts.base();
    if (!base) {
      pendingPreviews.set(e.noteId, e);
      opts.request();
      return;
    }
    const { time, noteId, offset } = e;
    const mode = opts.mode();
    const buffer = base.buffer;
    const t = Math.max(time, ctx.currentTime);
    const off = Math.max(0, (offset ?? 0) + (t - time) * mode.pitch);
    if (off >= buffer.duration) return;
    const node = new AudioBufferSourceNode(ctx, { buffer, playbackRate: mode.pitch });
    const vca = new GainNode(ctx, { gain: 0 });
    node.connect(vca);
    const sched: Schedule = [
      [t, 0],
      [t + ANTI_CLICK, 1],
    ];
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(1, t + ANTI_CLICK);
    node.start(t, off);
    const end = t + (buffer.duration - off) / mode.pitch;
    voices.add(noteId, {
      start: t,
      sources: [node],
      out: vca,
      end,
      release: (rt) => {
        releaseGain(vca.gain, sched, rt);
        return rt + RELEASE + 0.001;
      },
    });
    hold(noteId, base.key, end + 0.01);
  }

  function refresh(): void {
    if (disposed) return;
    const at = ctx.currentTime + SWAP_LEAD;
    for (const v of [...live.values()]) {
      if (v.state === 'ok' || at >= v.end) continue;
      const copy = v.scale !== 1 ? opts.stretched(v.e.clip, v.scale) : null;
      if (v.state === 'waiting' && !copy && !opts.base()) continue;
      if (v.state === 'fallback' && !copy) continue;
      const { tempo } = v.e;
      const tick = tempo.secondsToTick(tempo.tickToSeconds(v.e.tick) + (at - v.e.time));
      // Same note id: the voice replaces the old one, which fades out as it fades in.
      startClip({ ...v.e, time: at, tick });
    }
    if (pendingPreviews.size > 0 && opts.base()) {
      const t = ctx.currentTime;
      for (const [id, e] of [...pendingPreviews]) {
        pendingPreviews.delete(id);
        preview({ ...e, time: t, offset: (e.offset ?? 0) + (t - e.time) * opts.mode().pitch });
      }
    }
  }

  return {
    output: out,
    tailTime: 0.05,
    startClip,
    refresh,
    sweep,
    noteOn: preview,
    noteOff: ({ noteId, time }) => {
      live.delete(noteId);
      pendingPreviews.delete(noteId);
      voices.release(noteId, time);
      endHolds(noteId, Math.max(time, ctx.currentTime) + RELEASE + 0.01);
    },
    allNotesOff: (time, hard) => {
      live.clear();
      pendingPreviews.clear();
      voices.releaseAll(time, hard);
      for (const id of holds.keys()) endHolds(id, Math.max(time, ctx.currentTime) + RELEASE + 0.01);
    },
    dispose: () => {
      disposed = true;
      live.clear();
      pendingPreviews.clear();
      voices.disposeAll();
      out.disconnect();
      for (const list of holds.values()) for (const h of list) h.release();
      holds.clear();
    },
  };
}
