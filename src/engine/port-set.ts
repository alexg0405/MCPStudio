import type { WorkletPortImpl } from './worklet-port';

/** The engine's live worklet ports; a new one is told where the song is right away (see `onAdd`). */
export class PortSet extends Set<WorkletPortImpl> {
  /** Called with every port as it joins; the engine uses it to hand the port the song's position. */
  onAdd: ((port: WorkletPortImpl) => void) | null = null;

  override add(port: WorkletPortImpl): this {
    super.add(port);
    this.onAdd?.(port);
    return this;
  }
}
