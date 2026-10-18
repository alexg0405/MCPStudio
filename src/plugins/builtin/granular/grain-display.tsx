import { useEffect, useRef, type PointerEvent } from 'react';
import { themeColors, useFrame } from '@agstudio/sdk/ui';
import type { AudioTap } from '@agstudio/sdk';
import { TELEMETRY_GRAINS } from './params';

/** Canvas size in device pixels (drawn at twice its CSS size so lines stay sharp on retina screens). */
const CANVAS_W = 1200;
const CANVAS_H = 300;
/** How close (a share of the sample's width) a press must be to an edge of the spray window to grab that edge. */
const EDGE_GRAB = 0.02;
const DOT_RADIUS = 7;

/** The sample's peaks for drawing: min and max per bucket, interleaved. */
export interface Peaks {
  peaks: Float32Array;
}

/** What the display shows and edits: the position and spray knobs' values. */
interface DisplayProps {
  peaks: Peaks | null;
  position: number;
  spray: number;
  /** The kernel's readings of its newest grains (null while nothing is running). */
  tap: AudioTap | undefined;
  /** A drag of the position line or the spray edge: begin, then values (0–1), then end (one undo step per drag). */
  onBegin(param: 'position' | 'spray'): void;
  onChange(param: 'position' | 'spray', value: number): void;
  onEnd(param: 'position' | 'spray'): void;
}

/** Draws the waveform once into a picture that each frame then copies (so a frame costs a few draw calls). */
function paintWaveform(canvas: HTMLCanvasElement, peaks: Peaks | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const colors = themeColors();
  ctx.fillStyle = colors.well;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = colors.lineStrong;
  ctx.beginPath();
  ctx.moveTo(0, CANVAS_H / 2);
  ctx.lineTo(CANVAS_W, CANVAS_H / 2);
  ctx.stroke();
  if (!peaks) return;
  const buckets = peaks.peaks.length >> 1;
  ctx.fillStyle = colors.textFaint;
  for (let x = 0; x < CANVAS_W; x++) {
    const b0 = Math.floor((x / CANVAS_W) * buckets);
    const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / CANVAS_W) * buckets));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < Math.min(b1, buckets); b++) {
      lo = Math.min(lo, peaks.peaks[b * 2] as number);
      hi = Math.max(hi, peaks.peaks[b * 2 + 1] as number);
    }
    const top = CANVAS_H / 2 - hi * (CANVAS_H / 2 - 6);
    const bottom = CANVAS_H / 2 - lo * (CANVAS_H / 2 - 6);
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

/**
 * The waveform with the grain window on it: the line is the position, the shaded band is how far the spray lets
 * grains wander, and the dots are the grains that are sounding right now (higher up = further right in the stereo
 * field, brighter = further through their fade). Click or drag to set the position, drag a window edge to set the spray.
 * It draws on the frame loop and never re-renders React.
 */
export function GrainDisplay({ peaks, position, spray, tap, onBegin, onChange, onEnd }: DisplayProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const backdrop = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef({ position, spray, tap });
  const dragging = useRef<'position' | 'spray' | null>(null);
  useEffect(() => {
    latest.current = { position, spray, tap };
  });

  useEffect(() => {
    backdrop.current ??= document.createElement('canvas');
    backdrop.current.width = CANVAS_W;
    backdrop.current.height = CANVAS_H;
    paintWaveform(backdrop.current, peaks);
  }, [peaks]);

  useFrame(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !backdrop.current) return;
    const colors = themeColors();
    const { position: pos, spray: wander, tap: meter } = latest.current;
    ctx.drawImage(backdrop.current, 0, 0);
    // The spray window (wraps around the ends, as the grains do).
    ctx.fillStyle = colors.accentLight;
    ctx.globalAlpha = 0.16;
    const left = (pos - wander) * CANVAS_W;
    const width = Math.min(2 * wander, 1) * CANVAS_W;
    ctx.fillRect(left, 0, width, CANVAS_H);
    if (left < 0) ctx.fillRect(left + CANVAS_W, 0, -left, CANVAS_H);
    if (left + width > CANVAS_W) ctx.fillRect(0, 0, left + width - CANVAS_W, CANVAS_H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pos * CANVAS_W, 0);
    ctx.lineTo(pos * CANVAS_W, CANVAS_H);
    ctx.stroke();
    if (!meter) return;
    for (let i = 0; i < TELEMETRY_GRAINS; i++) {
      const where = meter.reading(`gp${i}`);
      if (where === undefined || where < 0) continue;
      const through = meter.reading(`gq${i}`) ?? 0;
      const pan = meter.reading(`gx${i}`) ?? 0;
      ctx.globalAlpha = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, through)));
      ctx.fillStyle = colors.select;
      ctx.beginPath();
      ctx.arc(where * CANVAS_W, CANVAS_H / 2 - pan * (CANVAS_H / 2 - 20), DOT_RADIUS, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

  const xOf = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
  };

  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const mode = dragging.current;
    if (!mode) return;
    const x = xOf(e);
    if (mode === 'position') onChange('position', x);
    else onChange('spray', Math.min(1, Math.abs(x - latest.current.position)));
  };

  return (
    <canvas
      ref={canvas}
      width={CANVAS_W}
      height={CANVAS_H}
      style={{ display: 'block', width: '100%', cursor: 'ew-resize', touchAction: 'none' }}
      role="img"
      aria-label="The sample, with the grain position and spray window and the sounding grains as dots"
      data-hint="The sample. Click or drag to set where grains come from (the line); drag an edge of the shaded band to set the spray. Dots are the grains sounding now: higher = more to the right, brighter = mid-grain"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const x = xOf(e);
        const { position: pos, spray: wander } = latest.current;
        const nearEdge = wander > 0.005 && Math.abs(Math.abs(x - pos) - wander) < EDGE_GRAB;
        dragging.current = nearEdge ? 'spray' : 'position';
        onBegin(dragging.current);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        const mode = dragging.current;
        dragging.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (mode) onEnd(mode);
      }}
    />
  );
}
