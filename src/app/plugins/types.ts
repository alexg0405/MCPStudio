import type { PluginBundle } from '@core/plugin-bundle/bundle';
import type { PluginCapabilities } from '@core/plugin-bundle/capabilities';
import type { BundleKind } from '@core/plugin-bundle/manifest';
import type { PluginUse } from '@core/query/plugin-usage';

/** A plugin in the "My plugins" list: yours (with its folder) or a built-in (read only). */
export interface PluginRow {
  id: string;
  name: string;
  /** null when the plugin did not load, so its kind is not known. */
  kind: BundleKind | null;
  /** The plugin's own `version`; null when it did not load. */
  version: number | null;
  /** From the bundle it came from, or what you typed when you shared it; empty when unknown. */
  author: string;
  description: string;
  source: 'builtin' | 'user';
  /** loaded: working; error: its code did not load (see `error`); disabled: switched off (folder in plugins/_disabled). */
  state: 'loaded' | 'error' | 'disabled';
  /** The folder under plugins/ (or plugins/_disabled/) for your plugins; null for built-ins. */
  folder: string | null;
  /** Why it did not load, in the loader's words. */
  error: string | null;
  /** What the last "Check code" found (empty: nothing found, or never checked). */
  problems: string[];
  /** Whether "Check code" has run for it since the app started. */
  isChecked: boolean;
  /** How many source files the folder has (0 for built-ins). */
  fileCount: number;
  /** Where the open project uses it. */
  usedIn: PluginUse;
}

/** A plugin in the trash: what was deleted, from which folder, and when. */
export interface TrashRow {
  /** The folder's name in plugins/_trash. */
  entry: string;
  /** The folder it came from. */
  folder: string;
  id: string | null;
  fileCount: number;
  /** Milliseconds since 1970 of its newest file. */
  modified: number;
}

/** What installing a bundle would run into: nothing, the same plugin already there, or a different one with that id. */
export type Collision =
  | { kind: 'none' }
  | { kind: 'identical'; folder: string }
  | {
      kind: 'different';
      folder: string;
      /** The installed plugin's version (null when it does not load). */
      installedVersion: number | null;
      /** The bundle's version against the installed one. */
      relation: 'newer' | 'same' | 'older';
      /** The installed one is switched off. */
      isDisabled: boolean;
    };

/** A bundle that passed every check, with what the install dialog shows. */
export interface BundleInspection {
  bundle: PluginBundle;
  capabilities: PluginCapabilities;
  collision: Collision;
  /** Presets of the bundle that are new to this browser. */
  newPresets: number;
  /** Null when it can be installed here; else the plain reason (no dev server). */
  cannotInstall: string | null;
}

/** How to install: as a new plugin, over the one with the same id (the old folder goes to plugins/_backup), or as a copy under a new id. */
export type InstallMode = 'new' | 'replace' | 'copy';

/** What an install did. */
export interface InstallResult {
  id: string;
  folder: string;
  name: string;
  /** An older plugin was replaced (kept in plugins/_backup). */
  replaced: boolean;
  /** The plugin showed up in the registry (false: still loading, or it failed: see `loadError`). */
  loaded: boolean;
  loadError: string | null;
  presetsAdded: number;
}

/** A refusal with the reasons, in plain words. */
export class PluginActionError extends Error {
  constructor(
    message: string,
    /** Every problem found, when there are several (the checks list them all). */
    readonly problems: readonly string[] = [],
  ) {
    super(message);
  }
}
