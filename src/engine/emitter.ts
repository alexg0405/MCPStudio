export type Listener<T extends unknown[]> = (...args: T) => void;

/** A tiny synchronous event emitter. */
export class Emitter<T extends unknown[]> {
  private fns = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(...args: T): void {
    for (const fn of this.fns) fn(...args);
  }
  clear(): void {
    this.fns.clear();
  }
}
