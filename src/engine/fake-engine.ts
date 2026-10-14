import type { DocChange } from '@core/history/history';
import type { InsertId } from '@core/model/types';
import type { AudioTap } from '@agstudio/sdk';
import type { EngineApi, EngineSession, EngineState, EngineStats, TransportView } from './api';
import { INACTIVE_TAP } from './tap';

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
  outputDevice = '';
  setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDevice = deviceId;
    return Promise.resolve(true);
  }
  /** How many times panic() ran. */
  panics = 0;
  panic(): void {
    this.panics++;
    this.stop();
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
  /** Live controls it was sent: [channelId, cc, value] and [channelId, cents]. */
  controls: [string, number, number][] = [];
  bends: [string, number][] = [];
  previewControl(channelId: string, cc: number, value: number): void {
    this.controls.push([channelId, cc, value]);
  }
  previewPitchBend(channelId: string, cents: number): void {
    this.bends.push([channelId, cents]);
  }
  previewSample(): void {}
  record(): Promise<never> {
    return Promise.reject(new Error('The test engine cannot record.'));
  }
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
  /** Settable clock and tempo for timing tests: tickAt() maps time to ticks from `startTime` at `tempo`. */
  clockTime = 0;
  startTime = 0;
  startTick = 0;
  tempo = 130;
  tickAt(contextTime: number): { tick: number; iter: number } {
    if (!this.playing) return { tick: this.startTick, iter: 0 };
    return { tick: this.startTick + ((contextTime - this.startTime) * this.tempo * 960) / 60, iter: 0 };
  }
  contextTimeAt(performanceMs: number): number {
    return performanceMs / 1000;
  }
  /** Values readAutomation() reports per key (absent = NaN). */
  automation = new Map<string, number>();
  readAutomation(keys: readonly string[], out: Float64Array): void {
    for (let i = 0; i < keys.length && i < out.length; i++)
      out[i] = this.automation.get(keys[i] as string) ?? Number.NaN;
  }
  touched = new Set<string>();
  touch(key: string, on: boolean): void {
    if (on) this.touched.add(key);
    else this.touched.delete(key);
  }
  tempoNow(): number {
    return this.tempo;
  }
  session: EngineSession = { metronome: false, countInBars: 0 };
  setSession(session: EngineSession): void {
    this.session = { ...session };
  }
  graphLatency(): number {
    return 0;
  }
  outputTap(): AudioTap {
    return INACTIVE_TAP;
  }
  stats(): EngineStats {
    return {
      state: this.state,
      sampleRate: this.sampleRate,
      baseLatency: 0,
      outputLatency: 0,
      lookahead: 0.12,
      lateEvents: 0,
      maxPumpGapMs: 0,
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
