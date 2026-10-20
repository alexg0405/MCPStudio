/**
 * The accessibility settings, turned into attributes on the page: `<html data-contrast data-motion data-palette>` and
 * the custom property `--ag-scale`. CSS and canvas code read those; nothing else needs to know the preferences.
 *
 * - Interface size (`prefs.uiScale`, percent): `--ag-scale` is 1 at 100 %. CSS multiplies its font sizes and control
 *   heights by it (`calc(11px * var(--ag-scale))`), and canvas code multiplies the sizes it draws text at.
 * - More contrast (`prefs.highContrast`): `data-contrast="more"`, which strengthens text, lines and focus rings on any
 *   theme (themes.css). 'auto' follows the system's "increase contrast" setting.
 * - Less motion (`prefs.reduceMotion`): `data-motion="reduced"` (or "full" when animations are wanted): transitions and
 *   animations off, no smooth scrolling. 'auto' follows the system's "reduce motion" setting. JavaScript that would
 *   animate asks `isReducedMotion()`.
 * - Colour-blind safe colours (`prefs.colorSafe`): `data-palette="safe"` swaps the red/green pairs for blue/orange.
 */
import type { AccessChoice, PrefsStore } from '@app/stores/prefs';
import { UI_SCALE_MAX, UI_SCALE_MIN } from '@app/stores/prefs';
import { invalidateTheme, setInterfaceScale } from '../timeline/canvas';

/** The media queries the 'auto' choices follow. */
const MORE_CONTRAST_QUERY = '(prefers-contrast: more)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Whether a setting is in effect: 'on' and 'off' are the person's choice, 'auto' is what the system says. */
export function resolveAccessChoice(choice: AccessChoice, systemSays: boolean): boolean {
  if (choice === 'auto') return systemSays;
  return choice === 'on';
}

/** The scale factor for a percentage, kept inside the range the settings allow (100 % is 1). */
export function scaleFactor(percent: number): number {
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Number.isFinite(percent) ? percent : 100));
  return Math.round(clamped) / 100;
}

const listeners = new Set<() => void>();

/** True while less motion is in effect (from the page's attribute, so it is right from the first render). */
export function isReducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced';
}

/** True while more contrast is in effect (the setting is on, or it is on Auto and the system asks for it). */
export function isHighContrast(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.contrast === 'more';
}

/** The interface scale in effect (1 = normal), read from the page's `--ag-scale`. */
export function currentScale(): number {
  if (typeof document === 'undefined') return 1;
  const value = parseFloat(document.documentElement.style.getPropertyValue('--ag-scale'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Calls `listener` whenever contrast, motion, scale or palette change; returns how to stop. */
export function subscribeAccessibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the system says right now, injectable so tests can pretend. */
export interface SystemPreferences {
  prefersMoreContrast(): boolean;
  prefersReducedMotion(): boolean;
}

function browserPreferences(): SystemPreferences {
  const asks = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;
  return {
    prefersMoreContrast: () => asks(MORE_CONTRAST_QUERY),
    prefersReducedMotion: () => asks(REDUCED_MOTION_QUERY),
  };
}

/** Sets or clears one data attribute; returns whether it changed. */
function setAttribute(root: HTMLElement, name: string, value: string | null): boolean {
  if ((root.getAttribute(name) ?? null) === value) return false;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
  return true;
}

/**
 * Keeps the attributes in step with the settings and the system. Call once at startup; the returned function stops
 * it. `system` lets tests pretend to be a computer set to high contrast or reduced motion.
 */
export function installAccessibilityPrefs(prefs: PrefsStore, system: SystemPreferences = browserPreferences()): () => void {
  const root = document.documentElement;
  const apply = (): void => {
    const state = prefs.getState();
    let changed = false;
    changed = setAttribute(root, 'data-contrast', resolveAccessChoice(state.highContrast, system.prefersMoreContrast()) ? 'more' : null) || changed;
    changed = setAttribute(root, 'data-motion', resolveAccessChoice(state.reduceMotion, system.prefersReducedMotion()) ? 'reduced' : 'full') || changed;
    changed = setAttribute(root, 'data-palette', state.colorSafe ? 'safe' : null) || changed;
    const factor = scaleFactor(state.uiScale);
    setInterfaceScale(factor);
    const scaleText = factor === 1 ? '' : String(factor);
    if (root.style.getPropertyValue('--ag-scale') !== scaleText) {
      if (scaleText) root.style.setProperty('--ag-scale', scaleText);
      else root.style.removeProperty('--ag-scale');
      changed = true;
    }
    if (!changed) return;
    // Canvases read their colours and text sizes from the page again.
    invalidateTheme();
    for (const listener of [...listeners]) listener();
  };
  apply();
  const queries =
    typeof matchMedia === 'function' ? [matchMedia(MORE_CONTRAST_QUERY), matchMedia(REDUCED_MOTION_QUERY)] : [];
  for (const query of queries) query.addEventListener('change', apply);
  const unsubscribe = prefs.subscribe(apply);
  return () => {
    for (const query of queries) query.removeEventListener('change', apply);
    unsubscribe();
  };
}
