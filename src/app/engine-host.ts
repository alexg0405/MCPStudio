import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, SampleRef, Tick } from '@core/model/types';
import type { LaunchClock, LaunchDriver } from '@core/launcher/run';
import type {
  AudioInput,
  DeckHost,
  EngineApi,
  EngineSession,
  EngineState,
  EngineStats,
  LiveFxOutput,
  MeterHandle,
  PreviewOptions,
  RecordOptions,
  RecordingHandle,
  SampleData,
  TransportView,
  Waveform,
} from '@engine/api';
import type { AudioTap } from '@agstudio/sdk';
import { INACTIVE_TAP } from '@engine/tap';
import { MeterLease } from './meter-lease';

/** How long a reboot waits for the new engine's sounds before playing anyway (ms). */
const READY_WAIT_MS = 5000;
/** A deferred engine is made at the latest this long after the host (a hidden tab never runs animation frames). */
const START_FALLBACK_MS = 1500;
/** After a deferred engine is made, live notes and play wait this long at most for its sounds to load (ms). */
const WARM_MAX_MS = 1500;
/** A live note that waited for the sounds is still played while it is this recent (or still held) (ms). */
const REPLAY_MAX_AGE_MS = 600;
/** Where the sample rate of the last engine is remembered, so the toolbar shows it before the engine exists. */
const RATE_KEY = 'agstudio:audio-rate';
/** Ids of live notes held back while the engine loaded (the engine's own previews start at 2^30). */
const HELD_NOTE_BASE = 2 ** 29;

/** Startup marks (scripts/perf-startup.mjs reads the ones that start with ag:). */
function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') performance.mark(`ag:${name}`);
}

function rememberedRate(): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(RATE_KEY));
    return n >= 8000 && n <= 192000 ? n : 48000;
  } catch {
    return 48000;
  }
}

function rememberRate(rate: number): void {
  try {
    if (rate !== rememberedRate()) globalThis.localStorage?.setItem(RATE_KEY, String(rate));
  } catch {
    /* storage unavailable: the toolbar guesses 48 kHz until the engine exists */
  }
}

export interface EngineHostOptions {
  /**
   * Start with an inert stand-in and make the real engine (the AudioContext, the graph, the sounds) right after the
   * first paint, or the moment anything needs it (play, a live note, the first click...): creating the context is the
   * largest single piece of main-thread work at startup and nothing on the first screen needs sound. Everything the
   * app tells the engine meanwhile (project, view, session, output device) is remembered and handed over, so the real
   * engine starts where one made at once would have.
   */
  deferred?: boolean;
}

/**
 * What the host answers until the real engine exists: nothing plays, audio is not running (the toolbar offers
 * "click to enable", and a click makes the engine), no meters move. Calls that need sound never reach it: the host
 * makes the engine first.
 */
