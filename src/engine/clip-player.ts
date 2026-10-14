import { GraphVoices, type InstrumentInstance, type NoteOn } from '@agstudio/sdk';
import { envelopeBreakpoints, clipEnvelopeAt } from '@core/audio/envelope';
import {
  sourceRateAt,
  sourceSecondsAt,
  stretchScale,
  tickAtSourceSeconds,
  type PlaybackMode,
} from '@core/audio/playback';
import { requestStretch, reversedBuffer, stretchedBuffer } from './audio-buffers';
import type { AudioOn } from './sched/transport';

/** Ramp from silence when a clip starts on a non-zero envelope (playback started inside it, no fade-in). */
const ANTI_CLICK = 0.002;
/** Fade when a clip is cut short (stop, loop wrap, seek) or ends without a fade-out. */
const RELEASE = 0.004;
/** Lead time of the switch to a stretched copy that just became ready. */
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
}

interface Live {
  /** The start of this voice (time and tick it was started at). */
  e: AudioOn;
  base: AudioBuffer;
  scale: number;
  /** Playing the plain sample (in time, pitch off) until its stretched copy is ready. */
  fallback: boolean;
  /** Context time it ends at the latest (clip end or end of the sound). */
  end: number;
}

/**
 * Plays an audio clip channel's sample for each clip: from the clip's trim (`offsetSec`), with the
 * clip's gain and fades (envelope ramps), the channel's pitch, reverse and tempo follow
 * (core/audio/playback.ts). 'resample' and 'stretch' change speed at every tempo change; 'stretch'
 * plays a WSOLA copy and, while that is being computed, the plain sample in time (then switches over
 * with a short crossfade). The transport's noteOff at the clip end (or a loop wrap, stop or seek)
 * releases a voice.
 */
export function createClipPlayer(
  ctx: BaseAudioContext,
  opts: { buffer: () => AudioBuffer | null; mode: () => PlaybackMode },
): ClipPlayer {
  const out = new GainNode(ctx);
  const voices = new GraphVoices(ctx, out, { max: 16 });
  const live = new Map<number, Live>();
  let disposed = false;

  const stopAt = (node: AudioScheduledSourceNode, t: number) => {
    try {
      node.stop(t);
    } catch {
      /* already stopped */
    }
  };

  function startClip(e: AudioOn): void {
    const source = opts.buffer();
    if (!source || disposed) return;
    const mode = opts.mode();
    const { clip, tempo } = e;
    const now = ctx.currentTime;
    for (const [id, v] of live) if (v.end < now - 1) live.delete(id);
    // Late events start further into the clip so they stay in time.
    const t = Math.max(e.time, now);
    const tick = t > e.time ? tempo.secondsToTick(tempo.tickToSeconds(e.tick) + (t - e.time)) : e.tick;
    const clipEnd = clip.start + clip.length;
    if (tick >= clipEnd) return;
    const base = mode.reverse ? reversedBuffer(source) : source;
    const srcSec = Math.max(0, sourceSecondsAt(clip, mode, tempo, tick));
    if (srcSec >= base.duration) return;
    const scale = mode.follow === 'stretch' ? stretchScale(mode, tempo, clip.start) : 1;
    const stretched = scale === 1 ? base : stretchedBuffer(base, scale);
    const fallback = !stretched;
    const buffer = stretched ?? base;
    const factor = mode.follow === 'stretch' && !fallback ? scale : 1;
    const rateAt = (tk: number) => factor * sourceRateAt(mode, tempo, tk);
    const secAt = tempo.tickToSeconds(tick);
    const timeOf = (tk: number) => t + tempo.tickToSeconds(tk) - secAt;

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
    const sched: Schedule = [[t, 0]];
    g.setValueAtTime(0, t);
    let lastX = x0;
    const points = envelopeBreakpoints(clip, dur, x0);
    if ((points[0]?.[1] ?? 0) > 0) {
      lastX = Math.min(dur, x0 + ANTI_CLICK);
      sched.push([t + (lastX - x0), clipEnvelopeAt(clip, lastX, dur)]);
    }
    for (const [x, v] of points) if (x > lastX) sched.push([t + (x - x0), v]);
    for (let i = 1; i < sched.length; i++) g.linearRampToValueAtTime(sched[i]![1], sched[i]![0]);

    node.connect(vca);
    node.start(t, srcSec * factor);
    const soundEnd = tickAtSourceSeconds(clip, mode, tempo, base.duration);
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
    live.set(e.noteId, { e: { ...e, time: t, tick }, base, scale, fallback, end });
    if (fallback) void requestStretch(base, scale).then((b) => b && swap(base, scale));
  }

  /** A stretched copy became ready: voices playing the plain sample switch to it at the same spot. */
  function swap(base: AudioBuffer, scale: number): void {
    if (disposed) return;
    const at = ctx.currentTime + SWAP_LEAD;
    for (const v of [...live.values()]) {
      if (!v.fallback || v.base !== base || v.scale !== scale || at >= v.end) continue;
      const { tempo } = v.e;
      const tick = tempo.secondsToTick(tempo.tickToSeconds(v.e.tick) + (at - v.e.time));
      // Same note id: the voice replaces the old one, which fades out as it fades in.
      startClip({ ...v.e, time: at, tick });
    }
  }

  return {
    output: out,
    tailTime: 0.05,
    startClip,
    /** Previews (and transports without clip info): the sample from `offset`, at the channel's pitch. */
    noteOn({ time, noteId, offset }: NoteOn) {
      const source = opts.buffer();
      if (!source || disposed) return;
      const mode = opts.mode();
      const buffer = mode.reverse ? reversedBuffer(source) : source;
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
      voices.add(noteId, {
        start: t,
        sources: [node],
        out: vca,
        end: t + (buffer.duration - off) / mode.pitch,
        release: (rt) => {
          releaseGain(vca.gain, sched, rt);
          return rt + RELEASE + 0.001;
        },
      });
    },
    noteOff: ({ noteId, time }) => {
      live.delete(noteId);
      voices.release(noteId, time);
    },
    allNotesOff: (time, hard) => {
      live.clear();
      voices.releaseAll(time, hard);
    },
    dispose: () => {
      disposed = true;
      live.clear();
      voices.disposeAll();
      out.disconnect();
    },
  };
}
