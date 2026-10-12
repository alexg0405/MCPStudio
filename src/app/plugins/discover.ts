import type { PluginRegistry } from './registry';

/**
 * Finds plugin modules. Built-ins live in src/plugins/builtin/<name>/index.ts. (User plugins from
 * /plugins with hot reload are added in M2.)
 */
const builtin = import.meta.glob<{ default: unknown }>('/src/plugins/builtin/*/index.{ts,tsx}', { eager: true });

export function registerBuiltinPlugins(registry: PluginRegistry): void {
  registry.sync(
    'builtin',
    Object.entries(builtin).map(([path, mod]) => ({ path, def: mod.default })),
  );
}
