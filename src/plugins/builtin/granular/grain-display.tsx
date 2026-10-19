import { useEffect, useRef, type PointerEvent } from 'react';
import { themeColors, useFrame } from '@agstudio/sdk/ui';
import type { AudioTap } from '@agstudio/sdk';
import {
  CANVAS_H,
  CANVAS_W,
  paintGrains,
  paintPositionLine,
  paintSprayWindow,
  paintWaveform,
  type Peaks,
} from './grain-paint';

/** How close (a share of the sample's width) a press must be to an edge of the spray window to grab that edge. */
const EDGE_GRAB = 0.02;
/** A spray narrower than this has no edge to grab (a share of the sample's width). */
const MIN_GRABBABLE_SPRAY = 0.005;

/** The two things a drag on the display edits. */
type DragTarget = 'position' | 'spray';

/** What the display shows and edits: the position and spray knobs' values. */
interface DisplayProps {
  peaks: Peaks | null;
  position: number;
  spray: number;
  /** The kernel's readings of its newest grains (null while nothing is running). */
  tap: AudioTap | undefined;
  /** A drag of the position line or the spray edge: begin, then values (0–1), then end (one undo step per drag). */
  onBegin(param: DragTarget): void;
  onChange(param: DragTarget, value: number): void;
  onEnd(param: DragTarget): void;
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
  const dragging = useRef<DragTarget | null>(null);
  useEffect(() => {
    latest.current = { position, spray, tap };
  });

  useEffect(() => {
    backdrop.current ??= document.createElement('canvas');
    backdrop.current.width = CANVAS_W;
    backdrop.current.height = CANVAS_H;
    paintWaveform(backdrop.current, peaks, themeColors());
  }, [peaks]);

  useFrame(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !backdrop.current) return;
    const colors = themeColors();
    const { position: pos, spray: wander, tap: meter } = latest.current;
    ctx.drawImage(backdrop.current, 0, 0);
    paintSprayWindow(ctx, colors, pos, wander);
    paintPositionLine(ctx, colors, pos);
    if (meter) paintGrains(ctx, colors, meter);
  });

  /** The pointer's x as a share of the display's width, 0–1. */
  const xOf = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
  };

  const drag = (e: PointerEvent<HTMLCanvasElement>) => {
    const target = dragging.current;
    if (!target) return;
    const x = xOf(e);
    if (target === 'position') onChange('position', x);
    else onChange('spray', Math.min(1, Math.abs(x - latest.current.position)));
  };

  const press = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = xOf(e);
    const { position: pos, spray: wander } = latest.current;
    const isNearSprayEdge = wander > MIN_GRABBABLE_SPRAY && Math.abs(Math.abs(x - pos) - wander) < EDGE_GRAB;
    dragging.current = isNearSprayEdge ? 'spray' : 'position';
    onBegin(dragging.current);
    drag(e);
  };

  const release = (e: PointerEvent<HTMLCanvasElement>) => {
    const target = dragging.current;
    dragging.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (target) onEnd(target);
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
      onPointerDown={press}
      onPointerMove={drag}
      onPointerUp={release}
    />
  );
}
