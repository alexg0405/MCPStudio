/**
 * Audio clips on the playlist: the waveform as it plays (trim, pitch, reverse and tempo follow
 * through core/audio/playback.ts) scaled by the clip's gain and fades, the fade curves, the handles
 * that edit them (fade-in and fade-out at the top corners, gain at the top centre), and the tags in
 * the title that say how it plays ("Stretch 90→128 BPM", "Reversed", "+3 st").
 */
import { clipEnvelopeAt, fadeShape, formatDb, type ClipLevels } from '@core/audio/envelope';
import { playbackMode, sourceSecondsAt, type PlaybackMode } from '@core/audio/playback';
import type { AudioClip, AudioClipChannel, Tick } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import type { Waveform } from '@engine/api';
import type { Viewport } from '../../timeline/viewport';
import type { ClipBox } from './clip-geometry';

export type AudioHandle = 'fadeIn' | 'fadeOut' | 'gain';

/** Height of the strip at the top of the body where the handles live. */
export const HANDLE_ZONE = 9;
const HANDLE = 7;

/** "Stretch 90→128 BPM", "Reversed", "+3 st", "−6.0 dB", "Frozen", "Stretching…". */
export function audioClipTags(
  clip: AudioClip,
  ch: AudioClipChannel,
  tempo: TempoMap,
  stretching: boolean,
): string[] {
  const m = playbackMode(ch);
  const tags: string[] = [];
  if (ch.frozenFrom) tags.push('Frozen');
  if (m.follow !== 'off') {
    const song = Math.round(tempo.bpmAt(clip.start) * 100) / 100;
    const src = Math.round((m.sourceBpm as number) * 100) / 100;
    tags.push(stretching ? 'Stretching…' : `${m.follow === 'stretch' ? 'Stretch' : 'Resample'} ${src}→${song} BPM`);
  }
  if (m.cents) {
    const st = m.cents / 100;
    tags.push(`${st > 0 ? '+' : '−'}${Math.abs(Math.round(st * 100) / 100)} st`);
  }
  if (m.reverse) tags.push('Reversed');
  if (clip.gain !== undefined && clip.gain !== 1) tags.push(formatDb(clip.gain));
  return tags;
}

/** Ticks a span of song seconds from a tick covers. */
function ticksFor(tempo: TempoMap, at: Tick, seconds: number): number {
  return tempo.secondsToTick(tempo.tickToSeconds(at) + seconds) - at;
}

/** Where the handles sit (canvas px) for a clip's box. */
export function handlePositions(
  vp: Viewport,
  clip: AudioClip,
  levels: ClipLevels,
  tempo: TempoMap,
  box: ClipBox,
): Record<AudioHandle, { x: number; y: number }> {
  const end = clip.start + clip.length;
  const fi = Math.max(0, levels.fadeIn ?? 0);
  const fo = Math.max(0, levels.fadeOut ?? 0);
  const inX = vp.tickToX(clip.start + ticksFor(tempo, clip.start, fi));
  const outX = vp.tickToX(tempo.secondsToTick(tempo.tickToSeconds(end) - fo));
  const y = box.bodyY + HANDLE_ZONE / 2;
  // Inset from the clip's edges so they stay grabbable (the edges resize the clip).
  return {
    fadeIn: { x: Math.min(box.x + box.w - 6, Math.max(box.x + 5, inX)), y },
    fadeOut: { x: Math.max(box.x + 5, Math.min(box.x + box.w - 6, outX)), y },
    gain: { x: box.x + box.w / 2, y },
  };
}

/** The handle under (x, y), when the clip is wide and tall enough to have them. */
export function hitAudioHandle(
  vp: Viewport,
  clip: AudioClip,
  levels: ClipLevels,
  tempo: TempoMap,
  box: ClipBox,
  x: number,
  y: number,
): AudioHandle | null {
  if (box.w < 40 || box.bodyH < HANDLE_ZONE + 4) return null;
  if (y < box.bodyY - 1 || y > box.bodyY + HANDLE_ZONE + 1) return null;
  const pos = handlePositions(vp, clip, levels, tempo, box);
  let best: AudioHandle | null = null;
  let dist = 7;
  for (const k of ['gain', 'fadeIn', 'fadeOut'] as const) {
    const d = Math.abs(x - pos[k].x);
    if (d <= dist) {
      dist = d;
      best = k;
    }
  }
  return best;
}

