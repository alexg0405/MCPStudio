import type { Services } from '@app/services';

/**
 * FL's "typing keyboard to piano keyboard": two rows of the computer keyboard play the selected
 * channel. Bottom row Z S X D C V G B H N J M , L . ; / starts at the chosen octave, the top row
 * Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P [ = ] one octave higher. Physical keys (event.code), so it
 * works on any keyboard layout.
 */
const OFFSETS: Record<string, number> = {
  KeyZ: 0,
  KeyS: 1,
  KeyX: 2,
  KeyD: 3,
  KeyC: 4,
  KeyV: 5,
  KeyG: 6,
  KeyB: 7,
  KeyH: 8,
  KeyN: 9,
  KeyJ: 10,
  KeyM: 11,
  Comma: 12,
  KeyL: 13,
  Period: 14,
  Semicolon: 15,
  Slash: 16,
  KeyQ: 12,
  Digit2: 13,
  KeyW: 14,
  Digit3: 15,
  KeyE: 16,
  KeyR: 17,
  Digit5: 18,
  KeyT: 19,
  Digit6: 20,
  KeyY: 21,
  Digit7: 22,
  KeyU: 23,
  KeyI: 24,
  Digit9: 25,
  KeyO: 26,
  Digit0: 27,
  KeyP: 28,
  BracketLeft: 29,
  Equal: 30,
  BracketRight: 31,
};

export class TypingPiano {
  /** Physical key → the note it plays. */
  private readonly down = new Map<string, number>();

  constructor(private readonly services: Services) {}

  /** Returns true when the key was consumed as a piano key. */
  keyDown(e: KeyboardEvent, inInput: boolean): boolean {
    const prefs = this.services.prefs.getState();
    if (!prefs.typingPiano || inInput || e.ctrlKey || e.metaKey || e.altKey) return false;
    const offset = OFFSETS[e.code];
    if (offset === undefined) return false;
    e.preventDefault();
    if (e.repeat || this.down.has(e.code)) return true;
    const key = Math.max(0, Math.min(127, prefs.pianoOctave * 12 + offset));
    this.services.live.noteOn(key, 0.8, { source: 'typing' }, e.timeStamp);
    this.down.set(e.code, key);
    return true;
  }

  keyUp(e: KeyboardEvent): boolean {
    const key = this.down.get(e.code);
    if (key === undefined) return false;
    this.down.delete(e.code);
    this.services.live.noteOff(key, 0.5, { source: 'typing' }, e.timeStamp);
    return true;
  }

  /** Releases everything (window lost focus while keys were held). */
  releaseAll(): void {
    this.down.clear();
    this.services.live.releaseAll('typing');
  }
}
