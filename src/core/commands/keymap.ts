/**
 * Keyboard chords and bindings. Pure: the DOM listener lives in the UI and feeds `KeyEventLike`s in.
 *
 * Canonical chord format: modifiers in the fixed order Ctrl, Alt, Shift, Meta, then the key, joined
 * with '+', e.g. 'Shift+Meta+Z'. In binding definitions `Mod` means Cmd on macOS and Ctrl elsewhere.
 * Letters and digits are taken from the physical key (`event.code`) so Alt/Option combos work on macOS,
 * where Option+1 produces '¡' as `event.key`.
 */

export type Platform = 'mac' | 'other';

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface Binding {
  chord: string;
  command: string;
  args?: unknown;
  /** Keep firing while the key auto-repeats (nudges, zoom). Default false. */
  repeat?: boolean;
  when?: {
    /** Only active while a window of one of these types has focus. Focus-scoped bindings win over global ones. */
    focus?: readonly string[];
    /** Also fire while typing in a text field (default false). */
    allowInInput?: boolean;
  };
}

export interface MatchContext {
  focus: string | null;
  inInput: boolean;
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier | 'Mod'> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  mod: 'Mod',
};

const KEY_ALIASES: Record<string, string> = {
  space: 'Space',
  ' ': 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  '-': 'Minus',
  minus: 'Minus',
  '=': 'Equal',
  equal: 'Equal',
  '+': 'Equal',
  plus: 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '`': 'Backquote',
};

const CODE_PASSTHROUGH = new Set([
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Backquote',
]);

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)(Left|Right)?$/;

function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES[lower] ?? KEY_ALIASES[raw];
  if (alias) return alias;
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (/^numpad/i.test(raw)) return 'Numpad' + raw.slice(6).replace(/^./, (c) => c.toUpperCase());
  return raw;
}

function join(mods: ReadonlySet<Modifier>, key: string): string {
  const parts: string[] = MODIFIER_ORDER.filter((m) => mods.has(m));
  parts.push(key);
  return parts.join('+');
}

/** Parses a binding chord such as 'Mod+Shift+z' into canonical form for the given platform. */
export function parseChord(chord: string, platform: Platform): string {
  // '+' alone (or as the key, e.g. 'Mod++') needs care when splitting.
  const tokens = chord.split('+');
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    if (t === '' && i < tokens.length - 1) {
      parts.push('+');
      i++;
    } else if (t !== '') parts.push(t);
  }
  const keyToken = parts.pop();
  if (!keyToken) throw new Error(`Invalid chord "${chord}"`);
  const mods = new Set<Modifier>();
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in chord "${chord}"`);
    mods.add(m === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Ctrl') : m);
  }
  return join(mods, normalizeKey(keyToken));
}

/** Canonical chord for a keyboard event, or null for a bare modifier press. */
export function chordFromEvent(e: KeyEventLike): string | null {
  let key: string | null = null;
  const code = e.code;
  if (code && MODIFIER_CODES.test(code)) return null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (/^Numpad/.test(code)) key = code;
  else if (CODE_PASSTHROUGH.has(code)) key = code;
  if (key === null) {
    if (!e.key || e.key === 'Unidentified' || e.key === 'Dead') return null;
    if (/^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)$/.test(e.key)) return null;
    key = normalizeKey(e.key);
  }
  const mods = new Set<Modifier>();
  if (e.ctrlKey) mods.add('Ctrl');
  if (e.altKey) mods.add('Alt');
  if (e.shiftKey) mods.add('Shift');
  if (e.metaKey) mods.add('Meta');
  return join(mods, key);
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const KEY_LABELS: Record<string, string> = {
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  Enter: '↵',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
};

/** Human-readable label for a canonical chord ('⇧⌘Z' on macOS, 'Ctrl+Shift+Z' elsewhere). */
export function formatChord(canonical: string, platform: Platform): string {
  const parts = canonical.split('+');
  const key = parts.pop() ?? '';
  const keyLabel = KEY_LABELS[key] ?? key;
  if (platform === 'mac') {
    // macOS convention orders modifiers ⌃⌥⇧⌘.
    return parts.map((m) => MAC_SYMBOLS[m] ?? m).join('') + keyLabel;
  }
  return [...parts, keyLabel].join('+');
}

interface Entry {
  binding: Binding;
  canonical: string;
  seq: number;
}

export class Keymap {
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(readonly platform: Platform) {}

  /** Adds bindings; later bindings override earlier ones for the same chord. Returns a remover. */
  add(bindings: readonly Binding[]): () => void {
    const added = bindings.map((binding) => ({
      binding,
      canonical: parseChord(binding.chord, this.platform),
      seq: ++this.seq,
    }));
    this.entries.push(...added);
    this.emit();
    return () => {
      for (const e of added) {
        const i = this.entries.indexOf(e);
        if (i >= 0) this.entries.splice(i, 1);
      }
      this.emit();
    };
  }

  /** Finds the binding for a canonical chord. Focus-scoped bindings beat global ones; newest wins within a tier. */
  match(chord: string, ctx: MatchContext): Binding | undefined {
    let best: Entry | undefined;
    let bestTier = -1;
    for (const e of this.entries) {
      if (e.canonical !== chord) continue;
      const when = e.binding.when;
      if (ctx.inInput && !when?.allowInInput) continue;
      let tier: number;
      if (when?.focus) {
        if (!ctx.focus || !when.focus.includes(ctx.focus)) continue;
        tier = 1;
      } else tier = 0;
      if (tier > bestTier || (tier === bestTier && best && e.seq > best.seq)) {
        best = e;
        bestTier = tier;
      }
    }
    return best?.binding;
  }

  /** Canonical chords bound to a command (global bindings first), for menus and tooltips. */
  chordsFor(commandId: string): string[] {
    return this.entries
      .filter((e) => e.binding.command === commandId)
      .sort((a, b) => Number(!!a.binding.when?.focus) - Number(!!b.binding.when?.focus) || a.seq - b.seq)
      .map((e) => e.canonical);
  }

  all(): readonly Binding[] {
    return this.entries.map((e) => e.binding);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
