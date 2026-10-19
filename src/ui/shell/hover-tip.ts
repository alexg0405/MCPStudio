/**
 * The tooltip's behaviour, imperative (one element, no React state), so hovering never re-renders the app.
 * Hover a control that has a `data-hint` for a moment and its hint appears next to it. While a knob or fader is dragged,
 * its live value ("Volume 82%") follows the control instead.
 *
 * Skipped where a tooltip would only get in the way: canvases (their hint follows the pointer), menu items,
 * `data-hint-tip="off"`, and hints that just repeat the control's own label.
 */
import { HINT_EVENT } from '@agstudio/sdk/ui';

/** How long the pointer rests on a control before its tooltip shows (ms). */
const SHOW_DELAY_MS = 550;
/** Moving from one tooltip to the next shows the next one almost at once (like the OS does), within this time (ms). */
const WARM_DELAY_MS = 60;
const WARM_WINDOW_MS = 700;
/** A live value stays this long after the control is let go (ms). */
const LIVE_LINGER_MS = 500;
/** The gap between a tooltip and its control, and to the window's edge, in px. */
const TIP_GAP_PX = 6;
const EDGE_GAP_PX = 4;

/** A trailing "(⌘Z)" in a hint is shown as a key cap. */
const CHORD = /\s*\(([^()]{1,14})\)$/;

/** Shows tooltips in `tip` (an element that starts hidden) for the hints of whatever the pointer rests on; `styles.tipLive` marks a live value. */
export function installHoverTip(tip: HTMLElement, liveClass: string, isEnabled: () => boolean): () => void {
  let target: Element | null = null;
  let showTimer = 0;
  let isShown = false;
  let isLive = false;
  let hiddenAt = -Infinity;
  let pressed: Element | null = null;
  let liveTimer = 0;

  const hide = () => {
    window.clearTimeout(showTimer);
    window.clearTimeout(liveTimer);
    if (isShown) hiddenAt = performance.now();
    isShown = false;
    isLive = false;
    tip.hidden = true;
  };

  /** Fills the tooltip (a trailing chord becomes a key cap) and puts it under the anchor, or above when there is no room below. */
  const show = (anchor: Element, text: string, asLive: boolean) => {
    if (!anchor.isConnected) return;
    const chord = asLive ? null : CHORD.exec(text);
    const body = chord ? text.slice(0, chord.index) : text;
    tip.replaceChildren(document.createTextNode(body));
    if (chord) {
      const key = document.createElement('kbd');
      key.textContent = chord[1]!;
      tip.append(key);
    }
    tip.classList.toggle(liveClass, asLive);
    tip.hidden = false;
    const box = anchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const x = Math.max(TIP_GAP_PX, Math.min(window.innerWidth - width - TIP_GAP_PX, box.left + box.width / 2 - width / 2));
    const below = box.bottom + TIP_GAP_PX;
    const y = below + height > window.innerHeight - EDGE_GAP_PX ? Math.max(EDGE_GAP_PX, box.top - height - TIP_GAP_PX) : below;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    isShown = true;
    isLive = asLive;
  };

  /** A control gets a tooltip unless it is a canvas, a menu item, opted out, or its hint only repeats its own label. */
  const isTippable = (el: Element, hint: string) => {
    if (el instanceof HTMLCanvasElement || el.closest('[data-hint-tip="off"], [role="menuitem"], [role="menu"]')) return false;
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().toLowerCase();
    return label !== hint.replace(CHORD, '').trim().toLowerCase();
  };

  const onOver = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-hint]') ?? null;
    if (el === target) return;
    target = el;
    if (!isLive) hide();
    if (!el || e.buttons !== 0 || !isEnabled()) return;
    const hint = el.getAttribute('data-hint') ?? '';
    if (!hint.trim() || !isTippable(el, hint)) return;
    const delay = performance.now() - hiddenAt < WARM_WINDOW_MS ? WARM_DELAY_MS : SHOW_DELAY_MS;
    showTimer = window.setTimeout(() => {
      // The hint may have changed while waiting (toggle buttons update theirs).
      if (target === el) show(el, el.getAttribute('data-hint') ?? hint, false);
    }, delay);
  };
  const onDown = (e: PointerEvent) => {
    hide();
    pressed = (e.target as Element | null)?.closest?.('[data-hint]') ?? null;
  };
  const onUp = () => {
    pressed = null;
    if (isLive) liveTimer = window.setTimeout(hide, LIVE_LINGER_MS);
  };
  // A control reports its value while it is dragged: show it right next to that control.
  const onHint = (e: Event) => {
    const text = String((e as CustomEvent).detail ?? '');
    if (!pressed || !text || !isEnabled() || pressed instanceof HTMLCanvasElement) return;
    window.clearTimeout(liveTimer);
    show(pressed, text, true);
  };
  const onLeave = (e: PointerEvent) => {
    if (!e.relatedTarget) {
      target = null;
      hide();
    }
  };

  document.addEventListener('pointerover', onOver);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointerout', onLeave);
  document.addEventListener(HINT_EVENT, onHint);
  window.addEventListener('keydown', hide, true);
  window.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  return () => {
    hide();
    document.removeEventListener('pointerover', onOver);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointerout', onLeave);
    document.removeEventListener(HINT_EVENT, onHint);
    window.removeEventListener('keydown', hide, true);
    window.removeEventListener('wheel', hide, { capture: true });
    window.removeEventListener('blur', hide);
  };
}
