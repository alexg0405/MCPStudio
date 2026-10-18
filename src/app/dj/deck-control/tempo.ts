/**
 * Tempo: the pitch fader and its range, key lock, and sync (a follower deck matching a master deck's tempo and beat
 * phase, in step with it as the master's pitch moves).
 */
import { clampPitch, rangeFor, syncPlan, type DeckGrid } from '@core/dj/decks-math';
import type { SyncSpec } from '@engine/deck/deck-id';
import { DECK_IDS, type DeckId, type DeckState } from '../decks-api';
import type { DeckContext } from './context';

/** The tempo (BPM) a deck is playing at: its song's tempo with the pitch applied. */
function playingBpmOf(deck: DeckState): number | null {
  return deck.baseBpm === null ? null : deck.baseBpm * (1 + deck.pitch);
}

/** The pitch, tempo and sync controls of one set of decks. */
export interface Tempo {
  setPitch(deckId: DeckId, pitch: number): void;
  setPitchRange(deckId: DeckId, range: DeckState['pitchRange']): void;
  setKeyLock(deckId: DeckId, on: boolean): void;
  /** Turns sync on or off for a follower deck (toggles when `on` is not given). */
  sync(deckId: DeckId, on?: boolean): void;
  /** Takes a deck out of sync (its pitch stays where the sync left it). */
  unsync(deckId: DeckId): void;
  /** Hands a follower's player what it needs to follow its master (after a new audio graph, say). */
  sendSync(deckId: DeckId): void;
  /** The tempo (BPM) a deck is playing at, or null while its song has no known tempo. */
  bpmOf(deckId: DeckId): number | null;
}

