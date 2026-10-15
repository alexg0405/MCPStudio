/**
 * What the Ask AI card sits next to: the playlist's ✦ pill, a marker's flag, a span of the ruler, a
 * window, or a point (where a menu was opened). Windows that draw these register an anchor source
 * that measures them (in client pixels); the card follows its anchor every frame while it is open.
 */
import type { MarkerId, Tick } from '@core/model/types';

export type AskAnchor =
  | { kind: 'point'; x: number; y: number }
  /** The playlist's ✦ Ask AI pill (over the selection or the loop). */
  | { kind: 'pill'; fallback?: { x: number; y: number } }
  | { kind: 'marker'; markerId: MarkerId; fallback?: { x: number; y: number } }
  /** Bars of the song, on the playlist ruler. */
  | { kind: 'span'; from: Tick; to: Tick; fallback?: { x: number; y: number } }
  /** A DOM element, e.g. '[data-window-type="piano-roll"]'. */
  | { kind: 'element'; selector: string };

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Measures an anchor it knows (null when it can't: not its kind, scrolled away, window closed). */
export type AnchorSource = (anchor: AskAnchor) => Box | null;

const sources = new Map<string, AnchorSource>();

export function registerAnchorSource(id: string, source: AnchorSource): () => void {
  sources.set(id, source);
  return () => {
    if (sources.get(id) === source) sources.delete(id);
  };
}

const pointBox = (p: { x: number; y: number }): Box => ({ left: p.x, top: p.y, right: p.x, bottom: p.y });

/** Where an anchor is on screen now, or null. */
export function anchorBox(anchor: AskAnchor): Box | null {
  if (anchor.kind === 'point') return pointBox(anchor);
  if (anchor.kind === 'element') {
    const r = document.querySelector(anchor.selector)?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? r : null;
  }
  for (const source of sources.values()) {
    const box = source(anchor);
    if (box) return box;
  }
  return anchor.fallback ? pointBox(anchor.fallback) : null;
}

let pointer: { x: number; y: number } | null = null;

/** Where the pointer last went down (menus open there), for cards opened from a menu. */
export function lastPointer(): { x: number; y: number } | null {
  return pointer;
}

/** Keeps `lastPointer()` current; returns the remover. */
export function trackPointer(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onDown = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
  };
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  return () => window.removeEventListener('pointerdown', onDown, { capture: true });
}
