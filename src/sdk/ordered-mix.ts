/**
 * A repeatable sum of several signals.
 *
 * Why this exists: when three or more nodes feed one node, Chrome adds them in an order that changes from run to
 * run (it walks a set keyed by memory address). Float addition is not associative, so the same offline render can
 * differ by a last bit between two runs. Two inputs are safe (a + b is the same either way), so offline contexts
 * get a ladder of unity-gain stages with at most two inputs each, in a fixed order. A live context sums directly:
 * nobody compares live audio bit for bit, and the extra nodes would only cost CPU.
 */

/** Whether `ac` is rendered to a buffer, where two renders of one project are expected to match bit for bit. */
function isOffline(ac: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
}

/** Disconnects `from` → `to`, whether or not they are connected. */
function disconnectQuietly(from: AudioNode, to: AudioNode): void {
  try {
    from.disconnect(to);
  } catch {
    /* not connected */
  }
}

/** Options of an OrderedMix. */
export interface OrderedMixOptions {
  /** Force the ladder on (true) or off (false). Default: on in offline contexts, off in live ones. */
  ordered?: boolean;
}

/**
 * Where several sources add up into `into`. Connect a source with `attach` instead of `source.connect(into)`; every
 * input of `into` must come through the mix. Offline, the sources sit on a ladder
 *
 *   into ◄─ stage 1 ◄─ stage 2 ◄─ …   (source n joins stage n, which has only that source and the next stage)
 *
 * so no node ever has more than two inputs and the sum is added in the same order every time. The first free stage
 * is always reused, so the order depends only on the order of attach and detach calls, which the caller already
 * makes in a repeatable order.
 */
export class OrderedMix {
  /** `stages[n]` takes source slot n; stage 0 is `into` itself. */
  private readonly stages: AudioNode[];
  /** The source on each slot (null: free). */
  private readonly slots: (AudioNode | null)[] = [];
  private readonly ordered: boolean;

  constructor(
    private readonly ac: BaseAudioContext,
    private readonly into: AudioNode,
    options: OrderedMixOptions = {},
  ) {
    this.stages = [into];
    this.ordered = options.ordered ?? isOffline(ac);
  }

  /** Connects `source` into the mix. The returned function disconnects it again (safe to call twice). */
  attach(source: AudioNode): () => void {
    if (!this.ordered) {
      source.connect(this.into);
      return () => disconnectQuietly(source, this.into);
    }
    const slot = this.claimSlot(source);
    const stage = this.stage(slot);
    source.connect(stage);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      disconnectQuietly(source, stage);
      this.slots[slot] = null;
    };
  }

  /** Drops the stages. The sources should have been detached; any still attached are disconnected from the mix. */
  dispose(): void {
    this.slots.forEach((source, slot) => {
      if (source) disconnectQuietly(source, this.stages[slot] as AudioNode);
    });
    this.slots.length = 0;
    for (const stage of this.stages.slice(1)) stage.disconnect();
    this.stages.length = 1;
  }

  /** The lowest free slot, taken by `source`. */
  private claimSlot(source: AudioNode): number {
    const free = this.slots.indexOf(null);
    const slot = free === -1 ? this.slots.length : free;
    this.slots[slot] = source;
    return slot;
  }

  /** The stage of a slot, making the ladder longer as needed. */
  private stage(slot: number): AudioNode {
    while (this.stages.length <= slot) {
      const next = new GainNode(this.ac);
      next.connect(this.stages[this.stages.length - 1] as AudioNode);
      this.stages.push(next);
    }
    return this.stages[slot] as AudioNode;
  }
}
