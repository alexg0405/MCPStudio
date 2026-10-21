import type { Project } from '../model/types';

/** Where one plugin is used in a project: instrument channels and effect slots, by name. */
export interface PluginUse {
  /** Instrument channels that play it. */
  channels: { id: string; name: string }[];
  /** Mixer tracks with it as an effect. */
  inserts: { id: string; name: string; slotId: string }[];
}

/** How many places use it (channels plus effect slots). */
export const useCount = (use: PluginUse): number => use.channels.length + use.inserts.length;

/** Every plugin id a project uses, with where. Instrument channels and effect slots only (audio channels have no plugin). */
export function pluginUsage(project: Project): Map<string, PluginUse> {
  const uses = new Map<string, PluginUse>();
  const entryFor = (pluginId: string): PluginUse => {
    let use = uses.get(pluginId);
    if (!use) {
      use = { channels: [], inserts: [] };
      uses.set(pluginId, use);
    }
    return use;
  };
  for (const channelId of project.channelOrder) {
    const channel = project.channels[channelId];
    if (channel?.kind === 'instrument') entryFor(channel.plugin.pluginId).channels.push({ id: channel.id, name: channel.name });
  }
  for (const insertId of project.mixer.order) {
    const insert = project.mixer.inserts[insertId];
    if (!insert) continue;
    for (const slot of insert.fx) entryFor(slot.plugin.pluginId).inserts.push({ id: insert.id, name: insert.name, slotId: slot.id });
  }
  return uses;
}

/** The ids the project uses that `isKnown` says are not installed, with where each is used. Built-in ids are never listed. */
export function missingPlugins(project: Project, isKnown: (pluginId: string) => boolean): Map<string, PluginUse> {
  const missing = new Map<string, PluginUse>();
  for (const [id, use] of pluginUsage(project)) if (id.startsWith('user.') && !isKnown(id)) missing.set(id, use);
  return missing;
}
