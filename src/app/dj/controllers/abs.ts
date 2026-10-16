/**
 * Faders and knobs (0–1 on the hardware) as deck values, both ways: `write` applies a hardware
 * position to the decks, `read` turns the decks' current value back into a hardware position (for
 * soft takeover). Pure functions of the deck state, tested without audio.
 */
import type { DeckId, DecksApi, DecksState } from '../decks-api';

export interface AbsControl {
  read(state: DecksState, deck: DeckId | undefined): number;
  write(decks: DecksApi, deck: DeckId | undefined, v: number): void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const TRIM_RANGE_DB = 12;
export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;
const FILTER_DEAD_ZONE = 0.04;

/** Knob position → dB: left = kill (−26 dB), centre = 0 dB, right = +6 dB. */
export function eqDbFromKnob(v: number): number {
  const x = clamp01(v);
  // "+ 0" turns -0 into 0 at the centre.
  return (x <= 0.5 ? EQ_MIN_DB * (1 - x * 2) : EQ_MAX_DB * (x * 2 - 1)) + 0;
}
export function eqKnobFromDb(db: number): number {
  return clamp01(db <= 0 ? 0.5 + db / (-EQ_MIN_DB * 2) : 0.5 + db / (EQ_MAX_DB * 2));
}

/** Knob position → filter −1…1, with a dead zone around the centre so "off" is easy to hit. */
export function filterFromKnob(v: number): number {
  const x = clamp01(v) * 2 - 1;
  if (Math.abs(x) < FILTER_DEAD_ZONE) return 0;
  return x;
}

/** Fader position → pitch (a fraction of tempo), higher = faster, within ±range. */
export const pitchFromFader = (v: number, range: number): number => (clamp01(v) - 0.5) * 2 * range;
export const faderFromPitch = (pitch: number, range: number): number => clamp01(pitch / (2 * range) + 0.5);

const deckState = (s: DecksState, deck: DeckId | undefined) => s.decks[deck ?? 'A'];

/** The absolute controls by function name (the part of the target id after "A."). */
export const ABS_CONTROLS: Record<string, AbsControl> = {
  volume: {
    read: (s, d) => clamp01(deckState(s, d).volume),
    write: (decks, d, v) => decks.setVolume(d!, clamp01(v)),
  },
  trim: {
    read: (s, d) => clamp01(0.5 + deckState(s, d).trimDb / (TRIM_RANGE_DB * 2)),
    write: (decks, d, v) => decks.setTrim(d!, (clamp01(v) * 2 - 1) * TRIM_RANGE_DB),
  },
  'eq.low': {
    read: (s, d) => eqKnobFromDb(deckState(s, d).eq.low),
    write: (decks, d, v) => decks.setEq(d!, 'low', eqDbFromKnob(v)),
  },
  'eq.mid': {
    read: (s, d) => eqKnobFromDb(deckState(s, d).eq.mid),
    write: (decks, d, v) => decks.setEq(d!, 'mid', eqDbFromKnob(v)),
  },
  'eq.high': {
    read: (s, d) => eqKnobFromDb(deckState(s, d).eq.high),
    write: (decks, d, v) => decks.setEq(d!, 'high', eqDbFromKnob(v)),
  },
  filter: {
    read: (s, d) => (deckState(s, d).filter + 1) / 2,
    write: (decks, d, v) => decks.setFilter(d!, filterFromKnob(v)),
  },
  pitch: {
    read: (s, d) => faderFromPitch(deckState(s, d).pitch, deckState(s, d).pitchRange),
    write: (decks, d, v) => decks.setPitch(d!, pitchFromFader(v, decks.store.getState().decks[d!].pitchRange)),
  },
  crossfader: {
    read: (s) => (s.crossfader + 1) / 2,
    write: (decks, _d, v) => decks.setCrossfader(clamp01(v) * 2 - 1),
  },
  masterVolume: {
    read: (s) => clamp01(s.masterVolume),
    write: (decks, _d, v) => decks.setMasterVolume(clamp01(v)),
  },
};
