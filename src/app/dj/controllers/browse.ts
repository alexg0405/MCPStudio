/**
 * The browse encoder's highlight in the music library: turn the encoder to move it, press a deck's
 * load button to put the highlighted song on that deck. The highlight is shown in the Controllers
 * window (and anywhere else that wants to show it).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SampleRef } from '@core/model/types';

/** What the cursor needs to know about a library song. */
export interface BrowseSong {
  key: string;
  ref: SampleRef;
  title: string;
  artist?: string;
  label: string;
}

export interface BrowseState {
  /** Index of the highlighted song in the library (0 when the library is empty). */
  index: number;
}

export class BrowseCursor {
  readonly store: StoreApi<BrowseState> = createStore<BrowseState>(() => ({ index: 0 }));

  constructor(private readonly songs: () => readonly BrowseSong[]) {}

  /** The highlighted song, if the library has any. */
  current(): BrowseSong | null {
    const list = this.songs();
    if (!list.length) return null;
    return list[Math.min(this.store.getState().index, list.length - 1)] ?? null;
  }

  /** Moves the highlight by `steps` songs (negative = up), stopping at the ends. */
  move(steps: number): BrowseSong | null {
    const list = this.songs();
    if (!list.length) return null;
    const index = Math.min(list.length - 1, Math.max(0, Math.min(this.store.getState().index, list.length - 1) + Math.round(steps)));
    this.store.setState({ index });
    return list[index] ?? null;
  }
}
