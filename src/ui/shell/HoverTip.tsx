import { useEffect, useRef } from 'react';
import { HINT_EVENT } from '@agstudio/sdk/ui';
import { useServices } from '../services-context';
import styles from './Shell.module.css';

const SHOW_DELAY = 550;
/** Moving from one tooltip to the next shows the next one almost at once (like the OS does). */
const WARM_DELAY = 60;
const WARM_FOR = 700;

/** A trailing "(⌘Z)" in a hint is shown as a key cap. */
const CHORD = /\s*\(([^()]{1,14})\)$/;

/**
 * Tooltips for everything that has a `data-hint`: hover a control for a moment and its hint appears
 * next to it. While dragging a knob or fader, its live value ("Volume 82%") follows the control.
 * Imperative (one element, no React state), so hovering never re-renders the app.
 *
 * Skipped where a tooltip would only get in the way: canvases (their hint follows the pointer),
 * menu items, `data-hint-tip="off"`, and hints that just repeat the control's own label.
 */
export function HoverTip() {
  const services = useServices();
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    let target: Element | null = null;
    let timer = 0;
    let shown = false;
    let live = false;
    let hiddenAt = -Infinity;
    let pressed: Element | null = null;
    let liveTimer = 0;

    const enabled = () => services.prefs.getState().tooltips;

    const hide = () => {
      window.clearTimeout(timer);
      window.clearTimeout(liveTimer);
      if (shown) hiddenAt = performance.now();
      shown = false;
      live = false;
      tip.hidden = true;
    };

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
      tip.classList.toggle(styles.tipLive!, asLive);
      tip.hidden = false;
      const r = anchor.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const x = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
      const below = r.bottom + 6;
      const y = below + h > window.innerHeight - 4 ? Math.max(4, r.top - h - 6) : below;
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      shown = true;
      live = asLive;
    };

    const tippable = (el: Element, hint: string) => {
      if (el instanceof HTMLCanvasElement || el.closest('[data-hint-tip="off"], [role="menuitem"], [role="menu"]'))
        return false;
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().toLowerCase();
      return label !== hint.replace(CHORD, '').trim().toLowerCase();
    };

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-hint]') ?? null;
      if (el === target) return;
      target = el;
      if (!live) hide();
      if (!el || e.buttons !== 0 || !enabled()) return;
      const hint = el.getAttribute('data-hint') ?? '';
      if (!hint.trim() || !tippable(el, hint)) return;
      const delay = performance.now() - hiddenAt < WARM_FOR ? WARM_DELAY : SHOW_DELAY;
      timer = window.setTimeout(() => {
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
      if (live) liveTimer = window.setTimeout(hide, 500);
    };
    // A control reports its value while it is dragged: show it right next to that control.
    const onHint = (e: Event) => {
      const text = String((e as CustomEvent).detail ?? '');
      if (!pressed || !text || !enabled() || pressed instanceof HTMLCanvasElement) return;
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
  }, [services]);

  return <div ref={tipRef} className={styles.tip} role="tooltip" hidden />;
}
