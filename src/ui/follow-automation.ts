/**
 * Knobs that follow automation: controls subscribe a target key (through ParamFollowContext); one
 * frame-loop callback reads every followed key from the engine in a single allocation-free call and
 * hands each control its automated value (or null when automation doesn't drive it).
 */
import type { EngineApi } from '@engine/api';
import { decode, type ParamSpec, type ParamValue } from '@agstudio/sdk';
import { onFrame } from './frame-loop';

interface Follower {
  spec: ParamSpec;
  paint(value: ParamValue | null): void;
}

export class AutomationFollowers {
  private readonly byKey = new Map<string, Set<Follower>>();
  private keys: string[] = [];
  /** `groups[i]` holds the followers of `keys[i]` as an array, so a frame walks them without iterator objects. */
  private groups: Follower[][] = [];
  private out = new Float64Array(0);
  private stop: (() => void) | null = null;

  constructor(private readonly engine: () => EngineApi) {}

  follow(key: string, spec: ParamSpec, paint: (value: ParamValue | null) => void): () => void {
    const f: Follower = { spec, paint };
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(f);
    this.rebuild();
    return () => {
      const s = this.byKey.get(key);
      s?.delete(f);
      if (s && s.size === 0) this.byKey.delete(key);
      this.rebuild();
    };
  }

  private rebuild(): void {
    this.keys = [...this.byKey.keys()];
    this.groups = this.keys.map((key) => [...(this.byKey.get(key) ?? [])]);
    if (this.out.length < this.keys.length) this.out = new Float64Array(this.keys.length * 2);
    if (this.keys.length > 0 && !this.stop) this.stop = onFrame(() => this.frame());
    else if (this.keys.length === 0 && this.stop) {
      this.stop();
      this.stop = null;
    }
  }

  private frame(): void {
    const keys = this.keys;
    if (keys.length === 0) return;
    this.engine().readAutomation(keys, this.out);
    for (let i = 0; i < keys.length; i++) {
      const v = this.out[i] as number;
      const group = this.groups[i] as Follower[];
      for (let j = 0; j < group.length; j++) {
        const f = group[j] as Follower;
        f.paint(Number.isNaN(v) ? null : decode(f.spec, v));
      }
    }
  }
}
