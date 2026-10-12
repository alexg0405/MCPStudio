import type { PluginLoadError, PluginRegistry } from './registry';

/**
 * Finds plugin modules:
 * - built-ins: src/plugins/builtin/<name>/index.ts (loaded eagerly; they ship with the app)
 * - yours:     plugins/<name>/index.ts(x)          (loaded lazily so one broken plugin can't take the app down)
 * Folders starting with "_" are ignored.
 *
 * This module is its own hot-reload boundary: editing, adding or deleting a plugin re-runs it and
 * re-syncs the long-lived registry; the engine then rebuilds only the affected instances.
 */
const builtin = import.meta.glob<{ default: unknown }>('/src/plugins/builtin/*/index.{ts,tsx}', { eager: true });
const user = import.meta.glob<{ default: unknown }>(['/plugins/*/index.{ts,tsx}', '!/plugins/_*/**']);

let registry: PluginRegistry | null = (import.meta.hot?.data.registry as PluginRegistry | undefined) ?? null;

async function syncAll(target: PluginRegistry): Promise<void> {
  target.sync(
    'builtin',
    Object.entries(builtin).map(([path, mod]) => ({ path, def: mod.default })),
  );
  const entries = Object.entries(user);
  const results = await Promise.allSettled(entries.map(([, load]) => load()));
  const defs: { path: string; def: unknown }[] = [];
  const errors: PluginLoadError[] = [];
  results.forEach((r, i) => {
    const path = entries[i]![0];
    if (r.status === 'fulfilled') defs.push({ path, def: r.value.default });
    else {
      const err = r.reason as Error | undefined;
      console.error(`[agstudio] plugin ${path} failed to load`, err);
      errors.push({ path, source: 'user', error: err?.message ?? String(r.reason) });
    }
  });
  target.sync('user', defs, errors);
}

/** Loads every plugin into the registry (await before building the engine). */
export async function installPluginDiscovery(target: PluginRegistry): Promise<void> {
  registry = target;
  if (import.meta.hot) import.meta.hot.data.registry = target;
  await syncAll(target);
}

/** Synchronous built-in-only registration (tests, and the first paint before user plugins load). */
export function registerBuiltinPlugins(target: PluginRegistry): void {
  target.sync(
    'builtin',
    Object.entries(builtin).map(([path, mod]) => ({ path, def: mod.default })),
  );
}

if (import.meta.hot) {
  // Re-executed after a plugin changed: refresh the registry that the running app holds.
  if (registry) void syncAll(registry);
  import.meta.hot.accept();
}
