/**
 * The mixer: channel faders, trim, EQ, filter, the cue (headphone) button, the crossfader and its fades, and the
 * master volume. Each control keeps its value in the state and tells the player's channel (or the master) the same.
 */
import { clampEq, clampTrim, crossfadeAt, FADER_MAX } from '@core/dj/decks-math';
import { DECK_IDS, type DeckId, type EqBand } from '../decks-api';
import type { DeckContext } from './context';
import type { Tempo } from './tempo';

/** The master volume can be pushed to 1.5 (+3.5 dB) for a quiet recording. */
const MASTER_VOLUME_MAX = 1.5;

/** A crossfade glide updates the crossfader this often (ms): fast enough to sound smooth. */
const CROSSFADE_STEP_MS = 20;

/** A glide shorter than this (seconds) is just a jump. */
const MIN_GLIDE_SEC = 0.03;

/** The tempo a glide is timed in when no deck knows its tempo (BPM). */
const FALLBACK_BPM = 120;

/** Clamps a knob that runs from −1 to +1; anything that isn't a number reads as `fallback`. */
function clampBipolar(value: number, fallback: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : fallback));
}

/** The mixer controls of one set of decks. */
export interface Mixer {
  setVolume(deckId: DeckId, volume: number): void;
  setTrim(deckId: DeckId, db: number): void;
  setEq(deckId: DeckId, band: EqBand, db: number): void;
  setFilter(deckId: DeckId, value: number): void;
  setCueListen(deckId: DeckId, on: boolean): void;
  setCrossfader(position: number): void;
  setCrossfaderAssign(deckId: DeckId, side: 'A' | 'B' | 'thru'): void;
  setCrossfaderCurve(curve: 'smooth' | 'sharp'): void;
  setMasterVolume(volume: number): void;
  /** Glides the crossfader to `to` over `beats` beats of the tempo that is playing. */
  crossfade(to: number, beats: number): void;
  /** Stops a glide that is running (closing the decks). */
  cancelFade(): void;
}

export function createMixer(context: DeckContext, tempo: Tempo): Mixer {
  const { store, deckState, patchDeck, channelOf, now } = context;
  let fadeTimer: ReturnType<typeof setInterval> | null = null;

  function setVolume(deckId: DeckId, volume: number): void {
    const clamped = Math.max(0, Math.min(FADER_MAX, Number.isFinite(volume) ? volume : 0));
    patchDeck(deckId, { volume: clamped });
    channelOf(deckId)?.setFader(clamped);
  }

  function setTrim(deckId: DeckId, db: number): void {
    const clamped = clampTrim(db);
    patchDeck(deckId, { trimDb: clamped });
    channelOf(deckId)?.setTrim(clamped);
  }

  function setEq(deckId: DeckId, band: EqBand, db: number): void {
    const clamped = clampEq(db);
    patchDeck(deckId, { eq: { ...deckState(deckId).eq, [band]: clamped } });
    channelOf(deckId)?.setEq(band, clamped);
  }

  function setFilter(deckId: DeckId, value: number): void {
    const clamped = clampBipolar(value, 0);
    patchDeck(deckId, { filter: clamped });
    channelOf(deckId)?.setFilter(clamped);
  }

  function setCueListen(deckId: DeckId, on: boolean): void {
    patchDeck(deckId, { cueListen: on });
    channelOf(deckId)?.setCueListen(on);
  }

  /** Tells every channel how the crossfader treats it now. */
  function applyCrossfade(): void {
    const state = store.getState();
    for (const deckId of DECK_IDS) {
      channelOf(deckId)?.setCrossfade(state.crossfaderAssign[deckId], state.crossfader, state.crossfaderCurve);
    }
  }

  function cancelFade(): void {
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
  }

  function setCrossfader(position: number): void {
    cancelFade();
    store.setState({ crossfader: clampBipolar(position, 0) });
    applyCrossfade();
  }

  function setCrossfaderAssign(deckId: DeckId, side: 'A' | 'B' | 'thru'): void {
    store.setState((state) => ({ crossfaderAssign: { ...state.crossfaderAssign, [deckId]: side } }));
    applyCrossfade();
  }

  function setCrossfaderCurve(curve: 'smooth' | 'sharp'): void {
    store.setState({ crossfaderCurve: curve });
    applyCrossfade();
  }

  function setMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(MASTER_VOLUME_MAX, Number.isFinite(volume) ? volume : 1));
    store.setState({ masterVolume: clamped });
    context.graph?.setMasterVolume(clamped);
  }

  /** The tempo a glide is timed in: the first playing deck's, else the first loaded deck's, else a default. */
  function glideTempoBpm(): number {
    const playingId = DECK_IDS.find((deckId) => deckState(deckId).playing);
    const referenceId = playingId ?? DECK_IDS.find((deckId) => deckState(deckId).song) ?? 'A';
    return tempo.bpmOf(referenceId) ?? FALLBACK_BPM;
  }

  function crossfade(to: number, beats: number): void {
    const target = Math.max(-1, Math.min(1, to));
    const durationSec = (Math.max(0, beats) * 60) / glideTempoBpm();
    cancelFade();
    const from = store.getState().crossfader;
    if (durationSec < MIN_GLIDE_SEC) return setCrossfader(target);
    const startMs = now();
    fadeTimer = setInterval(() => {
      const progress = Math.min(1, (now() - startMs) / 1000 / durationSec);
      store.setState({ crossfader: crossfadeAt(from, target, progress) });
      applyCrossfade();
      if (progress >= 1) cancelFade();
    }, CROSSFADE_STEP_MS);
  }

  return {
    setVolume,
    setTrim,
    setEq,
    setFilter,
    setCueListen,
    setCrossfader,
    setCrossfaderAssign,
    setCrossfaderCurve,
    setMasterVolume,
    crossfade,
    cancelFade,
  };
}
