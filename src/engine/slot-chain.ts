/**
 * A chain of effect slots in series: what a mixer insert has between its input and its sidechain tap, and what each
 * branch of an effect rack has between the branch's head and its tail.
 *
 *   head → slot 1 … slot N → sink          (an empty chain connects head straight to sink)
 *
 * Each slot is an `FxSlotStrip`. Slots are keyed by `SlotId`: new ones are created, removed ones disposed, and moving
 * one only rewires the chain (the instance keeps running). The chain also answers what the mixer asks of a row of
 * effects: their latency, how long they ring, whether they let the insert park, and where each sits in the delay
 * compensation.
 */
import type { FxSlot, InsertId, PluginOwner, Project, SlotId } from '@core/model/types';
import { disconnectFrom } from './audio-graph';
import type { EngineCore } from './engine-core';
import { FxSlotStrip, type SlotHooks, type SlotIdleNeeds } from './fx-slot-strip';

/** What a chain is made with. */
export interface SlotChainOptions {
  core: EngineCore;
  /** The insert the slots belong to: their owners are `{ kind: 'fx', insertId, slotId }`, inside a rack too. */
  insertId: InsertId;
  /** Where the chain starts: the first slot's input is fed from here. */
  head: AudioNode;
  /** Where the last slot's output goes (the head itself, when there are no slots). */
  sink: AudioNode;
  /** Called when the latency of the chain (or what listens to a sidechain in it) changes. */
  onLatency?: () => void;
  /** For the chains inside a rack: the owner of the rack, and what the rack wants to know about each slot. */
  parentOwner?: PluginOwner;
  hooks?: SlotHooks;
}

/** A row of effect slots wired in series between a head and a sink. */
export class SlotChain {
  private readonly strips = new Map<SlotId, FxSlotStrip>();
  /** The slot ids in chain order, as last wired. */
  private ids: readonly SlotId[] = [];
  private ordered: readonly FxSlotStrip[] = [];
  /** The last node of the chain (the head when there are no slots): what feeds the sink. */
  private end: AudioNode;
  /** The chain is cut off from the sink because nothing can sound in it (see `park`). */
  private isParked = false;
  private readonly core: EngineCore;
  private readonly head: AudioNode;
  private readonly sink: AudioNode;

  constructor(private readonly options: SlotChainOptions) {
    this.core = options.core;
    this.head = options.head;
    this.sink = options.sink;
    this.end = options.head;
    this.wire([]);
  }

  /** The slots in chain order. */
  get slotStrips(): readonly FxSlotStrip[] {
    return this.ordered;
  }

  /** The chain is cut off from its sink (see `park`). */
  get parked(): boolean {
    return this.isParked;
  }

  /** Resolves when every effect of the chain has been created. */
  get ready(): Promise<void> {
    return Promise.all([...this.strips.values()].map((slot) => slot.ready)).then(() => undefined);
  }

  /** Seconds of tail the effects add (they run in series). */
  get tailTime(): number {
    let tail = 0;
    for (const slot of this.strips.values()) tail += slot.tailTime;
    return tail;
  }

  /** Frames of latency the live effects add, one after the other. */
  get latencyFrames(): number {
    let frames = 0;
    for (const slot of this.ordered) frames += slot.latencyFrames;
    return frames;
  }

  /**
   * What the chain needs before it may be parked: every effect that reports its sleep is asleep, and the ones that
   * cannot say so have had silence at the input for as long as they ring (`tailSec`, the sum for effects in series:
   * an echo can leave one effect after another has gone quiet).
   */
  idleNeeds(): SlotIdleNeeds {
    let busy = false;
    let tailSec = 0;
    for (const slot of this.ordered) {
      const needs = slot.idleNeeds();
      busy = busy || needs.busy;
      tailSec += needs.tailSec;
    }
    return { busy, tailSec };
  }

  /**
   * Cuts the chain off from its sink while nothing can sound in it. The browser pulls audio backwards through
   * connections, so with the last effect connected to nothing the whole chain is no longer processed.
   */
  park(): void {
    if (this.isParked) return;
    this.isParked = true;
    disconnectFrom(this.end, this.sink);
    for (const slot of this.ordered) slot.setParked(true);
  }

  /** Puts the chain back between its head and its sink. */
  unpark(): void {
    if (!this.isParked) return;
    this.isParked = false;
    this.end.connect(this.sink);
    for (const slot of this.ordered) slot.setParked(false);
  }

  /**
   * The audio entering the chain is `arrivalFrames` behind the time the song schedules it (delay compensation). Each
   * slot's params follow what reaches it. Returns where the audio is when it leaves the chain, in frames.
   */
  setAlignment(arrivalFrames: number): number {
    const sampleRate = this.core.ctx.sampleRate;
    let at = arrivalFrames;
    for (const slot of this.ordered) {
      const latency = slot.latencyFrames;
      slot.setShift(at / sampleRate, (at + latency) / sampleRate);
      at += latency;
    }
    return at;
  }

  /** Brings the chain in line with the document's slots (new ones made, removed ones disposed, moved ones rewired). */
  sync(fx: readonly FxSlot[], project: Project): void {
    const next: FxSlotStrip[] = [];
    const ids: SlotId[] = [];
    for (const data of fx) {
      if (ids.includes(data.id)) continue;
      let strip = this.strips.get(data.id);
      if (strip) {
        strip.update(data, project);
      } else {
        strip = new FxSlotStrip(this.core, this.options.insertId, data, project, this.options.onLatency, {
          parentOwner: this.options.parentOwner,
          hooks: this.options.hooks,
        });
        strip.setParked(this.isParked);
        this.strips.set(data.id, strip);
      }
      next.push(strip);
      ids.push(data.id);
    }
    const removed = [...this.strips].filter(([id]) => !ids.includes(id));
    const reordered = ids.length !== this.ids.length || ids.some((id, i) => id !== this.ids[i]);
    if (reordered) this.wire(next);
    this.ids = ids;
    this.ordered = next;
    for (const [id, strip] of removed) {
      this.strips.delete(id);
      strip.dispose();
    }
    // Slot order decides how much latency sits ahead of each sidechain input.
    if (reordered) this.options.onLatency?.();
    if (reordered || removed.length > 0) this.core.idle?.rewired();
  }

  samplesChanged(project: Project): void {
    for (const slot of this.strips.values()) slot.samplesChanged(project);
  }

  /** The set of automated plugin instances changed (see FxSlotStrip.automationChanged). */
  automationChanged(project: Project): void {
    for (const slot of this.strips.values()) slot.automationChanged(project);
  }

  /** Rebuilds effects whose plugin definition changed (hot reload, install/uninstall). */
  pluginsChanged(ids: ReadonlySet<string>, project: Project): void {
    for (const slot of this.strips.values()) if (ids.has(slot.pluginId)) slot.reload(project);
    for (const slot of this.strips.values()) slot.innerPluginsChanged(ids, project);
  }

  /** Disposes the slots and lets go of the head (the sink and everything past it belong to the caller). */
  dispose(): void {
    for (const slot of this.strips.values()) slot.dispose();
    this.strips.clear();
    this.ordered = [];
    this.ids = [];
    this.head.disconnect();
  }

  /** Connects the head → each slot in turn → the sink. */
  private wire(chain: readonly FxSlotStrip[]): void {
    this.head.disconnect();
    for (const slot of this.strips.values()) slot.output.disconnect();
    let previous: AudioNode = this.head;
    for (const slot of chain) {
      previous.connect(slot.input);
      previous = slot.output;
    }
    this.end = previous;
    if (!this.isParked) previous.connect(this.sink);
  }
}
