/**
 * FL-style record mode: R arms recording, Play starts it, Stop ends it. Features register recorders
 * (note recording from MIDI and the typing keyboard, automation from knob moves, audio); the
 * controller starts every registered recorder when playback starts while armed and stops them when it
 * stops. Recorders write their takes through History themselves.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EngineApi } from '@engine/api';

export interface Recorder {
  id: string;
  /** Which record setting runs it: 'notes' (notes and knob moves, the default) or 'audio'. */
  kind?: 'notes' | 'audio';
  /** Playback started with recording armed. `tick`: where playback started. */
  start(info: { tick: number }): void;
  /** Playback stopped (or recording was disarmed while playing). */
  stop(): void;
}

export interface RecordState {
  /** Record mode is on (the R button). */
  armed: boolean;
  /** Recorders are running (armed and playing). */
  recording: boolean;
}

export class RecordController {
  readonly store: StoreApi<RecordState> = createStore<RecordState>(() => ({ armed: false, recording: false }));
  private readonly recorders = new Map<string, Recorder>();
  /** The recorders this take started. */
  private running: Recorder[] = [];
  private wasPlaying = false;

  constructor(
    private readonly engine: EngineApi,
    /** Whether record mode records this kind (Options › Record: notes, audio). */
    private readonly records: (kind: 'notes' | 'audio') => boolean = () => true,
  ) {
    engine.subscribe(() => this.sync());
  }

  /** The recorders of a kind that are registered (the UI says what record mode will record). */
  has(kind: 'notes' | 'audio'): boolean {
    return [...this.recorders.values()].some((r) => (r.kind ?? 'notes') === kind);
  }

  register(r: Recorder): () => void {
    this.recorders.set(r.id, r);
    return () => {
      if (this.recorders.get(r.id) === r) this.recorders.delete(r.id);
    };
  }

  get armed(): boolean {
    return this.store.getState().armed;
  }

  get recording(): boolean {
    return this.store.getState().recording;
  }

  setArmed(armed: boolean): void {
    if (armed === this.armed) return;
    this.store.setState({ armed });
    if (!armed && this.recording) this.stopAll();
  }

  toggle(): void {
    this.setArmed(!this.armed);
  }

  /** Follows the engine: playback starting while armed starts recording, stopping ends it. */
  private sync(): void {
    const playing = this.engine.playing;
    if (playing === this.wasPlaying) return;
    this.wasPlaying = playing;
    if (playing && this.armed) {
      this.store.setState({ recording: true });
      const tick = this.engine.playhead();
      this.running = [...this.recorders.values()].filter((r) => this.records(r.kind ?? 'notes'));
      for (const r of this.running) {
        try {
          r.start({ tick });
        } catch (err) {
          console.error(`[agstudio] recorder ${r.id} failed to start`, err);
        }
      }
    } else if (!playing && this.recording) this.stopAll();
  }

  private stopAll(): void {
    this.store.setState({ recording: false });
    const running = this.running;
    this.running = [];
    for (const r of running) {
      try {
        r.stop();
      } catch (err) {
        console.error(`[agstudio] recorder ${r.id} failed to stop`, err);
      }
    }
  }
}
