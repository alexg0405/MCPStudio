import { VoicePool } from '@agstudio/sdk/worklet';
import { HeldNotes } from './held-notes.kernel';
import { WavetableVoice } from './voice.kernel';

const VOICES = 16;

// Note events queue up between render calls: six numbers each.
const MAX_EVENTS = 256;
const EVENT_SIZE = 6;
const EVENT_TYPE = 0;
const EVENT_NOTE_ID = 1;
const EVENT_KEY = 2;
const EVENT_VELOCITY = 3;
const EVENT_PAN = 4;
const EVENT_FINE_CENTS = 5;
const EVENT_NOTE_ON = 1;
const EVENT_NOTE_OFF = 2;
const EVENT_ALL_OFF = 3;
const EVENT_ALL_OFF_HARD = 4;

/** Positions in the voiceMode param's options. */
const MODE_MONO = 1;
const MODE_LEGATO = 2;

/**
 * Hands notes to voices for the Wavetable synth: poly (a voice per note), mono and legato (every note on
 * the first voice, with a stack of held keys to fall back to), and glide from one note's pitch to the next.
 *
 * Note calls only queue an event; `handleEvents` applies them at the start of the next render, with that
 * block's voice mode and glide, so the settings apply from the very first note of an export.
 */
export class VoiceAllocator {
  readonly pool: VoicePool<WavetableVoice>;
  private readonly events = new Float64Array(MAX_EVENTS * EVENT_SIZE);
  private eventCount = 0;
  /** Held notes for mono/legato. */
  private readonly held = new HeldNotes();
  /** The last note's pitch (where the next note glides from). */
  private lastPitch = -1;

  constructor(controlRate: number) {
    let voiceNumber = 1;
    // Each voice gets its own noise seed, so unison and chord noise is not the same sample stream.
    this.pool = new VoicePool(VOICES, () => new WavetableVoice(controlRate, 1000 + 7919 * voiceNumber++));
  }

  /** True when events are waiting for `handleEvents`. */
  get hasPendingEvents(): boolean {
    return this.eventCount > 0;
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fineCents: number): void {
    this.pushEvent(EVENT_NOTE_ON, noteId, key, velocity, pan, fineCents);
  }

  noteOff(noteId: number, key: number): void {
    this.pushEvent(EVENT_NOTE_OFF, noteId, key, 0, 0, 0);
  }

  allNotesOff(isHard: boolean): void {
    this.pushEvent(isHard ? EVENT_ALL_OFF_HARD : EVENT_ALL_OFF, 0, 0, 0, 0, 0);
  }

  /** Forgets queued events and held keys and silences every voice. */
  reset(): void {
    this.eventCount = 0;
    this.held.clear();
    const voices = this.pool.voices;
    for (let i = 0; i < voices.length; i++) this.silence(voices[i] as WavetableVoice);
  }

  /** Frees a voice at once: no release tail. */
  silence(voice: WavetableVoice): void {
    this.pool.free(voice);
    voice.needsSetUp = false;
    voice.gain = 0;
    voice.gainStep = 0;
    voice.ampEnv.reset();
    voice.modEnv.reset();
  }

  private pushEvent(type: number, noteId: number, key: number, velocity: number, pan: number, fineCents: number): void {
    if (this.eventCount >= MAX_EVENTS) return;
    const events = this.events;
    const offset = this.eventCount++ * EVENT_SIZE;
    events[offset + EVENT_TYPE] = type;
    events[offset + EVENT_NOTE_ID] = noteId;
    events[offset + EVENT_KEY] = key;
    events[offset + EVENT_VELOCITY] = velocity;
    events[offset + EVENT_PAN] = pan;
    events[offset + EVENT_FINE_CENTS] = fineCents;
  }

  /**
   * Starts, glides and releases voices for the queued note events. `mode` is the voiceMode param's option
   * (poly, mono or legato) and `glideSteps` the glide time in control steps (0 = no glide).
   */
  handleEvents(mode: number, glideSteps: number): void {
    const events = this.events;
    for (let n = 0; n < this.eventCount; n++) {
      const offset = n * EVENT_SIZE;
      const type = events[offset + EVENT_TYPE] as number;
      const noteId = events[offset + EVENT_NOTE_ID] as number;
      if (type === EVENT_NOTE_ON) {
        const key = events[offset + EVENT_KEY] as number;
        const velocity = events[offset + EVENT_VELOCITY] as number;
        const pan = events[offset + EVENT_PAN] as number;
        const fineCents = events[offset + EVENT_FINE_CENTS] as number;
        this.startNote(noteId, key, velocity, pan, fineCents, mode, glideSteps);
      } else if (type === EVENT_NOTE_OFF) this.stopNote(noteId, mode, glideSteps);
      else this.stopAll(type === EVENT_ALL_OFF_HARD);
    }
    this.eventCount = 0;
  }

