/** The note events an instrument receives from the host. */

/** A note starting, as the host hands it to an instrument (`InstrumentInstance.noteOn`, `WorkletPort.noteOn`). */
export interface NoteOn {
  /** AudioContext time in seconds. May be slightly in the past for live input; start ASAP then. */
  time: number;
  /** Unique per note; pairs the noteOff with its noteOn. */
  noteId: number;
  /** MIDI key 0–127 (60 = FL's C5). */
  key: number;
  /** 0–1. */
  velocity: number;
  /** -1 … 1, from the note's pan. */
  pan?: number;
  /** Fine pitch in cents (−100…100), from the note. Add it to the voice's detune. */
  fine?: number;
  /** Seconds into the sound to start at (set for audio clips that start mid-way). */
  offset?: number;
}

/** A note ending (`InstrumentInstance.noteOff`, `WorkletPort.noteOff`). */
export interface NoteOff {
  /** If this is at or before the note's start, the note is cancelled (never sounds). */
  time: number;
  noteId: number;
  key: number;
  /** Release velocity 0–1 (the note's "release"); absent = 0.5. */
  release?: number;
}
