import { APP_VERSION } from '@core/model/defaults';
import { readBundle, writeBundle } from '@core/plugin-bundle/bundle';
import { BUNDLE_EXTENSION, BUNDLE_MIME, type BundleKind, type BundlePreset } from '@core/plugin-bundle/manifest';
import { pluginFileProblems } from '@core/plugin-bundle/rules';
import { downloadBytes } from '@platform/fs-access';
import { PluginActionError } from './types';
import type { UserPlugins } from './user-plugins';

/** What the musician can add when sharing: who made it, and a sentence about it. Both are optional. */
export interface ShareDetails {
  author?: string;
  description?: string;
}

/** A packed plugin ready to save: its bytes, the file name, and what was left out. */
export interface ExportedBundle {
  bytes: Uint8Array;
  fileName: string;
  /** Files of the plugin's folder that are not source files and were left out. */
  skipped: string[];
  /** How many of your presets for it travel with it. */
  presetCount: number;
}

/** "Tape Stop" → "Tape Stop.agplugin", safe as a file name on every system. */
export function bundleFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'plugin';
  return `${safe}${BUNDLE_EXTENSION}`;
}

/** Your presets for the plugin, in the shape a bundle keeps them. */
function bundlePresets(up: UserPlugins, id: string): BundlePreset[] {
  return up.presets.forPlugin(id).map((preset) => ({
    name: preset.name,
    version: preset.version,
    params: { ...preset.params },
    ...(preset.state !== undefined ? { state: preset.state } : {}),
  }));
}

/**
 * Packs one of your plugins into an `.agplugin` bundle: its source files (from the dev server), its manifest and your
 * presets for it. The result is read back with the same checks an importer applies, so a bundle that comes out of here
 * always imports. Refuses a plugin whose files would not pass those checks (and says what is wrong).
 */
export async function exportBundle(up: UserPlugins, id: string, details: ShareDetails = {}): Promise<ExportedBundle> {
  const row = up.userRow(id);
  if (row.state !== 'loaded' || !row.kind) throw new PluginActionError(`“${row.name}” did not load, so it cannot be packed up. Fix it first (see its error in My plugins).`);
  await up.requireServer('Sharing a plugin');
  const { files, skipped } = await up.server.files(row.folder as string, 'installed');
  const problems = pluginFileProblems(files);
  if (problems.length > 0)
    throw new PluginActionError(`“${row.name}” would not pass the plugin safety checks, so it cannot be shared as a bundle.`, problems);
  const author = details.author ?? up.meta.get(id).author ?? '';
  const presets = bundlePresets(up, id);
  const bytes = await writeBundle({
    id,
    name: row.name,
    version: row.version as number,
    kind: row.kind as BundleKind,
    author,
    description: details.description ?? row.description,
    files,
    presets,
    createdWith: `AGstudio ${APP_VERSION}`,
  });
  const check = await readBundle(bytes);
  if (!check.ok) throw new PluginActionError(`“${row.name}” could not be packed into a valid bundle.`, check.problems);
  if (details.author !== undefined) up.meta.set(id, { author: details.author });
  return { bytes, fileName: bundleFileName(row.name), skipped, presetCount: presets.length };
}

/** Packs a plugin and saves the file (the browser's download). */
export async function shareBundle(up: UserPlugins, id: string, details: ShareDetails = {}): Promise<ExportedBundle> {
  const exported = await exportBundle(up, id, details);
  downloadBytes(exported.fileName, exported.bytes, BUNDLE_MIME);
  return exported;
}
