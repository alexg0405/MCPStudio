/**
 * Short how-tos per window type, shown by the "?" button in its title bar: what the window is for
 * and its main mouse and key moves, in plain words. Features (or the help feature) register them.
 */
export interface WindowHelp {
  /** One or two sentences: what this window is for. */
  intro: string;
  /** "Click a square" → "adds a step". */
  moves: readonly (readonly [how: string, what: string])[];
}

const help = new Map<string, WindowHelp>();
const listeners = new Set<() => void>();

export function setWindowHelp(type: string, h: WindowHelp): () => void {
  help.set(type, h);
  listeners.forEach((fn) => fn());
  return () => {
    if (help.get(type) === h) help.delete(type);
    listeners.forEach((fn) => fn());
  };
}

export function windowHelp(type: string): WindowHelp | undefined {
  return help.get(type);
}

export function subscribeWindowHelp(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A button under a window's how-to: where to learn more (its guided tour, its page in the Help window). */
export interface WindowHelpLink {
  /** What the button says: "Take the tour: Mixing and mastering". */
  label: string;
  /** What it does, for the hint bar. */
  hint: string;
  /** Called with the window type whose "?" it is in. */
  run(type: string): void;
}

/** The type that stands for every window: a link added for it shows under every window's how-to. */
export const ALL_WINDOWS = '*';

const NO_LINKS: readonly WindowHelpLink[] = [];
const links = new Map<string, readonly WindowHelpLink[]>();
/** The merged list per type, kept so the same array comes back until a link is added or removed. */
const merged = new Map<string, readonly WindowHelpLink[]>();

/** Adds a link under the "?" how-to of a window type (or of every window, with `ALL_WINDOWS`). The returned function removes it. */
export function addWindowHelpLink(type: string, link: WindowHelpLink): () => void {
  links.set(type, [...(links.get(type) ?? NO_LINKS), link]);
  merged.clear();
  listeners.forEach((fn) => fn());
  return () => {
    links.set(
      type,
      (links.get(type) ?? NO_LINKS).filter((l) => l !== link),
    );
    merged.clear();
    listeners.forEach((fn) => fn());
  };
}

/** The links of a window type's how-to: its own, then the ones every window has. The same array until a link changes. */
export function windowHelpLinks(type: string): readonly WindowHelpLink[] {
  let list = merged.get(type);
  if (!list) {
    list = [...(links.get(type) ?? NO_LINKS), ...(links.get(ALL_WINDOWS) ?? NO_LINKS)];
    merged.set(type, list);
  }
  return list;
}