class IdleEngine implements EngineApi {
  readonly state: EngineState = 'suspended';
  readonly playing = false;
  constructor(
    readonly sampleRate: number,
    private readonly bpm: () => number,
  ) {}
  private no(): never {
    throw new Error('The audio engine has not started yet.');
  }
  resume(): Promise<void> {
    return this.no();
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  applyDocChange(): void {}
  pluginsChanged(): void {}
  setTransportView(): void {}
  play(): void {}
  stop(): void {}
  panic(): void {}
  setOutputDevice(): Promise<boolean> {
    return Promise.resolve(true);
  }
  playhead(): number {
    return 0;
  }
  playheadIteration(): number {
    return 0;
  }
  previewNoteOn(): number {
    return this.no();
  }
  previewNoteOff(): void {}
  previewControl(): void {}
  previewPitchBend(): void {}
  previewSample(): void {}
  record(): Promise<RecordingHandle> {
    return this.no();
  }
  waveform(): Waveform | null {
    return null;
  }
  sampleData(): Promise<SampleData | null> {
    return this.no();
  }
  openAudioInput(): Promise<AudioInput> {
    return this.no();
  }
  playTestClicks(): number[] {
    return this.no();
  }
  setSongOpenEnded(): void {}
  previewAudio(): Promise<boolean> {
    return this.no();
  }
  stopPreview(): void {}
  setPreviewVolume(): void {}
  readMeters(order: readonly InsertId[], out: Float32Array): void {
    out.fill(0, 0, order.length * 2);
  }
  tickAt(): { tick: number; iter: number } {
    return { tick: 0, iter: 0 };
  }
  contextTimeAt(): number {
    return 0;
  }
  readAutomation(keys: readonly string[], out: Float64Array): void {
    out.fill(Number.NaN, 0, Math.min(keys.length, out.length));
  }
  touch(): void {}
  tempoNow(): number {
    return this.bpm();
  }
  setSession(): void {}
  graphLatency(): number {
    return 0;
  }
  outputTap(): AudioTap {
    return INACTIVE_TAP;
  }
  isStretching(): boolean {
    return false;
  }
  stats(): EngineStats {
    return {
      state: 'suspended',
      sampleRate: this.sampleRate,
      baseLatency: 0,
      outputLatency: 0,
      lookahead: 0.12,
      lateEvents: 0,
      maxPumpGapMs: 0,
      faults: 0,
    };
  }
  subscribe(): () => void {
    return () => {};
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** A live note that came while a just-made engine was still loading its sounds. */
interface HeldNote {
  channelId: ChannelId;
  key: number;
  velocity: number | undefined;
  at: number;
  /** When it was released, if it already was. */
  releasedAt: number | null;
}

/**
 * A stable EngineApi that delegates to a replaceable engine. Rebooting (new AudioContext) is how
 * edited AudioWorklet code takes effect: registerProcessor names can't be redefined and worklet
 * modules can't be unloaded from a context. With `deferred` the first engine is made after the first paint.
 */
export class EngineHost implements EngineApi {
  private inner: EngineApi;
  /** True until a deferred engine is made. */
  private idle = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** Samples whose overview was asked for before the engine existed: it decodes them once it does. */
  private readonly wantedWaveforms = new Map<string, Pick<SampleRef, 'source'>>();
  /** Callers waiting to hear if the chosen output device could be used (the engine did not exist yet). */
  private deviceWaiters: ((ok: boolean) => void)[] = [];
  /** Callers of resume() before the engine existed: answered once it is made and resumed. */
  private resumeWaiters: (() => void)[] = [];
  /** A just-made deferred engine is still loading its sounds: live notes and play wait for them, briefly. */
  private warming = false;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private heldNotes = new Map<number, HeldNote>();
  private heldSeq = HELD_NOTE_BASE;
  /** Held-back live notes that were played: the host's id → the engine's. */
  private readonly heldIds = new Map<number, number>();
  /** Play was pressed while the sounds loaded: it starts when they are in. */
  private pendingPlay: { from: Tick | undefined } | null = null;
  private readonly listeners = new Set<() => void>();
  private detach: () => void;
  /** Hears the running engine's live MIDI effect notes for the host's own listeners. */
  private detachFx: () => void = () => {};
  private readonly fxListeners = new Set<(output: LiveFxOutput) => void>();
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
  /** The clip launcher's sequencer: the running engine (never two) plays it. */
  private launcher: LaunchDriver | null = null;

  constructor(
    private readonly factory: () => EngineApi,
    opts: EngineHostOptions = {},
  ) {
    if (opts.deferred) {
      this.idle = true;
      this.inner = new IdleEngine(rememberedRate(), () => this.lastDoc?.next.transport.bpm ?? 130);
      this.detach = () => {};
      this.scheduleStart();
    } else {
      mark('engine-start');
      this.inner = factory();
      mark('engine');
      this.detach = this.inner.subscribe(() => this.emit());
      this.watchFx(this.inner);
    }
  }

  /** The real engine, made now if it was waiting for the first paint: whatever makes sound goes through this. */
  private use(): EngineApi {
    if (this.idle) this.start();
    return this.inner;
  }

  /** Makes the engine after the first paint: two animation frames (the second follows a drawn frame), then idle. */
  private scheduleStart(): void {
    const go = () => {
      if (this.idle) this.start();
    };
    const idle = () => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
        .requestIdleCallback;
      if (ric) ric(go, { timeout: 100 });
      else setTimeout(go, 0);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(idle));
    this.startTimer = setTimeout(go, START_FALLBACK_MS);
  }

  /** False only for a deferred host that has not made its engine yet. */
  get started(): boolean {
    return !this.idle;
  }

  /** Makes the deferred engine now (a no-op once it exists). */
  start(): void {
    if (!this.idle) return;
    this.idle = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    mark('engine-start');
    const next = this.factory();
    this.prepare(next, false);
    this.swap(next);
    mark('engine');
    rememberRate(next.sampleRate);
    // Overviews asked for while there was no engine: it decodes them now and tells subscribers when they are in.
    for (const ref of this.wantedWaveforms.values()) next.waveform(ref);
    this.wantedWaveforms.clear();
    const waiters = this.deviceWaiters;
    this.deviceWaiters = [];
    if (this.outputDevice) void next.setOutputDevice(this.outputDevice).then((ok) => waiters.forEach((w) => w(ok)));
    else waiters.forEach((w) => w(true));
    // Asked to resume before it existed, or the page was interacted with already (then the browser lets it run).
    const resumed = this.resumeWaiters;
    this.resumeWaiters = [];
    const active = (globalThis.navigator as (Navigator & { userActivation?: { hasBeenActive: boolean } }) | undefined)
      ?.userActivation?.hasBeenActive;
    if (resumed.length > 0 || active) {
      const release = () => resumed.forEach((r) => r());
      void next.resume().then(release, release);
    }
    // Its instruments load asynchronously: notes and play that come before they are in wait a moment, not vanish.
    this.warming = true;
    const done = () => this.warmed();
    void next.ready().then(done, done);
    this.warmTimer = setTimeout(done, WARM_MAX_MS);
    this.emit();
  }

  /** The sounds are loaded (or waiting longer is pointless): plays what came meanwhile. */
  private warmed(): void {
    if (!this.warming) return;
    this.warming = false;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    const inner = this.inner;
    const now = performance.now();
    const held = this.heldNotes;
    this.heldNotes = new Map();
    for (const [id, n] of held) {
      if (n.releasedAt !== null && now - n.releasedAt > REPLAY_MAX_AGE_MS) continue;
      const innerId = inner.previewNoteOn(n.channelId, n.key, n.velocity);
      if (n.releasedAt !== null) {
        // A tap that came while it loaded sounds for as long as the tap lasted (a short one at least).
        const length = Math.min(400, Math.max(60, n.releasedAt - n.at));
        setTimeout(() => inner.previewNoteOff(n.channelId, innerId), length);
      } else this.heldIds.set(id, innerId);
    }
    const play = this.pendingPlay;
    this.pendingPlay = null;
    if (play) inner.play(play.from);
    this.emit();
  }

  /**
   * Replaces the engine with a fresh one (new AudioContext), keeping the project and transport. A
   * request that arrives while a reboot runs makes one more afterwards (the factory reads the newest
   * settings each time), so the last request always wins.
   */
  reboot(): Promise<void> {
    if (this.idle) {
      // The engine does not exist yet: making it now is the reboot (it reads the newest settings).
      this.start();
      return Promise.resolve();
    }
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
  private prepare(next: EngineApi, device = true): void {
    if (this.lastDoc) next.applyDocChange({ ...this.lastDoc, prev: this.lastDoc.next, origin: 'load', patches: null });
    if (this.view) next.setTransportView(this.view);
    if (this.session) next.setSession(this.session);
    if (device && this.outputDevice) void next.setOutputDevice(this.outputDevice);
    if (this.openEnded) next.setSongOpenEnded(true);
    if (this.previewGain !== null) next.setPreviewVolume(this.previewGain);
  }

  private swap(next: EngineApi): void {
    this.detach();
    // One engine at a time reads the launcher: it does not carry over a reboot that moved playback (the runs end).
    if (this.launcher && this.inner !== next) {
      this.inner.setLauncher?.(null);
      if (this.inner.playing) this.launcher.reset?.();
    }
    this.inner = next;
    if (this.launcher) next.setLauncher?.(this.launcher);
    this.detach = next.subscribe(() => this.emit());
    this.watchFx(next);
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
    return this.use().sampleRate;
  }
  get state(): EngineState {
    return this.inner.state;
  }
  get playing(): boolean {
    return this.pendingPlay !== null || this.inner.playing;
  }
  resume(): Promise<void> {
    // Before the engine exists this only asks for it to be resumed when it is made (right after the first paint): a
    // click that comes first must not pay for creating the AudioContext inside its own handler.
    if (this.idle) return new Promise((resolve) => this.resumeWaiters.push(resolve));
    return this.inner.resume();
  }
  ready(): Promise<void> {
    return this.use().ready();
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
    const engine = this.use();
    if (this.warming) {
      // The engine was just made: playing waits (a moment) for the instruments to load, as a click on play after the
      // page has settled would find them.
      this.pendingPlay = { from: fromTick };
      this.emit();
      return;
    }
    engine.play(fromTick);
  }
  stop(): void {
    this.resumeCancelled = true;
    this.dropWaiting();
    this.inner.stop();
  }
  panic(): void {
    this.resumeCancelled = true;
    this.dropWaiting();
    this.inner.panic();
  }
  /** Stop and panic cancel a play and the notes that were waiting for the sounds to load. */
  private dropWaiting(): void {
    const had = this.pendingPlay !== null;
    this.pendingPlay = null;
    this.heldNotes.clear();
    if (had) this.emit();
  }
  setOutputDevice(deviceId: string): Promise<boolean> {
    this.outputDevice = deviceId;
    void this.pending?.setOutputDevice(deviceId);
    // No engine yet: the device is applied when it is made (what could be used is answered then).
    if (this.idle) return new Promise((resolve) => this.deviceWaiters.push(resolve));
    return this.inner.setOutputDevice(deviceId);
  }
  playhead(): number {
    return this.inner.playhead();
  }
  playheadIteration(): number {
    return this.inner.playheadIteration();
  }
  previewNoteOn(channelId: ChannelId, key: number, velocity?: number): number {
    const engine = this.use();
    if (!this.warming) return engine.previewNoteOn(channelId, key, velocity);
    // The instruments are still loading (a note now would find none): it is played the moment they are in.
    const id = ++this.heldSeq;
    this.heldNotes.set(id, { channelId, key, velocity, at: performance.now(), releasedAt: null });
    return id;
  }
  previewNoteOff(channelId: ChannelId, noteId: number): void {
    const held = this.heldNotes.get(noteId);
    if (held) {
      held.releasedAt = performance.now();
      return;
    }
    const innerId = this.heldIds.get(noteId);
    if (innerId !== undefined) {
      this.heldIds.delete(noteId);
      this.inner.previewNoteOff(channelId, innerId);
      return;
    }
    this.inner.previewNoteOff(channelId, noteId);
  }
  previewControl(channelId: ChannelId, cc: number, value: number): void {
    this.inner.previewControl(channelId, cc, value);
  }
  previewPitchBend(channelId: ChannelId, cents: number): void {
    this.inner.previewPitchBend(channelId, cents);
  }
  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    this.use().previewSample(ref);
  }
  record(stream: MediaStream, opts: RecordOptions & { playAlong: boolean; fromTick?: Tick }): Promise<RecordingHandle> {
    return this.use().record(stream, opts);
  }
  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null {
    if (this.idle) {
      // Drawn before the engine exists (a restored project's samples): remembered, decoded once it does.
      this.wantedWaveforms.set(JSON.stringify(ref.source), { source: ref.source });
      return null;
    }
    return this.inner.waveform(ref);
  }
  previewAudio(bytes: ArrayBuffer, opts?: PreviewOptions): Promise<boolean> {
    return this.use().previewAudio(bytes, opts);
  }
  /** The audition level, kept for engines made later (a reboot, or the first one of a deferred host). */
  private previewGain: number | null = null;
  setPreviewVolume(gain: number): void {
    this.previewGain = gain;
    if (!this.idle) this.inner.setPreviewVolume(gain);
  }
  sampleData(ref: Pick<SampleRef, 'source' | 'name'>): Promise<SampleData | null> {
    return this.use().sampleData(ref);
  }
  openAudioInput(stream: MediaStream, opts: { channels: 1 | 2; label?: string; latency?: number }): Promise<AudioInput> {
    return this.use().openAudioInput(stream, opts);
  }
  playTestClicks(count: number, interval: number): number[] {
    return this.use().playTestClicks(count, interval);
  }
  onLiveFxOutput(listener: (output: LiveFxOutput) => void): () => void {
    this.fxListeners.add(listener);
    return () => this.fxListeners.delete(listener);
  }
  /** Passes the notes the engine's live MIDI effects play on to this host's listeners (and swaps engines without dropping them). */
  private watchFx(engine: EngineApi): void {
    this.detachFx();
    this.detachFx = engine.onLiveFxOutput?.((output) => {
      for (const listener of this.fxListeners) listener(output);
    }) ?? (() => {});
  }
  setLauncher(driver: LaunchDriver | null): void {
    this.launcher = driver;
    this.inner.setLauncher?.(driver);
  }
  launcherClock(): LaunchClock {
    return this.inner.launcherClock?.() ?? { playing: false, heardU: 0, earliestU: 0 };
  }
  launcherChanged(): void {
    this.use().launcherChanged?.();
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
    return this.use().tickAt(contextTime);
  }
  contextTimeAt(performanceMs: number): number {
    return this.use().contextTimeAt(performanceMs);
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
  /** Leases of the open meters (they follow the engine through reboots; see MeterLease). */
  private readonly leases = new Set<MeterLease>();
  openMeter(source: InsertId, opts: { full?: boolean } = {}): MeterHandle {
    const lease = new MeterLease(() => this.inner, source, opts, (l) => this.leases.delete(l));
    this.leases.add(lease);
    return lease;
  }
  /** Meters that are open right now (a closed Meters window and mixer leave none). */
  get openMeters(): number {
    return this.leases.size;
  }
  isStretching(channelId: ChannelId): boolean {
    return this.inner.isStretching(channelId);
  }
  stats(): EngineStats {
    return this.inner.stats();
  }
  deckHost(): DeckHost | null {
    return this.use().deckHost?.() ?? null;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async dispose(): Promise<void> {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    this.warming = false;
    this.idle = false;
    this.detach();
    this.detachFx();
    for (const l of [...this.leases]) l.close();
    await this.inner.dispose();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
