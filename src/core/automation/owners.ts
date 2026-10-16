import type { ChannelId, PluginOwner, Project } from '../model/types';

/** A stable string for the owner of a plugin instance (a channel's instrument, an effect slot). */
export function ownerKey(owner: PluginOwner): string {
  return owner.kind === 'channel' ? `ch:${owner.channelId}` : `fx:${owner.insertId}:${owner.slotId}`;
}

const cache = new WeakMap<Project['channels'], ReadonlySet<string>>();
let last: ReadonlySet<string> = new Set();

/**
 * The plugin instances some automation channel drives (an automation clip may or may not exist yet:
 * the channel is what says "this param is automated"). The same Set object comes back while the
 * answer doesn't change, so callers can compare by identity.
 */
export function automatedOwners(channels: Project['channels']): ReadonlySet<string> {
  const known = cache.get(channels);
  if (known) return known;
  const found = new Set<string>();
  for (const id in channels) {
    const ch = channels[id as ChannelId];
    const target = ch?.kind === 'automation' ? ch.target : null;
    if (target?.kind === 'plugin') found.add(ownerKey(target.owner));
  }
  let result: ReadonlySet<string> = found;
  if (found.size === last.size) {
    let same = true;
    for (const k of found)
      if (!last.has(k)) {
        same = false;
        break;
      }
    if (same) result = last;
  }
  last = result;
  cache.set(channels, result);
  return result;
}
