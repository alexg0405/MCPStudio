import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, SampleRef, Tick } from '@core/model/types';
import type {
  AudioInput,
  DeckHost,
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
/** How long a reboot waits for the new engine's sounds before playing anyway (ms). */
const READY_WAIT_MS = 5000;

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
  /** The engine being made during a reboot while the old one still plays: it hears every change meanwhile too. */
  private pending: EngineApi | null = null;
  private rebootAgain = false;
  /** Stop or play was pressed during a reboot: the engine does not start by itself afterwards. */
  private resumeCancelled = false;
  private openEnded = false;

  constructor(private readonly factory: () => EngineApi) {
    this.inner = factory();
    this.detach = this.inner.subscribe(() => this.emit());
  }

  /**
   * Replaces the engine with a fresh one (new AudioContext), keeping the project and transport. A
   * request that arrives while a reboot runs makes one more afterwards (the factory reads the newest
   * settings each time), so the last request always wins.
   */
  reboot(): Promise<void> {
    if (this.rebooting) {
      this.rebootAgain = true;
      return this.rebooting;
    }
    this.rebooting = (async () => {
      do {
        this.rebootAgain = false;
        await this.rebootOnce();
      } while (this.rebootAgain);
    })().finally(() => {
      this.rebooting = null;
    });
    return this.rebooting;
  }

  private async rebootOnce(): Promise<void> {
    const old = this.inner;
    const wasPlaying = old.playing;
    // Made before anything is let go of: if no engine can be made, the running one stays.
    const next = this.factory();
    this.resumeCancelled = false;
    this.prepare(next);
    if (wasPlaying) {
      // Seamless: the old engine keeps playing while the new one loads its sounds (the gap used to be the whole
      // load); then the new one starts where the song will be when its first sound arrives, and the old one fades
      // out as that happens.
      this.pending = next;
      void next.resume().catch(() => {});
      await Promise.race([next.ready().catch(() => {}), new Promise<void>((r) => setTimeout(r, READY_WAIT_MS))]);
      this.pending = null;
      if (old.playing) {
        this.handOver(old, next);
        this.emit();
        return;
      }
      // Stopped meanwhile: nothing to carry on; the new engine just takes over.
      this.swap(next);
      await old.dispose();
      void next.resume().catch(() => {});
      this.emit();
      return;
    }
    this.swap(next);
    await old.dispose();
    // Don't wait: without a recent gesture resume() can stay pending until the next click,
    // which the audio-unlock listener provides (the toolbar shows "click to enable" meanwhile).
    void next.resume().catch(() => {});
    this.emit();
  }

  /** Gives a new engine everything the running one knows. */
  private prepare(next: EngineApi): void {
    if (this.lastDoc) next.applyDocChange({ ...this.lastDoc, prev: this.lastDoc.next, origin: 'load', patches: null });
    if (this.view) next.setTransportView(this.view);
    if (this.session) next.setSession(this.session);
    if (this.outputDevice) void next.setOutputDevice(this.outputDevice);
    if (this.openEnded) next.setSongOpenEnded(true);
  }

  private swap(next: EngineApi): void {
    this.detach();
    this.inner = next;
    this.detach = next.subscribe(() => this.emit());
  }

  /** The new engine takes over a song that is playing: it starts at the tick that will be heard as it begins. */
  private handOver(old: EngineApi, next: EngineApi): void {
    const st = next.stats();
    const oldSt = old.stats();
    const headMs = ((st.startLead ?? 0.05) + st.baseLatency + st.outputLatency) * 1000;
    const oldMs = (oldSt.baseLatency + oldSt.outputLatency) * 1000;
    // How far the song moves while the new engine starts (tempo and loops are the old engine's to know).
    const t0 = old.contextTimeAt(performance.now());
    const ahead = old.tickAt(t0 + headMs / 1000).tick - old.tickAt(t0).tick;
    const tick = old.playhead() + (Number.isFinite(ahead) && ahead >= 0 && ahead < 4 * 3840 ? ahead : 0);
    this.swap(next);
    // Starting again is not a take: no count-in clicks first.
    const session = this.session;
    const countIn = !!session && session.countInBars > 0;
    if (session && countIn) next.setSession({ ...session, countInBars: 0 });
    next.play(Math.max(0, tick));
    if (session && countIn) next.setSession(session);
    // The old engine fades out as the new one's first sound reaches the speakers.
    setTimeout(() => void old.dispose(), Math.max(0, headMs - oldMs - 6));
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
    this.pending?.applyDocChange(change);
  }
  pluginsChanged(ids: readonly string[]): void {
    this.inner.pluginsChanged(ids);
    this.pending?.pluginsChanged(ids);
  }
  setTransportView(view: TransportView): void {
    this.view = view;
    this.inner.setTransportView(view);
    this.pending?.setTransportView(view);
  }
  play(fromTick?: Tick): void {
    this.resumeCancelled = true;
    this.inner.play(fromTick);
  }
  stop(): void {
    this.resumeCancelled = true;
    this.inner.stop();
  }
  panic(): void {
    this.resumeCancelled = true;
    this.inner.panic();
  }
  setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDevice = deviceId;
    void this.pending?.setOutputDevice(deviceId);
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
    this.pending?.setSongOpenEnded(on);
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
    this.pending?.setSession(session);
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
  deckHost(): DeckHost | null {
    return this.inner.deckHost?.() ?? null;
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
