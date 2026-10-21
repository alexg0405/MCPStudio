/**
 * The manifest of an `.agplugin` bundle (`agplugin.json` inside the zip): what the plugin is, who made it, which SDK it
 * was written for and a hash of every file, so a damaged or edited bundle is noticed before anything is installed.
 */
import type { Json } from '../model/json';
import { isSha256Hex } from '../io/hash';
import { USER_PLUGIN_ID } from './rules';
import { isValidSdkRange, SDK_RANGE_HELP } from './sdk-range';

/** The `format` text every manifest carries, and the version of this layout. */
export const BUNDLE_FORMAT = 'agstudio-plugin';
export const BUNDLE_FORMAT_VERSION = 1;
/** The file ending and the media type of plugin bundles. */
export const BUNDLE_EXTENSION = '.agplugin';
export const BUNDLE_MIME = 'application/x-agstudio-plugin';

/** What a plugin is: an instrument, an effect or a piano-roll tool. */
export type BundleKind = 'instrument' | 'effect' | 'note-script';

/** One file listed in the manifest: its flat name, SHA-256 (lowercase hex) and size in bytes. */
export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** A preset kept with a plugin: a name and its settings (the same values a `.agpreset` file holds). */
export interface BundlePreset {
  name: string;
  /** The plugin's `version` when the preset was saved. */
  version: number;
  params: Record<string, number | boolean | string>;
  state?: Json;
}

/** The manifest as stored in the bundle. */
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  /** The plugin id, `user.<name>`. */
  id: string;
  name: string;
  /** The plugin's own `version` (a whole number; it goes up when saved settings need `migrate`). */
  version: number;
  kind: BundleKind;
  author: string;
  description: string;
  /** Which SDK versions it was written for, e.g. "^1.0.0". */
  sdk: string;
  files: ManifestFile[];
  /** Present when the bundle carries presets: how many, and the hash of `presets.json`. */
  presets?: { count: number; sha256: string };
  /** The AGstudio that wrote the bundle ("AGstudio 0.1.0"). */
  createdWith?: string;
}

/** Limits on the text fields of a manifest. */
export const MAX_NAME_CHARS = 60;
export const MAX_AUTHOR_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 500;
/** Most presets one bundle may carry. */
export const MAX_BUNDLE_PRESETS = 64;

const KINDS: readonly BundleKind[] = ['instrument', 'effect', 'note-script'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Problems with the text fields of a manifest, in plain words. */
function textProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof raw.id !== 'string' || !USER_PLUGIN_ID.test(raw.id))
    problems.push('The manifest’s id must look like "user.my-plugin" (lowercase letters, digits, dashes).');
  if (typeof raw.name !== 'string' || raw.name.trim() === '' || raw.name.length > MAX_NAME_CHARS)
    problems.push(`The manifest needs a name of at most ${MAX_NAME_CHARS} characters.`);
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1 || raw.version > 9999)
    problems.push('The manifest’s version must be a whole number from 1.');
  if (!KINDS.includes(raw.kind as BundleKind)) problems.push('The manifest’s kind must be instrument, effect or note-script.');
  if (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.length > MAX_AUTHOR_CHARS))
    problems.push(`The author must be text of at most ${MAX_AUTHOR_CHARS} characters.`);
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION_CHARS))
    problems.push(`The description must be text of at most ${MAX_DESCRIPTION_CHARS} characters.`);
  if (!isValidSdkRange(raw.sdk)) problems.push(`The manifest’s sdk must be ${SDK_RANGE_HELP}.`);
  return problems;
}

/** Problems with the manifest's list of files (names are checked again against the rules when the files are read). */
function fileListEntryProblems(files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0) return ['The manifest lists no files.'];
  const problems: string[] = [];
  for (const entry of files) {
    if (
      !isObject(entry) ||
      typeof entry.path !== 'string' ||
      !isSha256Hex(entry.sha256) ||
      typeof entry.bytes !== 'number' ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 0
    ) {
      problems.push('A file in the manifest needs a path, a SHA-256 hash and a size.');
      break;
    }
  }
  return problems;
}

/** Reads and checks parsed manifest JSON: the manifest, or every problem found. */
export function readManifest(raw: unknown): { manifest: BundleManifest } | { problems: string[] } {
  if (!isObject(raw) || raw.format !== BUNDLE_FORMAT) return { problems: ['This is not an AGstudio plugin bundle (no manifest).'] };
  if (typeof raw.formatVersion === 'number' && raw.formatVersion > BUNDLE_FORMAT_VERSION)
    return { problems: ['This bundle was made by a newer AGstudio (a newer bundle format). Update AGstudio to install it.'] };
  const problems = [...textProblems(raw), ...fileListEntryProblems(raw.files)];
  const presets = raw.presets;
  if (presets !== undefined && !(isObject(presets) && Number.isInteger(presets.count) && isSha256Hex(presets.sha256)))
    problems.push('The manifest’s presets entry is not valid.');
  if (problems.length > 0) return { problems };
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    id: raw.id as string,
    name: (raw.name as string).trim(),
    version: raw.version as number,
    kind: raw.kind as BundleKind,
    author: typeof raw.author === 'string' ? raw.author : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    sdk: (raw.sdk as string).trim(),
    files: (raw.files as ManifestFile[]).map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    ...(presets ? { presets: { count: (presets as { count: number }).count, sha256: (presets as { sha256: string }).sha256 } } : {}),
    ...(typeof raw.createdWith === 'string' ? { createdWith: raw.createdWith.slice(0, 60) } : {}),
  };
  return { manifest };
}

/** Problems with the presets of a bundle (parsed `presets.json`), or the presets themselves. */
export function readBundlePresets(raw: unknown): { presets: BundlePreset[] } | { problems: string[] } {
  if (!Array.isArray(raw)) return { problems: ['The bundle’s presets are not a list.'] };
  if (raw.length > MAX_BUNDLE_PRESETS) return { problems: [`A bundle may carry at most ${MAX_BUNDLE_PRESETS} presets.`] };
  const presets: BundlePreset[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name.length > 80)
      return { problems: ['A preset in the bundle needs a name.'] };
    if (typeof entry.version !== 'number' || !Number.isInteger(entry.version) || entry.version < 1)
      return { problems: [`The preset “${entry.name}” needs the plugin version it was saved with.`] };
    if (!isObject(entry.params)) return { problems: [`The preset “${entry.name}” has no settings.`] };
    const params: BundlePreset['params'] = {};
    for (const [key, value] of Object.entries(entry.params)) {
      if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string')
        return { problems: [`The preset “${entry.name}” has a setting (${key}) that is not a number, switch or choice.`] };
      params[key] = value;
    }
    presets.push({
      name: entry.name.trim(),
      version: entry.version,
      params,
      ...(entry.state !== undefined ? { state: entry.state as Json } : {}),
    });
  }
  return { presets };
}
