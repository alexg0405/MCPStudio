/**
 * A stand-in for the live decks: keeps plausible deck state and records every call. Used by the
 * controller tests (`test/helpers/fake-decks.ts` re-exports it) and by the "no decks yet" fallback in
 * development builds, so a controller can be tried before the real decks are wired in.
 */
import { createStore } from 'zustand/vanilla';
import type { SampleRef } from '@core/model/types';
import { DECK_IDS, HOT_CUES, type DeckId, type DeckState, type DecksApi, type DecksState, type EqBand } from '../decks-api';

/** A call recorded by the stand-in decks: the method and its arguments. */
export type FakeCall = [method: string, ...args: unknown[]];

/** The state of one stand-in deck. */
export function fakeDeckState(id: DeckId): DeckState {
  return {
    id,
    song: null,
    loading: false,
    playing: false,
    positionSec: 0,
    positionAt: 0,
    baseBpm: null,
    bpm: null,
    analyzing: null,
    pitch: 0,
    pitchRange: 0.08,
    keyLock: false,
    synced: false,
    volume: 1,
    trimDb: 0,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    cueListen: false,
    cuePoint: 0,
    hotCues: Array.from({ length: HOT_CUES }, () => null),
    loop: null,
    beatJump: 4,
    level: 0,
  };
}

/** The state of the stand-in decks. */
export function fakeDecksState(): DecksState {
  return {
    decks: Object.fromEntries(DECK_IDS.map((id) => [id, fakeDeckState(id)])) as Record<DeckId, DeckState>,
    deckCount: 2,
    crossfader: 0,
    crossfaderAssign: { A: 'A', B: 'B', C: 'thru', D: 'thru' },
    crossfaderCurve: 'smooth',
    masterVolume: 1,
    recording: null,
  };
}

/** Stand-in decks that only record what they were asked (tests, and development before the real decks are wired in). */
export class FakeDecks implements DecksApi {
  readonly store = createStore<DecksState>(() => fakeDecksState());
  /** Every call, in order: `['play', 'A']`, `['setEq', 'B', 'low', -6]`… */
  readonly calls: FakeCall[] = [];

  private rec(...call: FakeCall): void {
    this.calls.push(call);
  }
  private patch(deck: DeckId, p: Partial<DeckState>): void {
    this.store.setState((s) => ({ decks: { ...s.decks, [deck]: { ...s.decks[deck], ...p } } }));
  }
  private d(deck: DeckId): DeckState {
    return this.store.getState().decks[deck];
  }

