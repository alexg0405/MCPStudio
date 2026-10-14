/**
 * The audio input recording uses (Options › Audio input…): which device, mono or stereo, the
 * level meter, monitoring through a mixer track, and the round-trip latency recordings are moved by
 * (the browser's estimate, a calibrated measurement, plus a manual correction). The input opens on
 * first use; browsers ask for microphone permission then, which needs a click the first time.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { measureRoundTrip, measurementOk, type LatencyMeasurement } from '@core/audio/latency';
import { MASTER, type InsertId } from '@core/model/types';
import type { AudioInput, EngineApi } from '@engine/api';
import { listAudioInputs, MicError, onAudioInputsChange, openMic, type AudioInputDevice, type MicInput, type OpenMicOptions } from '@platform/mic';
import type { DocStore } from './stores/doc';
import type { PrefsStore } from './stores/prefs';

export interface AudioInputState {
  status: 'off' | 'opening' | 'on' | 'error';
  /** Plain-language reason when status is 'error'. */
  error: string | null;
  /** The open device's name. */
  label: string;
  devices: AudioInputDevice[];
}

export interface AudioInputDeps {
  engine: EngineApi;
  prefs: PrefsStore;
  doc: DocStore;
  /** getUserMedia (tests pass their own stream). */
  openStream?: (opts: OpenMicOptions) => Promise<MicInput>;
}

export class AudioInputService {
  readonly store: StoreApi<AudioInputState> = createStore<AudioInputState>(() => ({
    status: 'off',
    error: null,
    label: '',
    devices: [],
  }));
  private input: AudioInput | null = null;
  private mic: MicInput | null = null;
  private opening: Promise<AudioInput | null> | null = null;
  private readonly openStream: (opts: OpenMicOptions) => Promise<MicInput>;

  constructor(private readonly deps: AudioInputDeps) {
    this.openStream = deps.openStream ?? openMic;
    // A new device or channel count reopens an open input; monitoring follows its settings.
    deps.prefs.subscribe((next, prev) => {
      if (!this.input) return;
      if (next.audioInputDevice !== prev.audioInputDevice || next.audioInputChannels !== prev.audioInputChannels) {
        this.close();
        void this.open();
      } else if (next.audioMonitor !== prev.audioMonitor || next.audioInputTrack !== prev.audioInputTrack) this.applyMonitor();
    });
    // The input's mixer track was deleted: monitoring goes to the master.
    deps.doc.subscribe((next, prev) => {
      if (this.input && next.project.mixer !== prev.project.mixer) this.applyMonitor();
    });
    if (typeof window !== 'undefined') onAudioInputsChange(() => void this.refreshDevices());
  }

  /** The open input, or null (closed, or the engine was rebooted). */
  get current(): AudioInput | null {
    if (this.input?.closed) this.release();
    return this.input;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** Opens the input from the settings (asks for permission the first time). Null (and an error) when it can't. */
  open(): Promise<AudioInput | null> {
    if (this.current) return Promise.resolve(this.current);
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(): Promise<AudioInput | null> {
    const p = this.deps.prefs.getState();
    this.store.setState({ status: 'opening', error: null });
    let mic: MicInput;
    try {
      mic = await this.openStream({
        deviceId: p.audioInputDevice || undefined,
        channels: p.audioInputChannels === 'stereo' ? 2 : 1,
      });
    } catch (e) {
      this.store.setState({ status: 'error', error: e instanceof MicError || e instanceof Error ? e.message : String(e) });
      return null;
    }
    try {
      const input = await this.deps.engine.openAudioInput(mic.stream, {
        channels: p.audioInputChannels === 'stereo' ? 2 : 1,
        label: mic.label,
        latency: mic.latency,
      });
      this.mic = mic;
      this.input = input;
      this.store.setState({ status: 'on', error: null, label: mic.label });
      this.applyMonitor();
      void this.refreshDevices();
      return input;
    } catch (e) {
      mic.close();
      this.store.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  close(): void {
    this.input?.close();
    this.release();
    this.store.setState({ status: 'off', error: null });
  }

  private release(): void {
    this.mic?.close();
    this.mic = null;
    this.input = null;
    if (this.store.getState().status === 'on') this.store.setState({ status: 'off' });
  }

  async refreshDevices(): Promise<AudioInputDevice[]> {
    const devices = await listAudioInputs();
    this.store.setState({ devices });
    return devices;
  }

  /** The mixer track the input plays through and recordings go to (the master when it's gone). */
  track(): InsertId {
    const id = this.deps.prefs.getState().audioInputTrack as InsertId;
    return id && this.deps.doc.getState().project.mixer.inserts[id] ? id : MASTER;
  }

  private applyMonitor(): void {
    const input = this.current;
    if (!input) return;
    input.setMonitor(this.deps.prefs.getState().audioMonitor ? this.track() : null);
  }

  /** Writes each channel's recent peak (0–1) into out[0], out[1]; zeros when closed. */
  levels(out: Float32Array): void {
    const input = this.current;
    if (input) input.levels(out);
    else out.fill(0);
  }

  /**
   * The round trip recordings are moved back by (seconds): the calibrated measurement or the
   * browser's estimate, plus the manual correction.
   */
  latency(): number {
    const p = this.deps.prefs.getState();
    const base = p.recordLatencyMs >= 0 ? p.recordLatencyMs / 1000 : (this.current?.estimatedLatency ?? 0);
    return Math.max(0, base + p.recordLatencyOffsetMs / 1000);
  }

  /** Where the latency comes from, for the dialog: "measured 38.2 ms" / "estimated 21 ms". */
  describeLatency(): string {
    const p = this.deps.prefs.getState();
    const ms = Math.round(this.latency() * 10000) / 10;
    const source = p.recordLatencyMs >= 0 ? 'measured' : this.current ? 'estimated by the browser' : 'estimated (open the input to know)';
    const offset = p.recordLatencyOffsetMs ? `, including your ${p.recordLatencyOffsetMs > 0 ? '+' : ''}${p.recordLatencyOffsetMs} ms correction` : '';
    return `${ms} ms (${source}${offset})`;
  }

  /**
   * Plays 8 clicks and records them back to measure the round trip. Resolves the measurement (check
   * it with measurementOk before saving it) or an error in plain words.
   */
  async calibrate(signal?: AbortSignal): Promise<LatencyMeasurement | { error: string }> {
    const input = await this.open();
    if (!input) return { error: this.store.getState().error ?? 'The audio input could not be opened.' };
    // Monitoring would play the clicks again (and feed back): off while measuring.
    input.setMonitor(null);
    const capture = input.startCapture();
    try {
      const times = this.deps.engine.playTestClicks(8, 0.35);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, (times.length * 0.35 + 1) * 1000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Calibration cancelled.', 'AbortError'));
        });
      });
      const audio = await capture.stop();
      return measureRoundTrip(audio.channels, audio.sampleRate, audio.startTime, times);
    } catch (e) {
      capture.cancel();
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.applyMonitor();
    }
  }

  /** Saves a calibration (or −1 to go back to the browser's estimate). */
  setMeasuredLatency(ms: number): void {
    this.deps.prefs.getState().set({ recordLatencyMs: ms >= 0 ? Math.round(ms * 10) / 10 : -1 });
  }
}

export { measurementOk };
