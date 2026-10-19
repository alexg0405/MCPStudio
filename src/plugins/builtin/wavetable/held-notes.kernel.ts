/** Room for this many held keys in mono and legato (more are ignored: nobody has more than ten fingers). */
const MAX_HELD = 64;

/**
 * The keys held down in mono and legato modes, oldest first, so releasing the newest note can fall back to the
 * one before it. Preallocated: no allocation on the audio thread.
 */
export class HeldNotes {
  private readonly noteIds = new Float64Array(MAX_HELD);
  private readonly keys = new Float64Array(MAX_HELD);
  /** How many keys are held. */
  count = 0;

  /** The key pressed most recently of those still held (only meaningful while `count` > 0). */
  get lastKey(): number {
    return this.keys[this.count - 1] as number;
  }

  /** The note id of that key. */
  get lastNoteId(): number {
    return this.noteIds[this.count - 1] as number;
  }

  push(noteId: number, key: number): void {
    if (this.count >= MAX_HELD) return;
    this.noteIds[this.count] = noteId;
    this.keys[this.count] = key;
    this.count++;
  }

  /** Forgets the note, keeping the order of the others. */
  remove(noteId: number): void {
    let position = -1;
    for (let k = 0; k < this.count; k++) if (this.noteIds[k] === noteId) position = k;
    if (position < 0) return;
    for (let k = position; k < this.count - 1; k++) {
      this.noteIds[k] = this.noteIds[k + 1] as number;
      this.keys[k] = this.keys[k + 1] as number;
    }
    this.count--;
  }

  clear(): void {
    this.count = 0;
  }
}
