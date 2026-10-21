import type { Draft } from 'immer';
import type { Project } from '../model/types';

/**
 * Points everything in the project that uses the plugin `from` at the plugin `to`: instrument channels, effect slots and
 * the effect names kept in mixer snapshots (a snapshot only recalls an effect's settings while the slot still holds the
 * same effect). Settings stay as they are: a renamed plugin is the same code under another id. Returns how many places
 * changed. Call inside `history.transact()`, so it is one undo step.
 */
export function renamePluginId(d: Draft<Project>, from: string, to: string): number {
  if (from === to) return 0;
  let changes = 0;
  for (const channel of Object.values(d.channels)) {
    if (channel.kind === 'instrument' && channel.plugin.pluginId === from) {
      channel.plugin.pluginId = to;
      changes++;
    }
  }
  for (const insert of Object.values(d.mixer.inserts)) {
    for (const slot of insert.fx) {
      if (slot.plugin.pluginId === from) {
        slot.plugin.pluginId = to;
        changes++;
      }
    }
  }
  for (const snapshot of d.mixSnapshots ?? []) {
    for (const snapshotInsert of Object.values(snapshot.inserts)) {
      for (const slot of Object.values(snapshotInsert.fx)) {
        if (slot.plugin === from) {
          slot.plugin = to;
          changes++;
        }
      }
    }
  }
  return changes;
}
