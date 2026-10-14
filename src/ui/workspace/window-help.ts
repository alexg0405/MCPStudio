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
