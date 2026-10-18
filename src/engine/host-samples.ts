import type { PluginInstance, Project, SampleId, SampleRef } from '@core/model/types';
import type { SampleSlots } from '@agstudio/sdk';
import { Emitter } from './emitter';
import { SampleCache } from './samples';

/**
 * The sample slots of one plugin instance (`host.samples`): which sample sits in each slot, its decoded buffer,
 * and the change notifications. The samples in the slots stay in memory while the plugin lives (plugins keep
 * their buffers): the slots pin their cache entries.
 */
export class HostSampleSlots {
  /** What a plugin sees as `host.samples`. Arrow functions, so a plugin may take them apart (`const { get } = …`). */
  readonly api: SampleSlots;
  /** Slot name → the sample in it. */
  private slots: Record<string, SampleId>;
  private project: Project;
  private readonly changes = new Map<string, Emitter<[AudioBuffer | null]>>();
  private pins: Array<() => void> = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly cache: SampleCache,
    data: PluginInstance,
    project: Project,
  ) {
    this.project = project;
    this.slots = { ...(data.samples ?? {}) };
    this.pinSlots();
    this.api = {
      get: (slot) => this.bufferIn(slot),
      load: (slot) => this.load(slot),
      onChange: (slot, callback) => this.emitterFor(slot).on(callback),
      name: (slot) => this.refIn(slot)?.name ?? null,
      durationSec: (slot) => {
        const ref = this.refIn(slot);
        return ref ? this.cache.knownDuration(ref, this.ctx.sampleRate) : null;
      },
      needsDecode: (slot) => {
        const ref = this.refIn(slot);
        if (!ref || ref.source.kind !== 'embedded') return false;
        return !this.cache.has(SampleCache.keyOf(ref.source, this.ctx.sampleRate));
      },
    };
  }

  /** The document changed: new project, maybe other samples in the slots (those that changed are loaded and announced). */
  apply(data: PluginInstance, project: Project): void {
    this.project = project;
    const nextSlots = data.samples ?? {};
    const slotNames = new Set([...Object.keys(this.slots), ...Object.keys(nextSlots)]);
    const prevSlots = this.slots;
    this.slots = { ...nextSlots };
    this.pinSlots();
    for (const slot of slotNames) {
      if (prevSlots[slot] === nextSlots[slot]) continue;
      void this.load(slot).then((buffer) => this.changes.get(slot)?.emit(buffer));
    }
  }

  /** Lets the samples go and forgets the listeners. */
  dispose(): void {
    for (const release of this.pins) release();
    this.pins = [];
    for (const emitter of this.changes.values()) emitter.clear();
  }

  private emitterFor(slot: string): Emitter<[AudioBuffer | null]> {
    let emitter = this.changes.get(slot);
    if (!emitter) {
      emitter = new Emitter();
      this.changes.set(slot, emitter);
    }
    return emitter;
  }

  /** Pins what is in the slots now, then lets go of what was pinned before (so a sample that stays is never unpinned). */
  private pinSlots(): void {
    const previous = this.pins;
    this.pins = [];
    for (const id of Object.values(this.slots)) {
      const ref = id ? this.project.samples[id] : undefined;
      if (ref) this.pins.push(this.cache.pin(SampleCache.keyOf(ref.source, this.ctx.sampleRate)));
    }
    for (const release of previous) release();
  }

  private refIn(slot: string): SampleRef | undefined {
    const id = this.slots[slot];
    return id ? this.project.samples[id] : undefined;
  }

  private bufferIn(slot: string): AudioBuffer | null {
    const ref = this.refIn(slot);
    return ref ? this.cache.getSync(ref, this.ctx.sampleRate) : null;
  }

  private async load(slot: string): Promise<AudioBuffer | null> {
    const ref = this.refIn(slot);
    return ref ? this.cache.load(ref, this.ctx) : null;
  }
}
