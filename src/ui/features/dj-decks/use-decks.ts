import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { DeckId, DecksApi, DeckState, DecksState } from '@app/dj/decks-api';
import { useServices } from '../../services-context';

/** The decks (created on first use). Null for a moment while they start. */
export function useDecksApi(): DecksApi | null {
  const services = useServices();
  const [api, setApi] = useState<DecksApi | null>(null);
  useEffect(() => {
    let live = true;
    void services.decks().then((a) => live && setApi(a));
    return () => {
      live = false;
    };
  }, [services]);
  return api;
}

/** The parts of a deck the panel draws as React (not the position or the level: those are drawn on the frame loop). */
export type DeckView = Pick<
  DeckState,
  | 'id'
  | 'song'
  | 'loading'
  | 'playing'
  | 'baseBpm'
  | 'bpm'
  | 'analyzing'
  | 'pitch'
  | 'pitchRange'
  | 'keyLock'
  | 'synced'
  | 'cuePoint'
  | 'hotCues'
  | 'loop'
  | 'beatJump'
  | 'volume'
  | 'trimDb'
  | 'eq'
  | 'filter'
  | 'cueListen'
>;

const pickView = (d: DeckState): DeckView => ({
  id: d.id,
  song: d.song,
  loading: d.loading,
  playing: d.playing,
  baseBpm: d.baseBpm,
  bpm: d.bpm,
  analyzing: d.analyzing,
  pitch: d.pitch,
  pitchRange: d.pitchRange,
  keyLock: d.keyLock,
  synced: d.synced,
  cuePoint: d.cuePoint,
  hotCues: d.hotCues,
  loop: d.loop,
  beatJump: d.beatJump,
  volume: d.volume,
  trimDb: d.trimDb,
  eq: d.eq,
  filter: d.filter,
  cueListen: d.cueListen,
});

/** One deck as React state: re-renders when its song, buttons, cues or knobs change, not while it plays. */
export function useDeck(api: DecksApi, id: DeckId): DeckView {
  return useStore(
    api.store,
    useShallow((s: DecksState) => pickView(s.decks[id])),
  );
}

/** A piece of the shared state (crossfader, deck count…). */
export function useDecksState<T>(api: DecksApi, select: (s: DecksState) => T): T {
  return useStore(api.store, useShallow(select));
}
