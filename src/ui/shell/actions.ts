import type { Services } from '@app/services';

/**
 * Things the action search (Mod+K) can run. Menus and commands are found automatically; features
 * add the rest here (one entry per instrument to add, per window to open…).
 */
export interface ActionEntry {
  /** Stable identity: recent-use ranking and de-duplication. */
  key: string;
  label: string;
  /** Where it lives, e.g. ['Options', 'Count-in']. */
  path: string[];
  hint?: string;
  /** Extra words people might type for it ("bpm" for tempo). */
  keywords?: string[];
  /** Formatted shortcut. */
  chord?: string;
  checked?: boolean;
  disabled?: boolean;
  run(): void;
}

export type ActionProvider = (services: Services) => ActionEntry[];

const providers = new Map<string, ActionProvider>();

export function addActionProvider(id: string, provider: ActionProvider): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

export function getActionProviders(): ActionProvider[] {
  return [...providers.values()];
}
