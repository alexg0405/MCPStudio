import { APP_VERSION } from '@core/model/defaults';
import { writeBundle } from '@core/plugin-bundle/bundle';
import type { BundleKind } from '@core/plugin-bundle/manifest';
import type { PluginFile } from '@core/plugin-bundle/rules';

/**
 * The gallery: example plugins that ship with AGstudio, each one a folder in `templates/gallery/<name>/` (the plugin's own
 * files, plus a `gallery.json` that says what to show). They are packed into `.agplugin` bundles on demand and installed
 * through the same checks and the same dialog as a bundle someone sent you, so the gallery is also a worked example of
 * what a shared plugin looks like.
 */

/** One gallery plugin, ready to pack. */
export interface GalleryItem {
  /** The folder name in `templates/gallery`. */
  folder: string;
  /** The plugin id its code declares. */
  id: string;
  name: string;
  kind: BundleKind;
  author: string;
  description: string;
  /** How it is written, in words ("Faust effect: a few lines…"). */
  style: string;
  version: number;
  files: PluginFile[];
}

/** What `gallery.json` holds. */
interface GalleryMeta {
  name: string;
  kind: BundleKind;
  author: string;
  description: string;
  style: string;
}

type Loader = () => Promise<string>;

/** Every file of every gallery plugin, loaded only when the gallery is opened. */
const sources = import.meta.glob<string>('/templates/gallery/*/*', { query: '?raw', import: 'default' });

const PLUGIN_ID = /['"](user\.[a-z][a-z0-9-]{1,40})['"]/;
const VERSION = /\bversion:\s*(\d+)/;

/** Groups the loaded files by gallery folder: `folder → file name → loader`. */
function foldersOf(files: Record<string, Loader>): Map<string, Map<string, Loader>> {
  const folders = new Map<string, Map<string, Loader>>();
  for (const [path, load] of Object.entries(files)) {
    const match = /^\/templates\/gallery\/([^/]+)\/([^/]+)$/.exec(path);
    if (!match) continue;
    const folder = folders.get(match[1] as string) ?? new Map<string, Loader>();
    folder.set(match[2] as string, load);
    folders.set(match[1] as string, folder);
  }
  return folders;
}

/** The id and version a plugin's code declares (the code is the one place they are written). */
export function declaredIdentity(files: readonly PluginFile[]): { id: string; version: number } | null {
  const code = files.filter((file) => /\.(ts|tsx)$/.test(file.path));
  const id = code.map((file) => PLUGIN_ID.exec(file.content)?.[1]).find((found) => found !== undefined);
  const version = Number(VERSION.exec(code.find((file) => /^index\.tsx?$/.test(file.path))?.content ?? '')?.[1] ?? 1);
  return id ? { id, version } : null;
}

async function loadItem(folder: string, loaders: Map<string, Loader>): Promise<GalleryItem | null> {
  const metaLoader = loaders.get('gallery.json');
  if (!metaLoader) return null;
  const meta = JSON.parse(await metaLoader()) as GalleryMeta;
  const files: PluginFile[] = [];
  for (const [path, load] of loaders) if (path !== 'gallery.json') files.push({ path, content: await load() });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const identity = declaredIdentity(files);
  if (!identity) return null;
  return { folder, ...identity, name: meta.name, kind: meta.kind, author: meta.author, description: meta.description, style: meta.style, files };
}

/** The gallery's plugins, by name. */
export async function loadGallery(files: Record<string, Loader> = sources): Promise<GalleryItem[]> {
  const items: GalleryItem[] = [];
  for (const [folder, loaders] of foldersOf(files)) {
    const item = await loadItem(folder, loaders);
    if (item) items.push(item);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** A gallery plugin as the bytes of an `.agplugin` bundle. */
export function galleryBundle(item: GalleryItem): Promise<Uint8Array> {
  return writeBundle({
    id: item.id,
    name: item.name,
    version: item.version,
    kind: item.kind,
    author: item.author,
    description: item.description,
    files: item.files,
    createdWith: `AGstudio ${APP_VERSION}`,
  });
}
