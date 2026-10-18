/** Listeners and subscriptions that an editor adds when it mounts and removes together when it unmounts. */

/** A list of "undo this" functions: add each listener or subscription as it is made, run them all on unmount. */
export class CleanupList {
  private readonly cleanups: Array<() => void> = [];

  /** Remembers functions to call on `runAll` (an unsubscribe, a disconnect). */
  add(...cleanups: Array<() => void>): void {
    this.cleanups.push(...cleanups);
  }

  /** Adds a listener to `target` and remembers how to remove it. */
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler as EventListener, options);
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
  }

  /**
   * Esc drops the drag that is going on (the editor then changes nothing). It listens on the window while capturing, so
   * it comes before the shortcuts that would otherwise take Esc, and does nothing when no drag is going.
   */
  cancelOnEscape(isDragging: () => boolean, cancel: () => void): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isDragging()) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    this.cleanups.push(() => window.removeEventListener('keydown', onKeyDown, true));
  }

  /** Calls every remembered function (once) and forgets them. */
  runAll(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}
