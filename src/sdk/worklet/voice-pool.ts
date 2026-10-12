/** Fixed-size voice allocation for worklet instruments (no allocation after construction). */
export interface Voice {
  noteId: number;
  key: number;
  active: boolean;
  releasing: boolean;
  /** Start order, maintained by the pool. */
  age: number;
}

export class VoicePool<V extends Voice> {
  readonly voices: V[];
  private clock = 0;

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

  releaseAll(): void {
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i] as V;
      if (v.active) v.releasing = true;
    }
  }

  free(v: V): void {
    v.active = false;
    v.releasing = false;
    v.noteId = -1;
  }

  freeAll(): void {
    for (let i = 0; i < this.voices.length; i++) this.free(this.voices[i] as V);
  }

  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.voices.length; i++) if ((this.voices[i] as V).active) n++;
    return n;
  }
}
