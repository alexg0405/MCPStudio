import type { Services } from '@app/services';

/**
 * Features live in src/ui/features/<name>/register.ts and are picked up automatically.
 * A feature registers its window types, commands, key bindings, menu items, toolbar slots and
 * browser sections. Adding a new feature folder is all it takes to extend the app.
 */
export interface FeatureModule {
  /** Lower runs first (default 100). */
  order?: number;
  register(services: Services): void;
}

const modules = import.meta.glob<FeatureModule>('./*/register.ts', { eager: true });

export function registerFeatures(services: Services): void {
  const list = Object.entries(modules).sort(([, a], [, b]) => (a.order ?? 100) - (b.order ?? 100));
  for (const [path, mod] of list) {
    try {
      mod.register(services);
    } catch (err) {
      console.error(`Feature ${path} failed to register`, err);
      services.session.getState().toast(`Feature ${path} failed to load`, 'error');
    }
  }
}