  /** The calls of one method. */
  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c[0] === method);
  }
  /** Sets state directly (a test arranging a situation); not recorded as a call. */
  arrange(deck: DeckId, p: Partial<DeckState>): void {
    this.patch(deck, p);
  }

  async load(deck: DeckId, ref: SampleRef, title: string, artist?: string): Promise<void> {
    this.rec('load', deck, ref.name, title, artist);
    this.patch(deck, {
      song: { ref, title, ...(artist !== undefined ? { artist } : {}), durationSec: 240 },
      baseBpm: 120,
      bpm: 120,
      positionSec: 0,
      playing: false,
    });
  }
  eject(deck: DeckId): void {
    this.rec('eject', deck);
    this.patch(deck, { song: null, playing: false, baseBpm: null, bpm: null });
  }
  play(deck: DeckId): void {
    this.rec('play', deck);
    this.patch(deck, { playing: true });
  }
  pause(deck: DeckId): void {
    this.rec('pause', deck);
    this.patch(deck, { playing: false });
  }
  togglePlay(deck: DeckId): void {
    this.rec('togglePlay', deck);
    this.patch(deck, { playing: !this.d(deck).playing });
  }
  cueDown(deck: DeckId): void {
    this.rec('cueDown', deck);
    const s = this.d(deck);
    if (s.playing) this.patch(deck, { playing: false, positionSec: s.cuePoint });
    else this.patch(deck, { cuePoint: s.positionSec });
  }
  cueUp(deck: DeckId): void {
    this.rec('cueUp', deck);
  }
  seek(deck: DeckId, sec: number): void {
    this.rec('seek', deck, sec);
    this.patch(deck, { positionSec: Math.max(0, sec) });
  }
  jog(deck: DeckId, delta: number, mode: 'nudge' | 'scratch'): void {
    this.rec('jog', deck, delta, mode);
  }
  jogTouch(deck: DeckId, touching: boolean): void {
    this.rec('jogTouch', deck, touching);
  }
  setPitch(deck: DeckId, pitch: number): void {
    this.rec('setPitch', deck, pitch);
    this.patch(deck, { pitch });
  }
  setPitchRange(deck: DeckId, range: DeckState['pitchRange']): void {
    this.rec('setPitchRange', deck, range);
    this.patch(deck, { pitchRange: range });
  }
  setKeyLock(deck: DeckId, on: boolean): void {
    this.rec('setKeyLock', deck, on);
    this.patch(deck, { keyLock: on });
  }
  sync(deck: DeckId, on?: boolean): void {
    this.rec('sync', deck, on);
    this.patch(deck, { synced: on ?? true });
  }
  setVolume(deck: DeckId, v: number): void {
    this.rec('setVolume', deck, v);
    this.patch(deck, { volume: v });
  }
  setTrim(deck: DeckId, db: number): void {
    this.rec('setTrim', deck, db);
    this.patch(deck, { trimDb: db });
  }
  setEq(deck: DeckId, band: EqBand, db: number): void {
    this.rec('setEq', deck, band, db);
    this.patch(deck, { eq: { ...this.d(deck).eq, [band]: db } });
  }
  setFilter(deck: DeckId, v: number): void {
    this.rec('setFilter', deck, v);
    this.patch(deck, { filter: v });
  }
  setCueListen(deck: DeckId, on: boolean): void {
    this.rec('setCueListen', deck, on);
    this.patch(deck, { cueListen: on });
  }
  setCrossfader(v: number): void {
    this.rec('setCrossfader', v);
    this.store.setState({ crossfader: v });
  }
  setCrossfaderAssign(deck: DeckId, side: 'A' | 'B' | 'thru'): void {
    this.rec('setCrossfaderAssign', deck, side);
    this.store.setState((s) => ({ crossfaderAssign: { ...s.crossfaderAssign, [deck]: side } }));
  }
  setMasterVolume(v: number): void {
    this.rec('setMasterVolume', v);
    this.store.setState({ masterVolume: v });
  }
  hotCue(deck: DeckId, i: number): void {
    this.rec('hotCue', deck, i);
    const s = this.d(deck);
    if (s.hotCues[i] == null) this.patch(deck, { hotCues: s.hotCues.map((c, k) => (k === i ? s.positionSec : c)) });
    else this.patch(deck, { positionSec: s.hotCues[i]!, playing: true });
  }
  clearHotCue(deck: DeckId, i: number): void {
    this.rec('clearHotCue', deck, i);
    this.patch(deck, { hotCues: this.d(deck).hotCues.map((c, k) => (k === i ? null : c)) });
  }
  loopIn(deck: DeckId): void {
    this.rec('loopIn', deck);
  }
  loopOut(deck: DeckId): void {
    this.rec('loopOut', deck);
  }
  autoLoop(deck: DeckId, beats: number): void {
    this.rec('autoLoop', deck, beats);
    const s = this.d(deck);
    const bpm = s.baseBpm ?? 120;
    this.patch(deck, { loop: { startSec: s.positionSec, endSec: s.positionSec + (beats * 60) / bpm, active: true } });
  }
  loopHalve(deck: DeckId): void {
    this.rec('loopHalve', deck);
  }
  loopDouble(deck: DeckId): void {
    this.rec('loopDouble', deck);
  }
  exitLoop(deck: DeckId): void {
    this.rec('exitLoop', deck);
    const l = this.d(deck).loop;
    if (l) this.patch(deck, { loop: { ...l, active: false } });
  }
  beatJumpBy(deck: DeckId, beats: number): void {
    this.rec('beatJumpBy', deck, beats);
  }
  async startRecording(): Promise<void> {
    this.rec('startRecording');
    this.store.setState({ recording: { startedAt: 0 } });
  }
  async stopRecording(): Promise<string | null> {
    this.rec('stopRecording');
    this.store.setState({ recording: null });
    return 'Recording';
  }
  positionNow(deck: DeckId): number {
    return this.d(deck).positionSec;
  }
  dispose(): void {
    this.rec('dispose');
  }
}
