import type { DocChange } from '@core/history/history';
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