export function createTempo(context: DeckContext): Tempo {
  const { deps, runtime, deckState, patchDeck, channelOf } = context;

  function sendTempo(deckId: DeckId): void {
    const deck = deckState(deckId);
    channelOf(deckId)?.send({ t: 'tempo', rate: 1 + deck.pitch, keyLock: deck.keyLock });
  }

  function bpmOf(deckId: DeckId): number | null {
    return playingBpmOf(deckState(deckId));
  }

  /** Sets the pitch (clamped to the fader's range), tells the player, and moves the decks that follow this one. */
  function applyPitch(deckId: DeckId, pitch: number): void {
    const deck = deckState(deckId);
    const clamped = clampPitch(pitch, deck.pitchRange);
    patchDeck(deckId, { pitch: clamped, bpm: deck.baseBpm === null ? null : deck.baseBpm * (1 + clamped) });
    sendTempo(deckId);
    updateFollowers(deckId);
  }

  function setPitch(deckId: DeckId, pitch: number): void {
    if (runtime[deckId].syncMaster) unsync(deckId);
    applyPitch(deckId, pitch);
  }

  function setPitchRange(deckId: DeckId, range: DeckState['pitchRange']): void {
    patchDeck(deckId, { pitchRange: range });
    applyPitch(deckId, deckState(deckId).pitch);
  }

  function setKeyLock(deckId: DeckId, on: boolean): void {
    patchDeck(deckId, { keyLock: on });
    sendTempo(deckId);
  }

  /** Followers keep their own pitch shown and sent in step with their master's. */
  function updateFollowers(masterId: DeckId): void {
    const masterBpm = bpmOf(masterId);
    if (masterBpm === null) return;
    for (const followerId of DECK_IDS) {
      const follower = deckState(followerId);
      const { syncMaster, syncMultiple } = runtime[followerId];
      if (syncMaster !== masterId || follower.baseBpm === null) continue;
      const pitch = masterBpm / (follower.baseBpm * syncMultiple) - 1;
      const range = rangeFor(pitch);
      if (range === null) {
        unsync(followerId);
        deps.toast(`Deck ${followerId} came out of sync: deck ${masterId}’s tempo is too far from its song’s.`, 'error');
        continue;
      }
      patchDeck(followerId, {
        pitch,
        pitchRange: Math.max(follower.pitchRange, range) as DeckState['pitchRange'],
        bpm: masterBpm / syncMultiple,
      });
      sendTempo(followerId);
      updateFollowers(followerId);
    }
  }

  /** The deck to follow: a playing deck that isn't itself following, else any playing deck, else any other loaded deck. */
  function pickMaster(followerId: DeckId): DeckId | null {
    const candidates = DECK_IDS.filter((id) => id !== followerId && deckState(id).song && runtime[id].grid);
    const followsThisDeck = (id: DeckId) => runtime[id].syncMaster === followerId;
    const isFree = (id: DeckId) => runtime[id].syncMaster === null;
    return (
      candidates.find((id) => deckState(id).playing && isFree(id)) ??
      candidates.find((id) => deckState(id).playing && !followsThisDeck(id)) ??
      candidates.find((id) => !followsThisDeck(id)) ??
      null
    );
  }

  /** What a follower's player needs to follow its master: the master's shared state and both songs' grids in frames. */
  function syncSpecFor(deckId: DeckId): SyncSpec | null {
    const { syncMaster, syncMultiple, grid: followerGrid } = runtime[deckId];
    const masterChannel = syncMaster ? channelOf(syncMaster) : null;
    const masterGrid = syncMaster ? runtime[syncMaster].grid : null;
    if (!syncMaster || !masterChannel || !masterGrid || !followerGrid) return null;
    const rate = context.sampleRate();
    // A song with tracked beats (its tempo drifts) hands them over in frames: the player follows the beats it has.
    const beatsInFrames = (grid: DeckGrid) => (grid.map && grid.beats ? Float64Array.from(grid.beats, (sec) => sec * rate) : undefined);
    const selfBeats = beatsInFrames(followerGrid);
    const masterBeats = beatsInFrames(masterGrid);
    return {
      master: masterChannel.stateBuffer,
      ratio: masterGrid.bpm / (followerGrid.bpm * syncMultiple),
      selfFirst: followerGrid.firstDownbeat * rate,
      selfBeat: (60 / (followerGrid.bpm * syncMultiple)) * rate,
      masterFirst: masterGrid.firstDownbeat * rate,
      masterBeat: (60 / masterGrid.bpm) * rate,
      selfMult: syncMultiple,
      ...(selfBeats ? { selfBeats } : {}),
      ...(masterBeats ? { masterBeats } : {}),
    };
  }

  function sendSync(deckId: DeckId): void {
    const channel = channelOf(deckId);
    const spec = syncSpecFor(deckId);
    if (channel && spec) channel.send({ t: 'sync', sync: spec });
  }

  function unsync(deckId: DeckId): void {
    const deckRuntime = runtime[deckId];
    if (deckRuntime.syncMaster === null && !deckState(deckId).synced) return;
    deckRuntime.syncMaster = null;
    channelOf(deckId)?.send({ t: 'sync', sync: null });
    patchDeck(deckId, { synced: false });
  }

  function sync(deckId: DeckId, on?: boolean): void {
    const deck = deckState(deckId);
    const wantsSync = on ?? !deck.synced;
    if (!wantsSync) return unsync(deckId);
    const deckRuntime = runtime[deckId];
    if (!deck.song || !deckRuntime.grid || deck.baseBpm === null) {
      deps.toast(`Deck ${deckId} has no steady beat to sync (its song wasn’t analyzed, or has no clear tempo).`, 'error');
      return;
    }
    const masterId = pickMaster(deckId);
    if (!masterId) {
      deps.toast('Load a second song on another deck to sync to.', 'error');
      return;
    }
    const masterBpm = bpmOf(masterId);
    if (masterBpm === null) return;
    const plan = syncPlan(masterBpm, deck.baseBpm);
    const range = rangeFor(plan.pitch);
    if (range === null) {
      deps.toast(`Deck ${deckId}’s song is too far from deck ${masterId}’s tempo to sync (more than 50% apart).`, 'error');
      return;
    }
    deckRuntime.syncMaster = masterId;
    deckRuntime.syncMultiple = plan.multiple;
    patchDeck(deckId, {
      synced: true,
      pitch: plan.pitch,
      pitchRange: Math.max(deck.pitchRange, range) as DeckState['pitchRange'],
      bpm: masterBpm / plan.multiple,
    });
    sendTempo(deckId);
    sendSync(deckId);
    // Playing next to a playing master: land on its beat now.
    if (deck.playing && deckState(masterId).playing) channelOf(deckId)?.send({ t: 'align' });
    updateFollowers(deckId);
  }

  return { setPitch, setPitchRange, setKeyLock, sync, unsync, sendSync, bpmOf };
}
