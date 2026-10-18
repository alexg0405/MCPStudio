/** Saving the view (zoom and scroll) into the editor settings without doing it on every scroll event. */

/** After the last scroll or zoom, wait this long (ms) before saving: a wheel or a drag sends dozens of events. */
const SAVE_DELAY_MS = 300;

/** Remembers that the view changed and saves it a moment later (or at once on `flush`). */
export class ViewportSaver {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly save: () => void) {}

  /** The view changed: save it once things go quiet for `SAVE_DELAY_MS`. */
  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.save, SAVE_DELAY_MS);
  }

  /** Saves right now and drops a save that was waiting (the editor is closing). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.save();
  }
}
