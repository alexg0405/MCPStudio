import type { ParamSpec, PluginDef } from '@agstudio/sdk';

export interface PluginEntry {
  def: PluginDef;
  /** 'builtin' plugins ship with AGstudio; 'user' plugins live in /plugins. */
  source: 'builtin' | 'user';
  /** Module path it was loaded from. */
  path: string;
}

export interface PluginLoadError {
  path: string;
  source: 'builtin' | 'user';
  error: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Problems with a definition, or [] when it is valid. */
export function validatePluginDef(def: unknown): string[] {
  const problems: string[] = [];
  const d = def as Partial<PluginDef> | null | undefined;
  if (!d || typeof d !== 'object') return ['the module has no default export (expected defineInstrument/defineEffect)'];
  if (d.kind !== 'instrument' && d.kind !== 'effect') problems.push('kind must be "instrument" or "effect"');
  if (typeof d.id !== 'string' || !ID_RE.test(d.id))
    problems.push('id must be a non-empty string like "user.my-synth"');
  if (typeof d.name !== 'string' || !d.name) problems.push('name is required');
  if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1)
    problems.push('version must be a positive integer');
  if (typeof d.create !== 'function') problems.push('create(host) is required');
  if (!d.params || typeof d.params !== 'object') problems.push('params must be an object (use {} for none)');
  else {
    for (const [key, raw] of Object.entries(d.params as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) {
        problems.push(`param "${key}" is not a param spec (use p.float/p.int/p.enum/p.bool)`);
        continue;
      }
      const spec = raw as ParamSpec;
      if ((spec.type === 'float' || spec.type === 'int') && !(spec.min < spec.max))
        problems.push(`param "${key}": min must be < max`);
      if (spec.type === 'float' && spec.scale === 'log' && spec.min <= 0)
        problems.push(`param "${key}": log scale needs min > 0`);
      if (spec.type === 'enum' && (!Array.isArray(spec.options) || !spec.options.includes(spec.default)))
        problems.push(`param "${key}": default must be one of the options`);
    }
  }
  return problems;
}

/**
 * All known plugin definitions. Long-lived: hot-reloaded modules re-register into it and listeners
 * (the engine, the browser panel) react.
 */
export class PluginRegistry {
  private readonly entries = new Map<string, PluginEntry>();
  private errors: PluginLoadError[] = [];
  private readonly listeners = new Set<(changedIds: string[]) => void>();
  private version = 0;

  get(id: string): PluginDef | undefined {
    return this.entries.get(id)?.def;
  }

  entry(id: string): PluginEntry | undefined {
    return this.entries.get(id);
  }

  list(kind?: PluginDef['kind']): PluginEntry[] {
    return [...this.entries.values()]
      .filter((e) => !kind || e.def.kind === kind)
      .sort(
        (a, b) => Number(a.source === 'user') - Number(b.source === 'user') || a.def.name.localeCompare(b.def.name),
      );
  }

  loadErrors(): readonly PluginLoadError[] {
    return this.errors;
  }

  /**
   * Replaces the set of definitions from one source (all built-ins or all user plugins). Built-ins win
   * id collisions. Returns ids whose definition changed (added, removed or replaced).
   */
  sync(
    source: PluginEntry['source'],
    defs: { path: string; def: unknown }[],
    errors: PluginLoadError[] = [],
  ): string[] {
    const changed: string[] = [];
    const nextErrors = this.errors.filter((e) => e.source !== source).concat(errors);
    const seen = new Set<string>();
    for (const { path, def } of defs) {
      const problems = validatePluginDef(def);
      if (problems.length > 0) {
        nextErrors.push({ path, source, error: problems.join('; ') });
        continue;
      }
      const d = def as PluginDef;
      const existing = this.entries.get(d.id);
      if (existing && existing.source !== source && existing.source === 'builtin') {
        nextErrors.push({ path, source, error: `id "${d.id}" is already used by a built-in plugin` });
        continue;
      }
      if (seen.has(d.id)) {
        nextErrors.push({ path, source, error: `duplicate id "${d.id}"` });
        continue;
      }
      seen.add(d.id);
      if (existing?.def !== d) changed.push(d.id);
      this.entries.set(d.id, { def: d, source, path });
    }
    for (const [id, e] of this.entries) {
      if (e.source === source && !seen.has(id)) {
        this.entries.delete(id);
        changed.push(id);
      }
    }
    const errorsChanged = JSON.stringify(nextErrors) !== JSON.stringify(this.errors);
    this.errors = nextErrors;
    if (changed.length > 0 || errorsChanged) {
      this.version++;
      for (const fn of this.listeners) fn(changed);
    }
    return changed;
  }

  /** Increments whenever definitions or load errors change (for useSyncExternalStore). */
  getVersion(): number {
    return this.version;
  }

  subscribe(fn: (changedIds: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
