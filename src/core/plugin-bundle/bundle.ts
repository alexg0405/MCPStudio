/**
 * `.agplugin` bundles: a plugin packed into one file to share.
 *
 *   agplugin.json    the manifest (BundleManifest: id, name, version, kind, author, SDK range, a hash of every file)
 *   files/<name>     the plugin's flat source files (index.ts, params.ts, dsp.worklet.ts, a .dsp, README.md…)
 *   presets.json     optional: the plugin's presets (BundlePreset[])
 *
 * Reading never trusts the file: sizes are checked before anything is unpacked, every entry name must be one of the
 * three shapes above, every hash must match, and the same safety rules the plugin builder uses are applied to the code.
 * Writing is deterministic (fixed timestamps), so exporting the same plugin twice gives the same bytes.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { sha256Hex } from '../io/hash';
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  readBundlePresets,
  readManifest,
  type BundleKind,
  type BundleManifest,
  type BundlePreset,
} from './manifest';
import { declaresPluginId, MAX_PLUGIN_FILE_BYTES, MAX_PLUGIN_TOTAL_BYTES, pluginFileProblems, type PluginFile } from './rules';
import { PLUGIN_SDK_VERSION, sdkInRange } from './sdk-range';

/** A bundle file may not be bigger than this (the code limit plus room for the manifest and presets). */
export const MAX_BUNDLE_BYTES = 1024 * 1024;
/** The most entries a bundle may have (manifest, presets and the plugin's files). */
const MAX_ENTRIES = 12;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PRESETS_BYTES = 256 * 1024;
/** Zip entries carry a time; a fixed one keeps exports byte for byte repeatable. */
const FIXED_TIME = new Date(Date.UTC(2024, 0, 1));

/** A plugin bundle's contents, read and verified. */
export interface PluginBundle {
  manifest: BundleManifest;
  files: PluginFile[];
  presets: BundlePreset[];
}

/** What reading a bundle gives: the bundle, or every reason it was refused (in plain words). */
export type BundleResult = { ok: true; bundle: PluginBundle } | { ok: false; problems: string[] };

/** What a bundle is written from: who it is for, the code and the presets. */
export interface BundleInput {
  id: string;
  name: string;
  version: number;
  kind: BundleKind;
  author?: string;
  description?: string;
  /** Default: `^` and the SDK version this AGstudio has. */
  sdk?: string;
  files: readonly PluginFile[];
  presets?: readonly BundlePreset[];
  /** "AGstudio 0.1.0". */
  createdWith?: string;
}

const encode = (text: string) => strToU8(text);

/** Packs a plugin into `.agplugin` bytes. The files are not checked here (reading checks them); the manifest is built. */
export async function writeBundle(input: BundleInput): Promise<Uint8Array> {
  const zip: Zippable = {};
  const files: BundleManifest['files'] = [];
  for (const file of input.files) {
    const bytes = encode(file.content);
    files.push({ path: file.path, sha256: await sha256Hex(bytes), bytes: bytes.length });
    zip[`files/${file.path}`] = [bytes, { level: 6, mtime: FIXED_TIME }];
  }
  const presets = input.presets ?? [];
  let presetsEntry: BundleManifest['presets'];
  if (presets.length > 0) {
    const bytes = encode(JSON.stringify(presets, null, 2));
    presetsEntry = { count: presets.length, sha256: await sha256Hex(bytes) };
    zip['presets.json'] = [bytes, { level: 6, mtime: FIXED_TIME }];
  }
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    id: input.id,
    name: input.name,
    version: input.version,
    kind: input.kind,
    author: input.author ?? '',
    description: input.description ?? '',
    sdk: input.sdk ?? `^${PLUGIN_SDK_VERSION}`,
    files,
    ...(presetsEntry ? { presets: presetsEntry } : {}),
    ...(input.createdWith ? { createdWith: input.createdWith } : {}),
  };
  zip['agplugin.json'] = [encode(JSON.stringify(manifest, null, 2)), { level: 6, mtime: FIXED_TIME }];
  return zipSync(zip, { mtime: FIXED_TIME });
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

/** The entries of the zip, with the problems found by looking at names and sizes only (nothing is unpacked yet). */
function inspectEntries(bytes: Uint8Array): { wanted: Set<string>; problems: string[] } {
  const wanted = new Set<string>();
  const problems: string[] = [];
  let names = 0;
  let codeBytes = 0;
  unzipSync(bytes, {
    filter: (entry) => {
      const name = entry.name;
      if (name.endsWith('/')) return false;
      names++;
      if (name === 'agplugin.json') {
        if (entry.originalSize > MAX_MANIFEST_BYTES) problems.push('The manifest is too large.');
        else wanted.add(name);
      } else if (name === 'presets.json') {
        if (entry.originalSize > MAX_PRESETS_BYTES) problems.push('The presets are too large.');
        else wanted.add(name);
      } else if (/^files\/[^/\\]+$/.test(name) && !name.includes('..')) {
        codeBytes += entry.originalSize;
        if (entry.originalSize > MAX_PLUGIN_FILE_BYTES) problems.push(`"${name.slice(6)}" is too large.`);
        else wanted.add(name);
      } else if (name.startsWith('files/') || name.includes('/') || name.includes('\\')) {
        problems.push(`"${name}" is inside a folder or outside the files list: a plugin's files must be flat.`);
      } else {
        problems.push(`"${name}" does not belong in a plugin bundle.`);
      }
      return false;
    },
  });
  if (names > MAX_ENTRIES) problems.push('The bundle has too many files.');
  if (codeBytes > MAX_PLUGIN_TOTAL_BYTES) problems.push('The plugin is too large.');
  return { wanted, problems };
}

