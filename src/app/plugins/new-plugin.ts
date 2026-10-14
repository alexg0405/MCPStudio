/**
 * Your own plugins from inside the app: a new one from a template (the dev server writes it to
 * plugins/<name>, where discovery and hot reload pick it up) and "Edit code", which opens a file in
 * your code editor (Vite's /__open-in-editor). Both need `npm run dev`.
 */
export type NewPluginKind = 'instrument' | 'effect' | 'note-script';
export type NewPluginStyle = 'graph' | 'worklet' | 'faust';

export interface NewPluginSpec {
  kind: NewPluginKind;
  style: NewPluginStyle;
  name: string;
}

/** "Tape Stop" → "user.tape-stop" (the id must match /^user\.[a-z][a-z0-9-]{1,40}$/). */
export function pluginIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `user.${slug.length >= 2 ? slug : `plugin-${slug || 'new'}`}`;
}

export async function createPlugin(
  spec: NewPluginSpec,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<{ id: string; folder: string; main: string } | { error: string }> {
  const id = pluginIdFor(spec.name);
  let res: Response;
  try {
    res = await fetchImpl('/api/plugins/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agstudio': '1' },
      body: JSON.stringify({ id, name: spec.name.trim() || id, kind: spec.kind, style: spec.style }),
    });
  } catch {
    return { error: 'Creating plugins needs the AGstudio dev server: run `npm run dev`.' };
  }
  const data = (await res.json().catch(() => ({}))) as { folder?: string; main?: string; error?: string };
  if (!res.ok || !data.folder || !data.main)
    return {
      error:
        res.status === 404
          ? 'Creating plugins needs the AGstudio dev server: run `npm run dev`.'
          : (data.error ?? `The server couldn’t create it (${res.status}).`),
    };
  return { id, folder: data.folder, main: data.main };
}

/** Opens a project file (path relative to the project, e.g. "plugins/x/index.ts") in your code editor. */
export async function openInEditor(path: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const res = await fetchImpl(`/__open-in-editor?file=${encodeURIComponent(path)}`);
    return res.ok;
  } catch {
    return false;
  }
}

/** The project-relative file a discovered user plugin was loaded from ("/plugins/x/index.ts" → "plugins/x/index.ts"). */
export function pluginSourceFile(modulePath: string): string | null {
  // The project's own plugins/ folder only (not src/plugins/builtin).
  const m = /^\/?(plugins\/[^?#]+\.(?:ts|tsx|dsp))/.exec(modulePath);
  return m ? (m[1] as string) : null;
}
