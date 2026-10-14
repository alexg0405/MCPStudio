/**
 * Extension points for the app's right-click menus: a feature adds entries to a scope (a playlist
 * clip, a mixer strip, …) and the window that owns the menu appends them to its own.
 */
import type { Services } from '@app/services';
import type { ChannelId, Clip, InsertId, LaneId, MarkerId, NoteId, PatternId, SlotId, Tick } from '@core/model/types';
import type { MenuEntry } from './controls/ContextMenu';

export interface MenuScopes {
  'playlist.clip': { clip: Clip };
  'playlist.lane': { laneId: LaneId };
  /** Right-click on a marker flag in the ruler. */
  'playlist.marker': { markerId: MarkerId };
  /** Right-click on an empty spot of the ruler (the song position there). */
  'playlist.ruler': { tick: Tick };
  'mixer.strip': { insertId: InsertId };
  'mixer.slot': { insertId: InsertId; slotId: SlotId };
  'rack.channel': { channelId: ChannelId };
  /** Right-click on notes (the clicked note and the selection). */
  'pianoRoll.note': { channelId: ChannelId; patternId: PatternId; noteIds: readonly NoteId[]; tick: Tick; key: number };
  /** Right-click on an empty spot of the piano roll. */
  'pianoRoll.empty': { channelId: ChannelId; patternId: PatternId; tick: Tick; key: number };
}

export type MenuScope = keyof MenuScopes;
type Provider<S extends MenuScope> = (ctx: MenuScopes[S], s: Services) => MenuEntry[];

const providers = new Map<MenuScope, Provider<never>[]>();

export function addContextMenuItems<S extends MenuScope>(scope: S, provider: Provider<S>): () => void {
  const list = providers.get(scope) ?? [];
  list.push(provider as Provider<never>);
  providers.set(scope, list);
  return () => {
    const l = providers.get(scope);
    const i = l?.indexOf(provider as Provider<never>) ?? -1;
    if (l && i >= 0) l.splice(i, 1);
  };
}

/** Entries features added for the scope, each feature's group after a separator (append to a built-in menu). */
export function extraMenuItems<S extends MenuScope>(scope: S, ctx: MenuScopes[S], s: Services): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const p of providers.get(scope) ?? []) {
    const entries = (p as Provider<S>)(ctx, s);
    if (entries.length === 0) continue;
    out.push({ kind: 'separator' }, ...entries);
  }
  return out;
}
