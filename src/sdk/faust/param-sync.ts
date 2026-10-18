import { at, type ParamBlock } from '../worklet/kernel';
import type { FaustInstance } from './instance';
import type { FaustControl } from './params';

/**
 * Pushes changed param values into Faust instances once per block (Faust controls are plain
 * numbers, so the per-frame detail of an automated param is not needed).
 */
export class ParamSync {
  /** The latest value of each control, NaN until its param has been seen. */
  readonly values: Float64Array;

  constructor(private readonly controls: readonly FaustControl[]) {
    this.values = new Float64Array(controls.length).fill(Number.NaN);
  }

  /** Reads the block's first-frame values; returns true when any changed. */
  read(params: ParamBlock): boolean {
    let changed = false;
    for (let k = 0; k < this.controls.length; k++) {
      const block = params[(this.controls[k] as FaustControl).id];
      const value = block ? at(block, 0) : Number.NaN;
      if (value !== this.values[k] && !Number.isNaN(value)) {
        this.values[k] = value;
        changed = true;
      }
    }
    return changed;
  }

  /** Sets every known value on an instance (a new voice, or after `read` found a change). */
  apply(instance: FaustInstance): void {
    for (let k = 0; k < this.controls.length; k++) {
      const value = this.values[k] as number;
      if (!Number.isNaN(value)) instance.set((this.controls[k] as FaustControl).index, value);
    }
  }
}
