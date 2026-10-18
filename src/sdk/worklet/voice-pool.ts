/** What the pool needs to know about a voice: extend it with your own state (oscillator phases, filters). */
export interface Voice {
  /** The note this voice plays (-1 when free). */
  noteId: number;
  /** MIDI key. */
  key: number;
  /** False when the voice is free. */
  active: boolean;
  /** True from the note off until the voice is freed. */
  releasing: boolean;
  /** Start order, maintained by the pool. */
  age: number;
}

/** Fixed-size voice allocation for worklet instruments (no allocation after construction). */
export class VoicePool<V extends Voice> {
  /** Every voice, free or not: loop over this to render. */
  readonly voices: V[];
  private clock = 0;

  /** `size` voices made by `make`. */
  constructor(size: number, make: () => V) {
    this.voices = Array.from({ length: size }, make);
  }

  /** Takes a free voice, else the oldest releasing one, else the oldest. */
  start(noteId: number, key: number): V {
    let pick: V | undefined;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i] as V;
      if (!v.active) {
        pick = v;
        break;
      }
      if (!pick || (v.releasing && !pick.releasing) || (v.releasing === pick.releasing && v.age < pick.age)) pick = v;
    }
    const v = pick as V;
    v.noteId = noteId;
    v.key = key;
    v.active = true;
    v.releasing = false;
    v.age = ++this.clock;
    return v;
  }

  /** The sounding voice playing `noteId`, if any. */
  find(noteId: number): V | undefined {
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i] as V;
      if (v.active && v.noteId === noteId) return v;
    }
    return undefined;
  }

  /** Marks the voice for `noteId` as releasing and returns it. */
  release(noteId: number): V | undefined {
    const v = this.find(noteId);
    if (v) v.releasing = true;
    return v;
  }

  /** Marks every sounding voice as releasing (the notes are off, the tails ring out). */
  releaseAll(): void {
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i] as V;
      if (v.active) v.releasing = true;
    }
  }

  /** Gives a voice back to the pool (call it when its release has died away). */
  free(v: V): void {
    v.active = false;
    v.releasing = false;
    v.noteId = -1;
  }

  /** Frees every voice at once (a panic or reset). */
  freeAll(): void {
    for (let i = 0; i < this.voices.length; i++) this.free(this.voices[i] as V);
  }

  /** How many voices are sounding. */
  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.voices.length; i++) if ((this.voices[i] as V).active) n++;
    return n;
  }
}
