import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { learnNoiseFrom, toggleBreath } from '@app/actions/cleanup';
import { MIN_NOISE_SECONDS } from '@core/audio/cleanup/noise-profile';
import type { BreathSpan, ClipId, SampleRef, VocalCleanup } from '@core/model/types';
import { useServices } from '../../services-context';
import { markerAt, peakColumns } from './wave-peaks';
import styles from './CleanupWindow.module.css';

/** Height of the strip, CSS pixels. */
const STRIP_HEIGHT = 84;
/** The colour of the stretch the noise is learned from (the window's text calls it blue). */
const NOISE_COLOR = '#5b9bd5';
/** A drag shorter than this many pixels is a click. */
const CLICK_PIXELS = 4;
/** A marker is hit-able at least this wide (pixels), however short the breath. */
const MIN_MARKER_PIXELS = 10;

/** What the strip shows besides the recording: the part the clip plays, the learned stretch and the breath markers. */
interface StripView {
  duration: number;
  played: { from: number; to: number };
  noise: { from: number; to: number } | null;
  breaths: readonly BreathSpan[];
  /** True while the cleaned sound is being made or is out of date (the markers may move). */
  stale: boolean;
}

/** The recording's outline, read once per sample (null until the engine has the audio of this very sample). */
function useOutline(ref: SampleRef | undefined): { peaks: Float32Array; duration: number } | null {
  const services = useServices();
  const [loaded, setLoaded] = useState<{ of: SampleRef; peaks: Float32Array; duration: number } | null>(null);
  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    void services.engine.sampleData(ref).then((data) => {
      if (!cancelled && data) setLoaded({ of: ref, peaks: peakColumns(data.channels), duration: data.duration });
    });
    return () => {
      cancelled = true;
    };
  }, [services, ref]);
  return loaded && loaded.of === ref ? loaded : null;
}

/** Reads a colour from the theme, with a fallback for tests and for themes that lack it. */
function themeColor(el: Element, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

/** Draws the strip: outline, played part, learned stretch, breath markers and the drag in progress. */
function drawStrip(canvas: HTMLCanvasElement, peaks: Float32Array, view: StripView, drag: { from: number; to: number } | null): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(STRIP_HEIGHT * dpr)) canvas.height = Math.round(STRIP_HEIGHT * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx || width === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, STRIP_HEIGHT);
  const x = (t: number) => (t / view.duration) * width;
  const wave = themeColor(canvas, '--ag-text-dim', '#9aa');
  const warm = themeColor(canvas, '--ag-warn', '#fa4');
  // The part of the recording the clip plays is lighter than the rest.
  ctx.fillStyle = 'rgba(128,128,128,0.12)';
  ctx.fillRect(x(view.played.from), 0, Math.max(1, x(view.played.to) - x(view.played.from)), STRIP_HEIGHT);
  if (view.noise) {
    ctx.fillStyle = NOISE_COLOR;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x(view.noise.from), 0, Math.max(2, x(view.noise.to) - x(view.noise.from)), STRIP_HEIGHT);
    ctx.globalAlpha = 1;
  }
  const columns = peaks.length / 2;
  const mid = STRIP_HEIGHT / 2;
  ctx.fillStyle = wave;
  for (let px = 0; px < width; px++) {
    const c = Math.min(columns - 1, Math.floor((px / width) * columns));
    const low = peaks[c * 2] as number;
    const high = peaks[c * 2 + 1] as number;
    ctx.fillRect(px, mid - high * (mid - 2), 1, Math.max(1, (high - low) * (mid - 2)));
  }
  view.breaths.forEach((b) => {
    const left = x(b.from);
    const wide = Math.max(3, x(b.to) - left);
    ctx.fillStyle = warm;
    ctx.globalAlpha = b.off ? 0.12 : view.stale ? 0.3 : 0.45;
    ctx.fillRect(left, 0, wide, STRIP_HEIGHT);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = warm;
    ctx.lineWidth = b.off ? 1 : 2;
    ctx.setLineDash(b.off ? [3, 3] : []);
    ctx.strokeRect(left + 0.5, 0.5, wide - 1, STRIP_HEIGHT - 1);
    ctx.setLineDash([]);
  });
  if (drag) {
    ctx.fillStyle = NOISE_COLOR;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x(Math.min(drag.from, drag.to)), 0, Math.abs(x(drag.to) - x(drag.from)), STRIP_HEIGHT);
    ctx.globalAlpha = 1;
  }
}

/**
 * The recording as a strip. Orange boxes are the breaths found (click one to leave that breath as it is, click again to
 * turn it down again); the blue part is where the noise is learned from. Drag over a stretch of only room sound to
 * learn the noise from it.
 */
export function WaveStrip({
  clipId,
  sample,
  cleanup,
  played,
  isCurrent,
}: {
  clipId: ClipId;
  sample: SampleRef | undefined;
  cleanup: VocalCleanup | undefined;
  played: { from: number; to: number };
  isCurrent: boolean;
}) {
  const services = useServices();
  const canvas = useRef<HTMLCanvasElement>(null);
  const outline = useOutline(sample);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragStart = useRef<{ x: number; t: number } | null>(null);
  const noise = cleanup?.noise && cleanup.noise.from !== undefined && cleanup.noise.to !== undefined ? { from: cleanup.noise.from, to: cleanup.noise.to } : null;
  const breaths = cleanup?.breaths?.spans ?? [];

  useEffect(() => {
    const el = canvas.current;
    if (!el || !outline) return;
    const view: StripView = { duration: outline.duration, played, noise, breaths, stale: !isCurrent };
    drawStrip(el, outline.peaks, view, drag);
    const observer = new ResizeObserver(() => drawStrip(el, outline.peaks, view, drag));
    observer.observe(el);
    return () => observer.disconnect();
  }, [outline, played, noise?.from, noise?.to, breaths, isCurrent, drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeAt = (e: PointerEvent): number => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
    return fraction * (outline?.duration ?? 0);
  };
  const onDown = (e: PointerEvent) => {
    if (!outline) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, t: timeAt(e) };
  };
  const onMove = (e: PointerEvent) => {
    const start = dragStart.current;
    if (!start || Math.abs(e.clientX - start.x) < CLICK_PIXELS) return;
    setDrag({ from: start.t, to: timeAt(e) });
  };
  const onUp = (e: PointerEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    setDrag(null);
    if (!start || !outline) return;
    const widthPx = (e.currentTarget as HTMLElement).clientWidth || 1;
    if (Math.abs(e.clientX - start.x) < CLICK_PIXELS) {
      const minWidthSec = (MIN_MARKER_PIXELS / widthPx) * outline.duration;
      const hit = markerAt(breaths, start.t, minWidthSec);
      if (hit >= 0) toggleBreath(services, clipId, hit);
      return;
    }
    const from = Math.min(start.t, timeAt(e));
    const to = Math.max(start.t, timeAt(e));
    const problem = learnNoiseFrom(services, clipId, from, to);
    if (problem) services.session.getState().toast(problem);
    else services.session.getState().setHint(`Learning the noise from ${from.toFixed(2)}–${to.toFixed(2)} s (at least ${MIN_NOISE_SECONDS} s of only the room sound works best)`);
  };

  return (
    <div
      className={styles.strip}
      style={{ height: STRIP_HEIGHT }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      data-hint="Your recording. Orange boxes are the breaths found: click one to leave it as it is. Drag over a stretch with only the room sound (no singing) to learn the noise from it"
    >
      {outline ? <canvas ref={canvas} className={styles.canvas} /> : <span className={styles.stripEmpty}>Reading the recording…</span>}
    </div>
  );
}
