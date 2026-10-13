/**
 * Everything a user can invoke (menus, toolbar buttons, shortcuts, later a command palette or MIDI
 * mapping) is a command. Features register commands; the registry knows nothing about the app.
 */
export interface CommandDef<Ctx, A = void> {
  id: string;
  title: string;
  category?: string;
  /** Shown in the hint bar when hovering a control bound to this command. */
  hint?: string;
  run(ctx: Ctx, args: A): void | Promise<void>;
  enabled?(ctx: Ctx): boolean;
  /** For toggles: menus show a check mark when this returns true. */
  checked?(ctx: Ctx): boolean;
  /**
   * False leaves it out of the action search unless a menu offers it (it needs arguments that a menu
   * item or key binding supplies).
   */
  palette?: boolean;
}

// The registry stores commands with heterogeneous argument types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand<Ctx> = CommandDef<Ctx, any>;

export class CommandRegistry<Ctx> {
  private readonly defs = new Map<string, AnyCommand<Ctx>>();
  private readonly listeners = new Set<() => void>();
  private ctx: (() => Ctx) | null = null;

  /** The context is supplied late because the services object that owns the registry is the context. */
  bindContext(getCtx: () => Ctx): void {
    this.ctx = getCtx;
  }

  /** Registering an existing id replaces it (keeps hot reload simple). Returns an unregister function. */
  register<A = void>(def: CommandDef<Ctx, A>): () => void {
    this.defs.set(def.id, def);
    this.emit();
    return () => {
      if (this.defs.get(def.id) === def) {
        this.defs.delete(def.id);
        this.emit();
      }
    };
  }

  get(id: string): AnyCommand<Ctx> | undefined {
    return this.defs.get(id);
  }

  list(): AnyCommand<Ctx>[] {
    return [...this.defs.values()];
  }

  isEnabled(id: string): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    return def.enabled ? def.enabled(this.context()) : true;
  }

  isChecked(id: string): boolean {
    const def = this.defs.get(id);
    return def?.checked ? def.checked(this.context()) : false;
  }

  /** Runs a command. Returns false when it does not exist or is disabled. */
  run(id: string, args?: unknown): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    const ctx = this.context();
    if (def.enabled && !def.enabled(ctx)) return false;
    const result = def.run(ctx, args);
    if (result instanceof Promise) {
      result.catch((err: unknown) => this.onError?.(id, err));
    }
    return true;
  }

  /** Optional sink for async command failures (the app shows a toast). */
  onError?: (id: string, err: unknown) => void;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private context(): Ctx {
    if (!this.ctx) throw new Error('CommandRegistry used before bindContext()');
    return this.ctx();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
