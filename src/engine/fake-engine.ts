import type { DocChange } from '@core/history/history';
import type { InsertId, SampleRef } from '@core/model/types';
import type { AudioTap } from '@agstudio/sdk';
import type {
  AudioCapture,
  AudioInput,
  CapturedAudio,
  EngineApi,
  EngineSession,
  EngineState,
  EngineStats,
  SampleData,
  TransportView,
} from './api';
import { INACTIVE_TAP } from './tap';

/**
 * A live input for Node tests: `feed()` appends audio as if it arrived from the microphone; a
 * capture holds everything fed after it started, timed from `startTime`.
 */
export class FakeAudioInput implements AudioInput {
  closed = false;
  monitor: InsertId | null = null;
  level = 0;
  capture: (AudioCapture & { fed: Float32Array[][] }) | null = null;
  constructor(
    readonly channelCount: 1 | 2,
    readonly label: string,
    readonly estimatedLatency: number,
    private readonly clock: () => number,
    private readonly sampleRate = 48000,
  ) {}
  levels(out: Float32Array): void {
    out[0] = this.level;
    out[1] = this.level;
  }
  setMonitor(track: InsertId | null): void {
    this.monitor = track;
  }
  /** Audio arriving now (one array per channel). */
  feed(channels: Float32Array[]): void {
    this.capture?.fed.push(channels);
  }
  startCapture(): AudioCapture {
    const sr = this.sampleRate;
    const fed: Float32Array[][] = [];
    const startTime = this.clock();
    const frames = () => fed.reduce((n, f) => n + (f[0]?.length ?? 0), 0);
    const c = {
      fed,
      sampleRate: sr,
      channelCount: this.channelCount,
      startTime,
      get frames() {
        return frames();
      },
      peaks: new Float32Array(0),
      buckets: 0,
      bucket: 256,
      stop: async (): Promise<CapturedAudio> => {
        const n = frames();
        const channels = Array.from({ length: this.channelCount }, (_, ch) => {
          const all = new Float32Array(n);
          let o = 0;
          for (const f of fed) {
            all.set(f[ch] ?? f[0] ?? new Float32Array(0), o);
            o += f[0]?.length ?? 0;
          }
          return all;
        });
        this.capture = null;
        return { channels, sampleRate: sr, startTime, dropped: 0 };
      },
      cancel: () => {
        this.capture = null;
      },
    };
    this.capture = c;
    return c;
  }
  close(): void {
    this.closed = true;
  }
}

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
  ready(): Promise<void> {
    return Promise.resolve();
  }
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
  /** Where the last `play()` started (undefined = from the start or the song position). */
  lastPlayFrom: number | undefined = undefined;
  play(fromTick?: number): void {
    this.playing = true;
    this.lastPlayFrom = fromTick;
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
  /** Where playback (is set to) start: see startTick below. */
  playhead(): number {
    return this.startTick;
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
  /** Decoded audio sampleData() serves, by sample name. */
  sampleAudio = new Map<string, SampleData>();
  async sampleData(ref: Pick<SampleRef, 'source' | 'name'>): Promise<SampleData | null> {
    return this.sampleAudio.get(ref.name) ?? null;
  }
  /** The inputs openAudioInput() gave out (tests feed them audio). */
  inputs: FakeAudioInput[] = [];
  /** Round trip the fake inputs report (seconds). */
  inputLatency = 0.01;
  async openAudioInput(_stream: MediaStream, opts: { channels: 1 | 2; label?: string }): Promise<AudioInput> {
    const input = new FakeAudioInput(opts.channels, opts.label ?? 'Test input', this.inputLatency, () => this.clockTime);
    this.inputs.push(input);
    return input;
  }
  playTestClicks(count: number, interval: number): number[] {
    return Array.from({ length: count }, (_, i) => this.clockTime + 0.3 + i * interval);
  }
  openEnded = false;
  setSongOpenEnded(on: boolean): void {
    this.openEnded = on;
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
  /** Channels reported as being time-stretched. */
  stretching = new Set<string>();
  isStretching(channelId: string): boolean {
    return this.stretching.has(channelId);
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
