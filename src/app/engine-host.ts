import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, SampleRef, Tick } from '@core/model/types';
import type { EngineApi, EngineState, EngineStats, TransportView, Waveform } from '@engine/api';

/**
 * A stable EngineApi that delegates to a replaceable engine. Rebooting (new AudioContext) is how
 * edited AudioWorklet code takes effect: registerProcessor names can't be redefined and worklet
 * modules can't be unloaded from a context.
 */
export class EngineHost implements EngineApi {
  private inner: EngineApi;
  private readonly listeners = new Set<() => void>();
  private detach: () => void;
  private lastDoc: DocChange | null = null;
  private view: TransportView | null = null;
  private rebooting: Promise<void> | null = null;

  constructor(private readonly factory: () => EngineApi) {
    this.inner = factory();
    this.detach = this.inner.subscribe(() => this.emit());
  }

  /** Replaces the engine with a fresh one (new AudioContext), keeping the project and transport. */
  reboot(): Promise<void> {
    this.rebooting ??= (async () => {
      const old = this.inner;
      const wasPlaying = old.playing;
      const at = old.playhead();
      this.detach();
      const next = this.factory();
      if (this.lastDoc)
        next.applyDocChange({ ...this.lastDoc, prev: this.lastDoc.next, origin: 'load', patches: null });
      if (this.view) next.setTransportView(this.view);
      this.inner = next;
      this.detach = next.subscribe(() => this.emit());
      await old.dispose();
      // Don't wait: without a recent gesture resume() can stay pending until the next click,
      // which the audio-unlock listener provides (the toolbar shows "click to enable" meanwhile).
      void next.resume().catch(() => {});
      if (wasPlaying) next.play(Math.max(0, Math.floor(at)));
      this.emit();
    })().finally(() => {
      this.rebooting = null;
    });
    return this.rebooting;
  }

  get sampleRate(): number {
    return this.inner.sampleRate;
  }
  get state(): EngineState {
    return this.inner.state;
  }
  get playing(): boolean {
    return this.inner.playing;
  }
  resume(): Promise<void> {
    return this.inner.resume();
  }
  applyDocChange(change: DocChange): void {
    this.lastDoc = change;
    this.inner.applyDocChange(change);
  }
  pluginsChanged(ids: readonly string[]): void {
    this.inner.pluginsChanged(ids);
  }
  setTransportView(view: TransportView): void {
    this.view = view;
    this.inner.setTransportView(view);
  }
  play(fromTick?: Tick): void {
    this.inner.play(fromTick);
  }
  stop(): void {
    this.inner.stop();
  }
  playhead(): number {
    return this.inner.playhead();
  }
  playheadIteration(): number {
    return this.inner.playheadIteration();
  }
  previewNoteOn(channelId: ChannelId, key: number, velocity?: number): number {
    return this.inner.previewNoteOn(channelId, key, velocity);
  }
  previewNoteOff(channelId: ChannelId, noteId: number): void {
    this.inner.previewNoteOff(channelId, noteId);
  }
  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    this.inner.previewSample(ref);
  }
  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null {
    return this.inner.waveform(ref);
  }
  previewAudio(bytes: ArrayBuffer): Promise<boolean> {
    return this.inner.previewAudio(bytes);
  }
  stopPreview(): void {
    this.inner.stopPreview();
  }
  readMeters(order: readonly InsertId[], out: Float32Array): void {
    this.inner.readMeters(order, out);
  }
  stats(): EngineStats {
    return this.inner.stats();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async dispose(): Promise<void> {
    this.detach();
    await this.inner.dispose();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
