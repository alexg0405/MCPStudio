import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, SampleRef, Tick } from '@core/model/types';
import type {
  AudioInput,
  EngineApi,
  EngineSession,
  EngineState,
  EngineStats,
  RecordOptions,
  RecordingHandle,
  SampleData,
  TransportView,
  Waveform,
} from '@engine/api';
import type { AudioTap } from '@agstudio/sdk';

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
  private session: EngineSession | null = null;
  /** The chosen output device, replayed on a reboot ('' = default). */
  private outputDevice = '';
  private rebooting: Promise<void> | null = null;
  private openEnded = false;

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
      if (this.session) next.setSession(this.session);
      if (this.outputDevice) void next.setOutputDevice(this.outputDevice);
      if (this.openEnded) next.setSongOpenEnded(true);
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
  ready(): Promise<void> {
    return this.inner.ready();
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
  panic(): void {
    this.inner.panic();
  }
  setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDevice = deviceId;
    return this.inner.setOutputDevice(deviceId);
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
  previewControl(channelId: ChannelId, cc: number, value: number): void {
    this.inner.previewControl(channelId, cc, value);
  }
  previewPitchBend(channelId: ChannelId, cents: number): void {
    this.inner.previewPitchBend(channelId, cents);
  }
  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    this.inner.previewSample(ref);
  }
  record(stream: MediaStream, opts: RecordOptions & { playAlong: boolean; fromTick?: Tick }): Promise<RecordingHandle> {
    return this.inner.record(stream, opts);
  }
  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null {
    return this.inner.waveform(ref);
  }
  previewAudio(bytes: ArrayBuffer): Promise<boolean> {
    return this.inner.previewAudio(bytes);
  }
  sampleData(ref: Pick<SampleRef, 'source' | 'name'>): Promise<SampleData | null> {
    return this.inner.sampleData(ref);
  }
  openAudioInput(stream: MediaStream, opts: { channels: 1 | 2; label?: string; latency?: number }): Promise<AudioInput> {
    return this.inner.openAudioInput(stream, opts);
  }
  playTestClicks(count: number, interval: number): number[] {
    return this.inner.playTestClicks(count, interval);
  }
  setSongOpenEnded(on: boolean): void {
    this.openEnded = on;
    this.inner.setSongOpenEnded(on);
  }
  stopPreview(): void {
    this.inner.stopPreview();
  }
  readMeters(order: readonly InsertId[], out: Float32Array): void {
    this.inner.readMeters(order, out);
  }
  tickAt(contextTime: number): { tick: number; iter: number } {
    return this.inner.tickAt(contextTime);
  }
  contextTimeAt(performanceMs: number): number {
    return this.inner.contextTimeAt(performanceMs);
  }
  readAutomation(keys: readonly string[], out: Float64Array): void {
    this.inner.readAutomation(keys, out);
  }
  touch(key: string, on: boolean): void {
    this.inner.touch(key, on);
  }
  tempoNow(): number {
    return this.inner.tempoNow();
  }
  setSession(session: EngineSession): void {
    this.session = { ...session };
    this.inner.setSession(session);
  }
  graphLatency(): number {
    return this.inner.graphLatency();
  }
  /** One view for good: it reads whichever engine runs now, so visualizers keep drawing across reboots. */
  private readonly outView: AudioTap = (() => {
    const tap = () => this.inner.outputTap();
    return {
      get active() {
        return tap().active;
      },
      get sampleRate() {
        return tap().sampleRate;
      },
      get fftSize() {
        return tap().fftSize;
      },
      spectrum: (out) => tap().spectrum(out),
      waveform: (out, channel) => tap().waveform(out, channel),
      reading: (name) => tap().reading(name),
    };
  })();
  outputTap(): AudioTap {
    return this.outView;
  }
  isStretching(channelId: ChannelId): boolean {
    return this.inner.isStretching(channelId);
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