const parseJson = (bytes: Uint8Array): unknown => JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ''));

/** Unpacks the entries inspectEntries approved. */
function unpack(bytes: Uint8Array, wanted: Set<string>): Record<string, Uint8Array> {
  return unzipSync(bytes, { filter: (entry) => wanted.has(entry.name) });
}

/** Checks the files against the manifest (the same names, sizes and hashes). */
async function hashProblems(manifest: BundleManifest, entries: Record<string, Uint8Array>): Promise<string[]> {
  const problems: string[] = [];
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const name of Object.keys(entries)) {
    if (name.startsWith('files/') && !listed.has(name.slice(6)))
      problems.push(`"${name.slice(6)}" is in the bundle but not in its manifest.`);
  }
  for (const file of manifest.files) {
    const bytes = entries[`files/${file.path}`];
    if (!bytes) {
      problems.push(`"${file.path}" is listed in the manifest but missing from the bundle.`);
      continue;
    }
    if (bytes.length !== file.bytes || (await sha256Hex(bytes)) !== file.sha256)
      problems.push(`"${file.path}" does not match its hash: the bundle is damaged or was edited.`);
  }
  return problems;
}

/** Reads the presets entry (and checks its hash), or says why it can't be used. */
async function readPresetsEntry(
  manifest: BundleManifest,
  entries: Record<string, Uint8Array>,
): Promise<{ presets: BundlePreset[] } | { problems: string[] }> {
  const bytes = entries['presets.json'];
  if (!manifest.presets) return bytes ? { problems: ['The bundle has presets its manifest does not list.'] } : { presets: [] };
  if (!bytes) return { problems: ['The manifest lists presets but the bundle has none.'] };
  if ((await sha256Hex(bytes)) !== manifest.presets.sha256)
    return { problems: ['The presets do not match their hash: the bundle is damaged or was edited.'] };
  try {
    return readBundlePresets(parseJson(bytes));
  } catch {
    return { problems: ['The bundle’s presets can’t be read.'] };
  }
}

/**
 * Reads a bundle and runs every check: the zip layout and sizes, the manifest, the SDK range, the hashes, the plugin
 * file rules, the forbidden-API scan, the declared id and the presets. Anything wrong refuses the whole bundle.
 */
export async function readBundle(bytes: Uint8Array): Promise<BundleResult> {
  if (bytes.length > MAX_BUNDLE_BYTES) return { ok: false, problems: ['This file is too large to be a plugin bundle.'] };
  if (!looksLikeZip(bytes)) return { ok: false, problems: ['This is not an AGstudio plugin bundle (it is not a zip file).'] };
  let entries: Record<string, Uint8Array>;
  try {
    const inspected = inspectEntries(bytes);
    if (inspected.problems.length > 0) return { ok: false, problems: inspected.problems };
    entries = unpack(bytes, inspected.wanted);
  } catch {
    return { ok: false, problems: ['This plugin bundle is damaged and can’t be opened.'] };
  }
  const manifestBytes = entries['agplugin.json'];
  if (!manifestBytes) return { ok: false, problems: ['This is not an AGstudio plugin bundle (no manifest).'] };
  let rawManifest: unknown;
  try {
    rawManifest = parseJson(manifestBytes);
  } catch {
    return { ok: false, problems: ['The bundle’s manifest can’t be read.'] };
  }
  const read = readManifest(rawManifest);
  if ('problems' in read) return { ok: false, problems: read.problems };
  const { manifest } = read;
  const problems: string[] = [];
  if (!sdkInRange(manifest.sdk))
    problems.push(`It was written for SDK ${manifest.sdk}, and this AGstudio has SDK ${PLUGIN_SDK_VERSION}.`);
  problems.push(...(await hashProblems(manifest, entries)));
  if (problems.length > 0) return { ok: false, problems };
  const files = manifest.files.map((file) => ({ path: file.path, content: strFromU8(entries[`files/${file.path}`] as Uint8Array) }));
  problems.push(...pluginFileProblems(files));
  if (problems.length === 0 && !declaresPluginId(files, manifest.id))
    problems.push(`The code never says its id "${manifest.id}", so the manifest and the code disagree.`);
  const presets = await readPresetsEntry(manifest, entries);
  if ('problems' in presets) problems.push(...presets.problems);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, bundle: { manifest, files, presets: (presets as { presets: BundlePreset[] }).presets } };
}
