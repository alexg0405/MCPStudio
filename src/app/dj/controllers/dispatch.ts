/**
 * Control events (what a controller did) → calls on the live decks. Deck state is live performance
 * state, not the project: nothing here goes through History.
 */
import type { ControlEvent } from '@core/midi-map/interpreter';
import { parseTarget } from '@core/midi-map/targets';
import { HOT_CUES, type DeckId, type DecksApi } from '../decks-api';
import { ABS_CONTROLS } from './abs';
import type { BrowseCursor } from './browse';

/** Jog ticks that make one turn of the platter (controllers send 250–1000 per turn). */
export const JOG_TICKS_PER_TURN = 600;
/** Seconds one "search" step (shift + jog, or a search dial) moves through the song. */
export const SEARCH_SEC_PER_STEP = 0.25;
/** Songs one step of the fast browse encoder moves. */
export const BROWSE_FAST_STEP = 10;

/** App commands a controller can run (target id → command id). */
export const APP_COMMANDS: Record<string, string> = {
  'app.playPause': 'transport.playPause',
  'app.stop': 'transport.stop',
};

export interface DispatchEnv {
  decks: DecksApi;
  browse: BrowseCursor;
  runCommand(id: string): void;
  /** Called when something went wrong the musician should hear about (a song could not be loaded). */
  report?(message: string): void;
}

export class DjDispatcher {
  /** Decks whose jog platter is being touched (the jog scratches while it is). */
  private readonly touching = new Set<DeckId>();

  constructor(private env: DispatchEnv) {}

  setEnv(env: DispatchEnv): void {
    this.env = env;
  }

  isTouching(deck: DeckId): boolean {
    return this.touching.has(deck);
  }

  apply(ev: ControlEvent): void {
    if (ev.kind === 'abs') return this.abs(ev.target, ev.value);
    if (ev.kind === 'rel') return this.rel(ev.target, ev.delta);
    this.button(ev.target, ev.down);
  }

  /** Writes a hardware position to an absolute target (soft takeover has already decided it may). */
  abs(target: string, value: number): void {
    const p = parseTarget(target);
    if (!p) return;
    ABS_CONTROLS[p.fn]?.write(this.env.decks, p.deck, value);
  }

  private rel(target: string, delta: number): void {
    const p = parseTarget(target);
    if (!p) return;
    const { decks, browse } = this.env;
    const deck = p.deck;
    switch (p.fn) {
      case 'jog':
        if (deck) decks.jog(deck, delta / JOG_TICKS_PER_TURN, this.touching.has(deck) ? 'scratch' : 'nudge');
        break;
      case 'jogNudge':
        if (deck) decks.jog(deck, delta / JOG_TICKS_PER_TURN, 'nudge');
        break;
      case 'jogScratch':
        if (deck) decks.jog(deck, delta / JOG_TICKS_PER_TURN, 'scratch');
        break;
      case 'search':
        if (deck) decks.seek(deck, decks.positionNow(deck) + delta * SEARCH_SEC_PER_STEP);
        break;
      case 'browse':
        browse.move(delta);
        break;
      case 'browseFast':
        browse.move(delta * BROWSE_FAST_STEP);
        break;
    }
  }

  private button(target: string, down: boolean): void {
    const p = parseTarget(target);
    if (!p) return;
    const { decks, browse } = this.env;
    const deck = p.deck;
    // Buttons that act on release or on both edges.
    if (p.fn === 'cue' && deck) return down ? decks.cueDown(deck) : decks.cueUp(deck);
    if (p.fn === 'jogTouch' && deck) {
      if (down) this.touching.add(deck);
      else this.touching.delete(deck);
      return decks.jogTouch(deck, down);
    }
    if (!down) return;
    const state = decks.store.getState();
    const ds = deck ? state.decks[deck] : undefined;
    switch (p.fn) {
      case 'play':
        if (deck) decks.togglePlay(deck);
        break;
      case 'sync':
        if (deck && ds) decks.sync(deck, !ds.synced);
        break;
      case 'keylock':
        if (deck && ds) decks.setKeyLock(deck, !ds.keyLock);
        break;
      case 'pfl':
        if (deck && ds) decks.setCueListen(deck, !ds.cueListen);
        break;
      case 'eject':
        if (deck) decks.eject(deck);
        break;
      case 'load':
        if (deck) void this.load(deck, browse);
        break;
      case 'hotcue':
        if (deck && p.arg !== undefined && p.arg >= 1 && p.arg <= HOT_CUES) decks.hotCue(deck, p.arg - 1);
        break;
      case 'hotcueClear':
        if (deck && p.arg !== undefined && p.arg >= 1 && p.arg <= HOT_CUES) decks.clearHotCue(deck, p.arg - 1);
        break;
      case 'loopIn':
        if (deck) decks.loopIn(deck);
        break;
      case 'loopOut':
        if (deck) decks.loopOut(deck);
        break;
      case 'loopExit':
        if (deck) decks.exitLoop(deck);
        break;
      case 'loopHalve':
        if (deck) decks.loopHalve(deck);
        break;
      case 'loopDouble':
        if (deck) decks.loopDouble(deck);
        break;
      case 'autoLoop':
        if (deck && ds && p.arg !== undefined) {
          // The same pad again leaves the loop.
          if (ds.loop?.active && loopBeats(ds) === p.arg) decks.exitLoop(deck);
          else decks.autoLoop(deck, p.arg);
        }
        break;
      case 'beatJumpBack':
        if (deck && ds) decks.beatJumpBy(deck, -ds.beatJump);
        break;
      case 'beatJumpFwd':
        if (deck && ds) decks.beatJumpBy(deck, ds.beatJump);
        break;
      case 'record':
        void (state.recording ? decks.stopRecording() : decks.startRecording());
        break;
      case 'app.playPause':
      case 'app.stop':
        this.env.runCommand(APP_COMMANDS[target]!);
        break;
    }
  }

  private async load(deck: DeckId, browse: BrowseCursor): Promise<void> {
    const song = browse.current();
    if (!song) return this.env.report?.('The music library is empty: add songs in the DJ window first.');
    try {
      await this.env.decks.load(deck, song.ref, song.title, song.artist);
    } catch (e) {
      this.env.report?.(`Could not load ${song.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Length of the deck's loop in beats of the song (0 when there is none). */
export function loopBeats(ds: { loop: { startSec: number; endSec: number } | null; baseBpm: number | null }): number {
  if (!ds.loop || !ds.baseBpm) return 0;
  return Math.round(((ds.loop.endSec - ds.loop.startSec) * ds.baseBpm * 100) / 60) / 100;
}