/**
 * The waveform the clip plays, each column scaled by the envelope there, plus the fade curves and
 * (when `handles`) the edit handles, `hot` one highlighted.
 */
export function drawAudioBody(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  wave: Waveform | null,
  clip: AudioClip,
  ch: AudioClipChannel,
  levels: ClipLevels,
  tempo: TempoMap,
  box: ClipBox,
  color: string,
  handles: { show: boolean; hot: AudioHandle | null },
): void {
  const { x, w, bodyY: y, bodyH: h } = box;
  const mode = playbackMode(ch);
  const mid = y + h / 2;
  const amp = h / 2;
  const from = Math.max(Math.floor(x), 0);
  const to = Math.min(Math.ceil(x + w), vp.width);
  const clipSec = tempo.tickToSeconds(clip.start);
  const dur = tempo.tickToSeconds(clip.start + clip.length) - clipSec;
  ctx.fillStyle = color;
  if (!wave) ctx.fillRect(x, mid, w, 1);
  else drawColumns(ctx, vp, wave, clip, mode, tempo, levels, x, from, to, y, h, mid, amp, clipSec, dur);
  // Fade curves: the gain falls to nothing at the clip's ends.
  const fi = Math.max(0, levels.fadeIn ?? 0);
  const fo = Math.max(0, levels.fadeOut ?? 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1;
  const curve = (x0: number, x1: number, rising: boolean) => {
    if (x1 - x0 < 1) return;
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const f = i / 16;
      const v = fadeShape(rising ? f : 1 - f);
      const px = x0 + (x1 - x0) * f;
      const py = y + h - v * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  const pos = handlePositions(vp, clip, levels, tempo, box);
  if (fi > 0) curve(x, vp.tickToX(clip.start + ticksFor(tempo, clip.start, fi)), true);
  if (fo > 0) curve(vp.tickToX(tempo.secondsToTick(clipSec + dur - fo)), x + w, false);
  if (!handles.show || w < 40 || h < HANDLE_ZONE + 4) return;
  for (const k of ['fadeIn', 'fadeOut', 'gain'] as const) {
    const p = pos[k];
    const hot = handles.hot === k;
    ctx.fillStyle = hot ? '#ffffff' : 'rgba(255,255,255,0.8)';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    if (k === 'gain') {
      ctx.fillRect(p.x - 7, p.y - 2.5, 14, 5);
      ctx.strokeRect(p.x - 7 + 0.5, p.y - 2.5 + 0.5, 13, 4);
    } else {
      ctx.fillRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(p.x - HANDLE / 2 + 0.5, p.y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
    }
  }
}

function drawColumns(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  wave: Waveform,
  clip: AudioClip,
  mode: PlaybackMode,
  tempo: TempoMap,
  levels: ClipLevels,
  x: number,
  from: number,
  to: number,
  y: number,
  h: number,
  mid: number,
  amp: number,
  clipSec: number,
  dur: number,
): void {
  const buckets = wave.peaks.length / 2;
  const perBucket = wave.bucket / wave.sampleRate;
  for (let px = from; px < to; px++) {
    const tick0 = clip.start + (px - x) / vp.pxPerTick;
    const tick1 = tick0 + 1 / vp.pxPerTick;
    let s0 = sourceSecondsAt(clip, mode, tempo, tick0);
    let s1 = sourceSecondsAt(clip, mode, tempo, tick1);
    if (s0 >= wave.duration) break;
    if (mode.reverse) [s0, s1] = [wave.duration - s1, wave.duration - s0];
    const b0 = Math.max(0, Math.floor(s0 / perBucket));
    const b1 = Math.min(buckets, Math.max(b0 + 1, Math.ceil(s1 / perBucket)));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      lo = Math.min(lo, wave.peaks[b * 2] as number);
      hi = Math.max(hi, wave.peaks[b * 2 + 1] as number);
    }
    const env = clipEnvelopeAt(levels, tempo.tickToSeconds(tick0) - clipSec, dur);
    const top = Math.max(y, mid - hi * env * amp);
    ctx.fillRect(px, top, 1, Math.max(1, Math.min(y + h, mid - lo * env * amp) - top));
  }
}
