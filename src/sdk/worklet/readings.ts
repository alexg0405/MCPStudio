import type { KernelHost } from './kernel';

/**
 * Meter values a kernel shows in its plugin's editor (gain reduction, loudness, detected pitch):
 * set them in `values`, call `tick(n)` once per `process()`/`render()`, and about `hz` times a
 * second they are posted to the main thread, where the editor reads them with
 * `props.tap?.reading(name)`. Needs `tap: true` in `defineWorkletEffect`/`defineWorkletInstrument`
 * (or your own `host.tap()` publishing `{ readings }` messages). Allocation-free.
 */
export class Readings<K extends string> {
  /** The latest values; write them whenever they change. */
  readonly values: Record<K, number>;
  private readonly message: { readings: Record<K, number> };
  private readonly every: number;
  private countdown = 0;

  constructor(
    private readonly host: KernelHost,
    names: readonly K[],
    hz = 30,
  ) {
    const values = {} as Record<K, number>;
    for (const name of names) values[name] = 0;
    this.values = values;
    this.message = { readings: values };
    this.every = Math.max(1, Math.round(host.sampleRate / Math.max(1, Math.min(60, hz))));
  }

  /** Counts `frames` of audio; posts the values when it is time. */
  tick(frames: number): void {
    this.countdown -= frames;
    if (this.countdown > 0) return;
    this.countdown += this.every;
    if (this.countdown <= 0) this.countdown = this.every;
    this.host.post(this.message);
  }
}
