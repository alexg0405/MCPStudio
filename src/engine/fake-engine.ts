import type { DocChange } from '@core/history/history';
import type { InsertId } from '@core/model/types';
import type { EngineApi, EngineState, EngineStats, TransportView } from './api';

/** An engine stand-in for Node tests and UI work without audio. Records what it was told. */
export class FakeEngine implements EngineApi {
  readonly sampleRate = 48000;
  state: EngineState = 'running';
  playing = false;
  changes: DocChange[] = [];
  view: TransportView | null = null;
  private listeners = new Set<() => void>();
  private noteSeq = 0;

  async resume(): Promise<void> {}
  applyDocChange(change: DocChange): void {
    this.changes.push(change);
  }
  pluginChanges: string[][] = [];
  pluginsChanged(ids: readonly string[]): void {
    this.pluginChanges.push([...ids]);
  }
  setTransportView(view: TransportView): void {
    this.view = view;
  }
  play(): void {
    this.playing = true;
    this.emit();
  }
  stop(): void {
    this.playing = false;
    this.emit();
  }
  playhead(): number {
    return 0;
  }
  playheadIteration(): number {
    return 0;
  }
  previewNoteOn(): number {
    return ++this.noteSeq;
  }
  previewNoteOff(): void {}
  previewSample(): void {}
  waveform(): null {
    return null;
  }
  async previewAudio(): Promise<boolean> {
    return true;
  }
  stopPreview(): void {}
  /** Peaks readMeters() reports per insert ([left, right]); everything else reads 0. */
  meterLevels = new Map<InsertId, readonly [number, number]>();
  readMeters(order: readonly InsertId[], out: Float32Array): void {
    for (let i = 0; i < order.length && i * 2 + 1 < out.length; i++) {
      const level = this.meterLevels.get(order[i] as InsertId);
      out[i * 2] = level?.[0] ?? 0;
      out[i * 2 + 1] = level?.[1] ?? 0;
    }
  }
  stats(): EngineStats {
    return {
      state: this.state,
      sampleRate: this.sampleRate,
      baseLatency: 0,
      outputLatency: 0,
      lookahead: 0.12,
      lateEvents: 0,
      faults: 0,
    };
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
  async dispose(): Promise<void> {}
}
