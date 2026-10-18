import type { ClipId } from '@core/model/types';

/**
 * Handing a playlist clip drag over to another window. The playlist moves clips with pointer events, not with HTML
 * drag-and-drop, so a clip dragged out of the playlist is invisible to other windows' drop handlers. Instead, a window
 * that wants playlist clips marks an element with `data-clip-drop`; while a clip drag is over such an element the
 * playlist stops moving the clips, shows the element as the target (`data-clip-drop-over`) and, on release, dispatches
 * a `CLIP_DROP_EVENT` on it. The element's window listens for that event (it bubbles) and does what a drop means.
 * The playlist and the receiving window know nothing of each other beyond this file.
 */
export const CLIP_DROP_ATTR = 'data-clip-drop';
export const CLIP_DROP_OVER_ATTR = 'data-clip-drop-over';
export const CLIP_DROP_EVENT = 'agstudio:clip-drop';

export interface ClipDropDetail {
  /** The dragged clips (the selection that was being moved). */
  clipIds: readonly ClipId[];
  /** The drag was a copy (Shift held): the clips stay where they were either way. */
  duplicate: boolean;
}

/** The drop target under a screen point, or null when the point is over nothing that takes clips. */
export function clipDropTargetAt(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(`[${CLIP_DROP_ATTR}]`) ?? null;
}

/** Marks `el` as the element a clip drag is over (and clears the mark from the one before). Null clears it. */
export function setClipDropOver(el: HTMLElement | null): void {
  if (typeof document === 'undefined') return;
  for (const old of document.querySelectorAll(`[${CLIP_DROP_OVER_ATTR}]`)) if (old !== el) old.removeAttribute(CLIP_DROP_OVER_ATTR);
  el?.setAttribute(CLIP_DROP_OVER_ATTR, '');
}

/** The clips were released over `el`: tells its window. */
export function dropClipsOn(el: HTMLElement, detail: ClipDropDetail): void {
  setClipDropOver(null);
  el.dispatchEvent(new CustomEvent<ClipDropDetail>(CLIP_DROP_EVENT, { bubbles: true, detail }));
}
