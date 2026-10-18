/**
 * The musician's voice performance: recording from the mic (or importing a file), listening to it
 * (`@core/voice`) and keeping the result as the conversation's take for the next request.
 */
import type { PerformanceRole } from '@core/beat/local';
import { encodeWav } from '@core/io/wav';
import { analyzeVoice, describeEvents, estimateBpm, quantizeToGrid } from '@core/voice';
import type { RecordingHandle } from '@engine/api';
import { openMic, type MicInput } from '@platform/mic';
import type { Take } from '../state';
import { errorText, isAbortError } from './errors';
import { analysisMode } from './performance-role';
import type { AssistantSession } from './session';

/** How often (ms) the recorder checks whether the count-in is over. */
const COUNT_IN_POLL_MS = 50;
/** Time (ms) given to the UI to paint "analyzing" before the synchronous voice analysis blocks the thread. */
const PAINT_BEFORE_ANALYSIS_MS = 30;
/** Detected sounds are placed on a 1/32 grid (half a 1/16 step), so off-beat hits and swing keep their place. */
const GRID_RESOLUTION_STEPS = 0.5;
/** An imported file never makes more than this many bars of take. */
const MAX_IMPORTED_BARS = 4;
/** Imported audio is decoded (and resampled) at this rate; the analysis does not need the project's. */
const IMPORT_DECODE_RATE_HZ = 48000;
/** Where an imported take starts: this long (sec) before its first sound, so the attack is not cut off. */
const IMPORT_LEAD_IN_SEC = 0.01;
/** Playing a take back starts this long (sec) before its first sound. */
const PLAYBACK_LEAD_IN_SEC = 0.05;
/** Beats per bar assumed when sizing an imported file into bars (the file carries no time signature). */
const IMPORT_BEATS_PER_BAR = 4;

/** The recording and the take of one assistant. */
export interface TakeRecorder {
  /** Records `bars` bars after a one-bar count-in (needs a user gesture for the mic prompt). */
  record(): Promise<void>;
  /** Input level of the live recording (0..1), for meters on the frame loop. */
  level(): number;
  /** Seconds since bar 1 of the live recording (negative while counting in), or null. */
  position(): number | null;
  /** Ends the recording now (keeps what was recorded). */
  stop(): void;
  cancel(): void;
  /** A recording made elsewhere (phone voice memo, an audio file): bar 1 is where the sound starts. */
  importFile(file: Pick<File, 'name' | 'arrayBuffer'>): Promise<void>;
  /** Plays the take back (as recorded) on the preview bus. */
  playTake(): void;
}

/** The take analyzed again for a specific instrument (null when that finds nothing). */
export function reanalyzeTake(take: Take, role: PerformanceRole): Take | null {
  if (!take.audio) return null;
  const { samples, sampleRate, startSec } = take.audio;
  const detected = analyzeVoice(samples, sampleRate, { mode: analysisMode(role) });
  const events = quantizeToGrid(
    detected,
    { bpm: take.bpm, startSec, bars: take.bars },
    { resolution: GRID_RESOLUTION_STEPS },
  );
  if (events.length === 0) return null;
  return { ...take, events, summary: describeEvents(events), role, sent: false };
}

