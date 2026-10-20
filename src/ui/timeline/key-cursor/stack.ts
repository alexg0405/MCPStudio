/**
 * The one keyboard stop of a canvas editor: its element gets Tab focus, a name and a description for screen readers, a
 * visible frame while the keyboard has the focus, and the router gives it the cursor keys.
 *
 * Its role is `application`: a screen reader normally keeps arrow keys and letters for its own reading cursor, and
 * `application` tells it to pass every key to the page, which is what a canvas with its own cursor needs. The label and
 * the hidden summary say what the editor holds and where the cursor is, so the person is never in a silent drawing.
 *
 * All DOM work here is done with the controller, not React: nothing re-renders when the cursor moves or the summary
 * text changes.
 */
import type { Services } from '@app/services';
import { announce } from '../../a11y/announce';
import { CoalescedAnnouncer } from './announcer';
import { hasKeyboardFocus, registerKeyOwner } from './router';
import './key-cursor.css';

/** Styles that hide a node from the eye but keep it in the accessibility tree (the live region uses the same). */
const VISUALLY_HIDDEN =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;pointer-events:none';

/** What an editor tells its stack. */
export interface KeyStackOptions {
  /** The name a screen reader gives the editor, e.g. "Piano roll grid". */
  label: string;
  /** What the person should know on arriving: the keys that matter, in one sentence. */
  help: string;
  /** Handles a key the router gives it; true when the key was used. */
  onKeyDown(event: KeyboardEvent): boolean;
  /** The keyboard got the focus (`true`) or lost it: show or hide the cursor. */
  onActiveChange(isActive: boolean): void;
}

let nextSummaryId = 1;

/** The focus stop of a canvas editor: see the file comment. */
export class KeyStack {
  /** True while the stack has the focus from the keyboard (the cursor is shown, the keys are the cursor's). */
  isActive = false;
  private readonly summary: HTMLElement;
  private lastSummary = '';
  private readonly announcer = new CoalescedAnnouncer((text) => announce(text));
  private readonly stopRouting: () => void;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly services: Services,
    readonly element: HTMLElement,
    private readonly options: KeyStackOptions,
  ) {
    this.summary = document.createElement('div');
    this.summary.id = `ag-key-summary-${nextSummaryId++}`;
    this.summary.style.cssText = VISUALLY_HIDDEN;
    element.append(this.summary);
    element.tabIndex = 0;
    element.setAttribute('role', 'application');
    element.setAttribute('aria-label', options.label);
    element.setAttribute('aria-roledescription', 'editor with a keyboard cursor');
    element.setAttribute('aria-describedby', this.summary.id);
    this.listen('focus', () => this.onFocus());
    this.listen('blur', () => this.setActive(false));
    // A click or a touch means the person is pointing now: the cursor hides and the window's own key shortcuts return.
    this.listen('pointerdown', () => this.setActive(false), true);
    this.stopRouting = registerKeyOwner({
      element,
      isActive: () => this.isActive,
      onKeyDown: (event) => options.onKeyDown(event),
    });
  }

  /** Replaces the hidden description (what the editor holds, where the cursor is). Nothing happens when it is unchanged. */
  setSummary(text: string): void {
    if (text === this.lastSummary) return;
    this.lastSummary = text;
    this.summary.textContent = `${this.options.help} ${text}`;
  }

  /** Says a sentence soon: replaces one still waiting, so a held key does not queue up speech. */
  say(text: string): void {
    this.announcer.say(text);
  }

  /** Says a sentence at once (the answer to the "?" key). */
  sayNow(text: string): void {
    this.announcer.sayNow(text);
  }

  /** Removes everything this stack added to the element. */
  dispose(): void {
    this.stopRouting();
    this.announcer.cancel();
    for (const undo of this.cleanups.splice(0)) undo();
    this.summary.remove();
    for (const name of ['tabindex', 'role', 'aria-label', 'aria-roledescription', 'aria-describedby']) {
      this.element.removeAttribute(name);
    }
  }

  private listen(type: 'focus' | 'blur' | 'pointerdown', handler: () => void, isCapture = false): void {
    this.element.addEventListener(type, handler, isCapture);
    this.cleanups.push(() => this.element.removeEventListener(type, handler, isCapture));
  }

  private onFocus(): void {
    this.setActive(hasKeyboardFocus(this.element));
    // Tabbing into a window does not raise it like a click does, and the window's own shortcuts (copy, paste, the
    // tool letters) follow the focused window.
    const windowId = this.element.closest<HTMLElement>('[data-window-id]')?.dataset.windowId;
    if (windowId) this.services.view.getState().focusWindow(windowId);
  }

  private setActive(isActive: boolean): void {
    if (this.isActive === isActive) return;
    this.isActive = isActive;
    this.options.onActiveChange(isActive);
  }
}
