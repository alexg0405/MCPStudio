/**
 * The live region: what a screen reader says out loud when something happens that the person did not point at
 * (playback started, a render finished, a keyboard cursor moved, the Studio answered). Two hidden elements hold
 * the text: a polite one (waits for the reader to finish) and an assertive one (errors, interrupts).
 *
 * `announce()` is safe to call from anywhere in `src/ui`, including a canvas controller's key handler: it does no
 * React work and costs one text write. It makes no sound itself, so people without a screen reader never notice it.
 */

/** How urgent a message is: `polite` waits its turn, `assertive` interrupts (errors, a destructive result). */
export type Urgency = 'polite' | 'assertive';

/** How many past messages are kept for `recentAnnouncements()` (tests and the "what was that?" command). */
const HISTORY_LIMIT = 50;

/**
 * An invisible character added to every second repeat of the same message. A live region only speaks when its
 * text changes, so "Playing" twice in a row would otherwise be silent the second time.
 */
const REPEAT_MARK = ' ';

const history: string[] = [];
let lastText = '';
let repeatFlip = false;
const regions: Partial<Record<Urgency, HTMLElement>> = {};

/** Styles that hide a node from the eye but keep it in the accessibility tree. */
const VISUALLY_HIDDEN =
  'position:fixed;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;pointer-events:none';

function regionFor(urgency: Urgency): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const existing = regions[urgency];
  if (existing?.isConnected) return existing;
  const region = document.createElement('div');
  region.setAttribute('data-ag-live', urgency);
  region.setAttribute('role', urgency === 'assertive' ? 'alert' : 'status');
  region.setAttribute('aria-live', urgency);
  region.setAttribute('aria-atomic', 'true');
  region.style.cssText = VISUALLY_HIDDEN;
  document.body.append(region);
  regions[urgency] = region;
  return region;
}

/**
 * Says `message` through the live region. A message identical to the previous one is still spoken. Empty text
 * is ignored.
 */
export function announce(message: string, urgency: Urgency = 'polite'): void {
  const text = message.trim();
  if (!text) return;
  history.push(text);
  if (history.length > HISTORY_LIMIT) history.shift();
  repeatFlip = text === lastText ? !repeatFlip : false;
  lastText = text;
  const region = regionFor(urgency);
  if (region) region.textContent = repeatFlip ? text + REPEAT_MARK : text;
}

/** The latest messages, oldest first (at most 50). */
export function recentAnnouncements(): readonly string[] {
  return history;
}

/** What a live region holds right now, for tests. */
export function liveRegionText(urgency: Urgency = 'polite'): string {
  return (regions[urgency]?.textContent ?? '').replace(REPEAT_MARK, '');
}

/** Forgets the history and empties the regions (tests). */
export function resetAnnouncements(): void {
  history.length = 0;
  lastText = '';
  repeatFlip = false;
  for (const region of Object.values(regions)) if (region) region.textContent = '';
}