/** Makes the recorder of an assistant's session. */
export function createTakeRecorder(session: AssistantSession): TakeRecorder {
  const { services, store } = session;
  let recordingHandle: RecordingHandle | null = null;
  let mic: MicInput | null = null;

  function releaseMic(): void {
    mic?.close();
    mic = null;
  }

  /** Listens to the audio, puts what it heard on the grid and keeps it as the take (or says it heard nothing). */
  function keepAsTake(
    audio: { samples: Float32Array; sampleRate: number; startSec: number },
    bpm: number,
    bars: number,
    alreadyDetected?: ReturnType<typeof analyzeVoice>,
  ): void {
    const { samples, sampleRate, startSec } = audio;
    const role = store.getState().role;
    const detected = alreadyDetected ?? analyzeVoice(samples, sampleRate, { mode: analysisMode(role) });
    const events = quantizeToGrid(detected, { bpm, startSec, bars }, { resolution: GRID_RESOLUTION_STEPS });
    if (events.length === 0) {
      session.say('assistant', "I didn't catch any sounds in that take. Try again a bit louder or closer to the mic.", {
        error: true,
      });
      return;
    }
    store.setState({
      take: {
        events,
        summary: describeEvents(events),
        role,
        bars,
        bpm,
        audio: { samples, sampleRate, startSec },
        sent: false,
      },
    });
  }

  /** Opens the mic and starts the engine's recording; null (after telling the musician) when that fails. */
  async function startRecording(): Promise<RecordingHandle | null> {
    const state = store.getState();
    const project = services.doc.getState().project;
    try {
      mic = await openMic({ ...services.audioInput.micOptions(), echoCancellation: state.playAlong });
      // Performing over the beat means the current pattern, not the song.
      if (state.playAlong) services.view.getState().setMode('pattern');
      const { timeSig } = project.transport;
      recordingHandle = await services.engine.record(mic.stream, {
        bpm: project.transport.bpm,
        beatsPerBar: timeSig.num,
        countInBeats: timeSig.num,
        bars: state.bars,
        click: state.click,
        ...services.audioInput.performanceLatency(mic.latency),
        playAlong: state.playAlong,
      });
      return recordingHandle;
    } catch (error) {
      releaseMic();
      session.say('assistant', errorText(error), { error: true });
      return null;
    }
  }

  async function record(): Promise<void> {
    const state = store.getState();
    if (state.phase !== 'idle') return;
    const project = services.doc.getState().project;
    const handle = await startRecording();
    if (!handle) return;
    store.setState({ phase: 'counting-in', recording: { bars: state.bars, startedAt: performance.now() } });
    const countInWatch = setInterval(() => {
      if (recordingHandle !== handle) return clearInterval(countInWatch);
      if (handle.position() >= 0 && store.getState().phase === 'counting-in') store.setState({ phase: 'recording' });
    }, COUNT_IN_POLL_MS);
    try {
      const recorded = await handle.done;
      store.setState({ phase: 'analyzing', recording: null });
      // Let the UI paint "analyzing" before the (synchronous) analysis runs.
      await new Promise((resolve) => setTimeout(resolve, PAINT_BEFORE_ANALYSIS_MS));
      const audio = { samples: recorded.samples, sampleRate: recorded.sampleRate, startSec: recorded.barOneSec };
      keepAsTake(audio, project.transport.bpm, state.bars);
    } catch (error) {
      if (!isAbortError(error)) session.say('assistant', `Recording failed: ${errorText(error)}`, { error: true });
    } finally {
      clearInterval(countInWatch);
      recordingHandle = null;
      releaseMic();
      store.setState({ phase: 'idle', recording: null });
    }
  }

  async function importFile(file: Pick<File, 'name' | 'arrayBuffer'>): Promise<void> {
    if (store.getState().phase !== 'idle') return;
    store.setState({ phase: 'analyzing' });
    try {
      const decoder = new OfflineAudioContext(1, 1, IMPORT_DECODE_RATE_HZ);
      const buffer = await decoder.decodeAudioData(await file.arrayBuffer());
      const samples = buffer.getChannelData(0).slice();
      const project = services.doc.getState().project;
      const detected = analyzeVoice(samples, buffer.sampleRate, { mode: analysisMode(store.getState().role) });
      if (detected.length === 0) throw new Error("I couldn't hear any sounds in that file.");
      const bpm = estimateBpm(detected) ?? project.transport.bpm;
      const startSec = Math.max(0, (detected[0]?.time ?? 0) - IMPORT_LEAD_IN_SEC);
      const beats = ((buffer.duration - startSec) * bpm) / 60;
      const bars = Math.max(1, Math.min(MAX_IMPORTED_BARS, Math.ceil(beats / IMPORT_BEATS_PER_BAR)));
      keepAsTake({ samples, sampleRate: buffer.sampleRate, startSec }, bpm, bars, detected);
    } catch (error) {
      session.say('assistant', errorText(error), { error: true });
    } finally {
      store.setState({ phase: 'idle' });
    }
  }

  function playTake(): void {
    const take = store.getState().take;
    if (!take?.audio) return;
    const { samples, sampleRate, startSec } = take.audio;
    const firstFrame = Math.max(0, Math.floor((startSec - PLAYBACK_LEAD_IN_SEC) * sampleRate));
    const wav = encodeWav([samples.subarray(firstFrame)], sampleRate, { bitDepth: 32 });
    void services.engine.previewAudio(wav.slice().buffer);
  }

  return {
    record,
    level: () => recordingHandle?.level() ?? 0,
    position: () => (recordingHandle ? recordingHandle.position() : null),
    stop: () => recordingHandle?.stop(),
    cancel: () => recordingHandle?.cancel(),
    importFile,
    playTake,
  };
}
