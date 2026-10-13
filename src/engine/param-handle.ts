/**
 * A plugin param as the plugin sees it (ParamHandle). Its value lives in an AutoLane, the single
 * writer of every AudioParam bound to it, so document edits, automation and late bindings stay
 * consistent and `valueAt(t)` answers what the param does at a scheduled time.
 */
import { decode, encode, type ParamHandle, type ParamSignal, type ParamSpec, type ParamValue } from '@agstudio/sdk';
import { Emitter, type Listener } from './emitter';
import { AutoLane } from './param-lane';

const identity = (v: number) => v;

export class ParamHandleImpl<S extends ParamSpec> implements ParamHandle<S> {
  readonly lane: AutoLane;
  private sources: ConstantSourceNode[] = [];
  private changes = new Emitter<[ParamValue, number]>();

  constructor(
    private readonly ctx: BaseAudioContext,
    key: string,
    readonly spec: S,
    private current: ParamValue,
  ) {
    const tau = spec.type === 'float' ? (spec.smoothing ?? 0.008) / 3 : 0;
    this.lane = new AutoLane(ctx, key, spec, encode(spec, current), tau);
  }

  get value() {
    return this.current as never;
  }

  valueAt(time: number) {
    return decode(this.spec, this.lane.valueAt(time)) as never;
  }

  bind(target: AudioParam, map: (v: number) => number = identity): () => void {
    return this.lane.bind(target, map);
  }

  signal(map: (v: number) => number = identity): ParamSignal {
    const node = new ConstantSourceNode(this.ctx, { offset: 0 });
    node.start();
    this.lane.bind(node.offset, map);
    this.sources.push(node);
    return {
      node,
      connect(target: AudioParam) {
        node.connect(target);
        return () => {
          try {
            node.disconnect(target);
          } catch {
            /* already disconnected */
          }
        };
      },
    };
  }

  onChange(cb: (value: never, time: number) => void): () => void {
    return this.changes.on(cb as Listener<[ParamValue, number]>);
  }

  /** A document edit. While automation drives the param, only its base value changes. */
  set(value: ParamValue, time: number): void {
    if (value === this.current) return;
    this.current = value;
    this.lane.setBase(encode(this.spec, value), time);
    if (!this.lane.driven) this.changes.emit(value, time);
  }

  /** Automation (or a controller) moved a value that only `onChange` listeners see. */
  emitScheduled(value: ParamValue, time: number): void {
    this.changes.emit(value, time);
  }

  dispose(): void {
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        /* not started */
      }
      node.disconnect();
    }
    this.sources = [];
    this.lane.dispose();
    this.changes.clear();
  }
}
