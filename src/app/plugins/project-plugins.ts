import { pluginUsage, type PluginUse } from '@core/query/plugin-usage';
import { exportBundle } from './bundle-export';
import type { PluginRow } from './types';
import type { UserPlugins } from './user-plugins';

/** A plugin the open project uses that can be packed inside a shared project: yours, loaded, with where it is used. */
export interface UsedUserPlugin {
  row: PluginRow;
  use: PluginUse;
}

/** The user plugins the open project uses (loaded ones: only those have code that can be packed), by name. */
export function usedUserPlugins(up: UserPlugins): UsedUserPlugin[] {
  const usage = pluginUsage(up.doc.getState().project);
  const used: UsedUserPlugin[] = [];
  for (const row of up.rows()) {
    const use = usage.get(row.id);
    if (use && row.source === 'user' && row.state === 'loaded') used.push({ row, use });
  }
  return used;
}

/** What packing a chosen set of plugins gave: the bundles, and the plugins that could not be packed (with the reason). */
export interface PackedPlugins {
  bundles: Map<string, Uint8Array>;
  failed: { name: string; reason: string }[];
}

/** Packs the plugins with these ids into bundles for a project file. A plugin that cannot be packed is reported, not fatal. */
export async function packPlugins(up: UserPlugins, ids: readonly string[]): Promise<PackedPlugins> {
  const bundles = new Map<string, Uint8Array>();
  const failed: PackedPlugins['failed'] = [];
  for (const id of ids) {
    try {
      bundles.set(id, (await exportBundle(up, id)).bytes);
    } catch (error) {
      failed.push({ name: up.row(id)?.name ?? id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { bundles, failed };
}