  private startNote(
    noteId: number,
    key: number,
    velocity: number,
    pan: number,
    fineCents: number,
    mode: number,
    glideSteps: number,
  ): void {
    const glideFrom = this.lastPitch;
    this.lastPitch = key;
    if (mode === MODE_MONO || mode === MODE_LEGATO) {
      this.startMonoNote(noteId, key, velocity, pan, fineCents, mode, glideSteps, glideFrom);
      return;
    }
    const voice = this.pool.start(noteId, key);
    voice.needsSetUp = true;
    voice.velocity = velocity;
    voice.notePan = pan;
    voice.fineCents = fineCents;
    voice.countdown = 0;
    this.glideTo(voice, key, glideFrom >= 0 && glideSteps > 0 ? glideFrom : key, glideSteps);
  }

  /** Mono and legato play every note on the first voice; legato slides between overlapping notes without a new attack. */
  private startMonoNote(
    noteId: number,
    key: number,
    velocity: number,
    pan: number,
    fineCents: number,
    mode: number,
    glideSteps: number,
    glideFrom: number,
  ): void {
    const wasHeld = this.held.count > 0;
    this.held.push(noteId, key);
    const voice = this.pool.voices[0] as WavetableVoice;
    // Only the first voice plays in mono modes.
    for (let k = 1; k < this.pool.voices.length; k++) {
      const other = this.pool.voices[k] as WavetableVoice;
      if (other.active) this.release(other);
    }
    const isSounding = voice.active && !voice.releasing;
    voice.noteId = noteId;
    voice.velocity = velocity;
    voice.notePan = pan;
    voice.fineCents = fineCents;
    let slideFrom = key;
    if (glideSteps > 0) {
      if (isSounding) slideFrom = voice.pitch;
      else if (glideFrom >= 0) slideFrom = glideFrom;
    }
    this.glideTo(voice, key, slideFrom, glideSteps);
    if (mode === MODE_LEGATO && wasHeld && isSounding) return; // slide, no new attack
    voice.active = true;
    voice.releasing = false;
    voice.needsSetUp = true;
    voice.countdown = 0;
  }

  private glideTo(voice: WavetableVoice, key: number, from: number, steps: number): void {
    voice.key = key;
    voice.glideFrom = from;
    voice.glideSteps = from === key ? 0 : steps;
    voice.glideStep = 0;
    if (voice.glideSteps === 0) voice.pitch = key;
  }

  private stopNote(noteId: number, mode: number, glideSteps: number): void {
    if (mode === MODE_MONO || mode === MODE_LEGATO) {
      this.stopMonoNote(noteId, glideSteps);
      return;
    }
    const voice = this.pool.find(noteId);
    if (voice) this.release(voice);
  }

  private stopMonoNote(noteId: number, glideSteps: number): void {
    this.held.remove(noteId);
    const voice = this.pool.voices[0] as WavetableVoice;
    if (!voice.active || voice.noteId !== noteId) return;
    if (this.held.count > 0) {
      // Back to the most recent key still held, without a new attack.
      const key = this.held.lastKey;
      voice.noteId = this.held.lastNoteId;
      this.glideTo(voice, key, glideSteps > 0 ? voice.pitch : key, glideSteps);
      this.lastPitch = key;
      return;
    }
    this.release(voice);
  }

  private release(voice: WavetableVoice): void {
    // Released before it ever sounded: the note was cancelled.
    if (voice.needsSetUp) {
      this.silence(voice);
      return;
    }
    voice.releasing = true;
    voice.ampEnv.release();
    voice.modEnv.release();
  }

  private stopAll(isHard: boolean): void {
    this.held.clear();
    const voices = this.pool.voices;
    for (let k = 0; k < voices.length; k++) {
      const voice = voices[k] as WavetableVoice;
      if (!voice.active) continue;
      if (isHard) this.silence(voice);
      else this.release(voice);
    }
  }
}
