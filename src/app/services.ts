import { CommandRegistry } from '@core/commands/registry';
import { Keymap, type Platform } from '@core/commands/keymap';
import type { History } from '@core/history/history';
import type { PluginOwner, Project } from '@core/model/types';
import { setPluginState } from '@core/ops/channels';
import type { JsonValue } from '@agstudio/sdk';
import type { EngineApi, EngineOptions } from '@engine/api';
import { Engine } from '@engine/engine';
import { createDefaultProject } from './default-project';
import { EngineHost } from './engine-host';
import { registerBuiltinPlugins } from './plugins/discover';
import { PluginRegistry } from './plugins/registry';
import { RecordController } from './recording';
import { AudioInputService } from './audio-input';
import { AudioRecorder } from './audio-recorder';
import { AutomationService } from './automation';
import { createDoc, type DocStore } from './stores/doc';
import { createSessionStore, type SessionStore } from './stores/session';
import { createViewStore, type ViewStore } from './stores/view';
import { createPrefsStore, type PrefsState, type PrefsStore } from './stores/prefs';
import { createEditorStore, type EditorStore, type PianoRollViewState, type PlaylistViewState } from './stores/editor';
import { ControllerRouter } from './controllers';
import { LiveInput } from './live-input';
import { ScoreLog } from './score-log';
import { NoteRecorder } from './note-recorder';
import { MidiInput } from './midi-input';
import { ProjectFiles } from './project-files';
import { BeatAssistant } from './assistant/assistant';
import { opfsSampleProvider } from './persistence/project-io';
import { idbPresetStorage, PresetLibrary, type PresetStorage } from './presets';
import { TapRegistry } from './taps';
import { createTrackAnalyzer, type AnalysisStorage, type TrackAnalyzer } from './dj/analysis-cache';

/**
 * The composition root. Built once at startup, outside React (StrictMode runs effects twice, so
 * long-lived objects like stores, the engine and the AudioContext must never be created in effects).
 * Features receive this object in their register() function and in commands.
 */
export interface Services {
  readonly platform: Platform;
  readonly commands: CommandRegistry<Services>;
  readonly keymap: Keymap;
  /** The project document (read with useDoc; write only through `history`). */
  readonly doc: DocStore;
  readonly history: History;
  readonly view: ViewStore;
  readonly session: SessionStore;
  readonly prefs: PrefsStore;
  /** Piano roll / playlist tools, snap, zoom, selection and clipboard. */
  readonly editor: EditorStore;
  readonly midi: MidiInput;
  /** Live notes and controllers from every input (MIDI, typing keyboard, on-screen piano). */
  readonly live: LiveInput;
  /** The last five minutes of live notes, recording or not (FL's score log). */
  readonly scoreLog: ScoreLog;
  /** MIDI controller links ("Link to controller"). */
  readonly controllers: ControllerRouter;
  readonly plugins: PluginRegistry;
  readonly engine: EngineApi;
  /** Live audio of running plugin instances for their editors (`host.tap()`; `view(owner)`). */
  readonly taps: TapRegistry;
  /** Record mode and the recorders features register (notes, automation, audio). */
  readonly recording: RecordController;
  /** The audio input recording uses: device, mono/stereo, meter, monitoring, latency. */
  readonly audioInput: AudioInputService;
  /** Audio recording into the playlist (takes, the live clip while recording). */
  readonly audioRecorder: AudioRecorder;
  /** Automation clips: create, labels, touch while dragging, recording knob moves, control status. */
  readonly automation: AutomationService;
  /** The open project's file: new, open, save, save as, recent files. */
  readonly files: ProjectFiles;
  /** The beat assistant (describe or perform a beat; Claude or the offline generator writes it). */
  readonly assistant: BeatAssistant;
  /** Your own presets (kept in this browser) and which preset each plugin loaded last. */
  readonly presets: PresetLibrary;
  /** DJ mode: each song's tempo, beat grid, key, energy, sections and mix points (cached by content hash). */
  readonly trackAnalyzer: TrackAnalyzer;
  /** Replaces the audio engine with a fresh AudioContext (after AudioWorklet code changed). */
  rebootEngine(): Promise<void>;
  /** Fires after any store, registry or engine change; used to refresh command enabled/checked state. */
  subscribe(fn: () => void): () => void;
}

export function detectPlatform(): Platform {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
}

export interface ServiceOptions {
  platform?: Platform;
  /** Inject an engine (tests use a fake); default is a realtime Web Audio engine. */
  createEngine?: (opts: EngineOptions) => EngineApi;
  /** Opens the audio input's stream (tests pass a generated one; default: getUserMedia). */
  openAudioStream?: ConstructorParameters<typeof AudioInputService>[0]['openStream'];
  project?: Project;
  /** A registry already filled by plugin discovery (default: built-ins only). */
  plugins?: PluginRegistry;
  /** Restored piano roll settings. */
  pianoRoll?: Partial<PianoRollViewState>;
  playlist?: Partial<PlaylistViewState>;
  /** Where your presets live (default: IndexedDB). */
  presetStorage?: PresetStorage;
  /** Where track analyses are kept (default: IndexedDB). */
  analysisStorage?: AnalysisStorage;
}

export function createServices(opts: ServiceOptions = {}): Services {
  const platform = opts.platform ?? detectPlatform();
  const commands = new CommandRegistry<Services>();
  const keymap = new Keymap(platform);
  const plugins = opts.plugins ?? new PluginRegistry();
  if (!opts.plugins) registerBuiltinPlugins(plugins);
  const { store: doc, history } = createDoc(opts.project ?? createDefaultProject(plugins));
  const view = createViewStore({ currentPatternId: doc.getState().project.patternOrder[0] ?? null });
  const session = createSessionStore();
  session.getState().selectChannel(doc.getState().project.channelOrder[0] ?? null);
  const prefs = createPrefsStore();
  // Your own shortcuts (Help → Keyboard shortcuts), kept in prefs.
  let appliedKeys: PrefsState['customKeys'] | null = null;
  const applyKeys = () => {
    const keys = prefs.getState().customKeys;
    if (keys === appliedKeys) return;
    appliedKeys = keys;
    keymap.setUserBindings(keys);
  };
  prefs.subscribe(applyKeys);
  applyKeys();
  // The chosen output device (the engine host remembers it across reboots).
  let appliedOutput = '';
  const applyOutput = () => {
    const id = prefs.getState().outputDevice;
    if (id === appliedOutput) return;
    appliedOutput = id;
    void engineRef?.setOutputDevice(id).then((ok) => {
      if (!ok && id && prefs.getState().outputDevice === id)
        session
          .getState()
          .toast('Your chosen sound output isn’t available, so the system default plays (Options → Settings…).', 'error');
    });
  };
  const editor = createEditorStore(opts.pianoRoll, opts.playlist);
  let engineRef: EngineApi | null = null;
  const live = new LiveInput(
    () => engineRef as EngineApi,
    () => session.getState().selectedChannelId,
  );
  const midi = new MidiInput(live);
  const scoreLog = new ScoreLog(live);
  const taps = new TapRegistry();

  const engineOptions: EngineOptions = {
    plugins,
    // Embedded samples come from the app's sample store (OPFS, or memory when that is unavailable).
    samples: opfsSampleProvider(),
    onPluginStateRequest: (owner: PluginOwner, state: JsonValue) =>
      history.transact('Plugin state', (d) => setPluginState(d, owner, state)),
    onPluginFault: (_owner, pluginId, error) => {
      const message = error === 'missing' ? `Plugin "${pluginId}" is not installed` : `Plugin "${pluginId}" failed`;
      console.error(message, error);
      session.getState().toast(message, 'error');
    },
    onPluginTap: (owner, tap, live) => taps.report(owner, tap, live),
  };
  const makeEngine = opts.createEngine ?? ((o: EngineOptions) => Engine.realtime(o));
  const engine = new EngineHost(() => makeEngine(engineOptions));
  plugins.subscribe((ids) => engine.pluginsChanged(ids));
  engineRef = engine;
  prefs.subscribe(applyOutput);
  applyOutput();
  const recording = new RecordController(engine, (kind) =>
    kind === 'audio' ? prefs.getState().recordAudio : prefs.getState().recordNotes,
  );
  const audioInput = new AudioInputService({
    engine,
    prefs,
    doc,
    ...(opts.openAudioStream ? { openStream: opts.openAudioStream } : {}),
  });
  // The engine plays the metronome and count-in from the prefs (count-in only while record is armed).
  const syncSession = () => {
    const pr = prefs.getState();
    engine.setSession({ metronome: pr.metronome, countInBars: recording.armed ? pr.countInBars : 0 });
  };
  prefs.subscribe(syncSession);
  recording.store.subscribe(syncSession);
  syncSession();
  // Before connectEngine: a drag's first edit lets automation go of the control before the engine hears it.
  const automation = new AutomationService({ history, doc, engine, recording, view, editor, plugins, session });

  const presets = new PresetLibrary(opts.presetStorage ?? idbPresetStorage, (message) =>
    session.getState().toast(message, 'error'),
  );
  void presets.load();
  const trackAnalyzer = createTrackAnalyzer(opts.analysisStorage ? { storage: opts.analysisStorage } : {});
  let files: ProjectFiles | null = null;
  let audioRecorder: AudioRecorder | null = null;
  let controllers: ControllerRouter | null = null;
  let assistant: BeatAssistant | null = null;
  const services: Services = {
    platform,
    commands,
    keymap,
    doc,
    history,
    view,
    session,
    prefs,
    editor,
    midi,
    live,
    scoreLog,
    plugins,
    engine,
    taps,
    recording,
    audioInput,
    get audioRecorder() {
      return audioRecorder as AudioRecorder;
    },
    get controllers() {
      return (controllers ??= new ControllerRouter(services));
    },
    automation,
    get files() {
      return (files ??= new ProjectFiles(services));
    },
    get assistant() {
      return (assistant ??= new BeatAssistant(services));
    },
    presets,
    trackAnalyzer,
    rebootEngine: () => engine.reboot(),
    subscribe(fn) {
      const unsubs = [
        commands.subscribe(fn),
        keymap.subscribe(fn),
        view.subscribe(fn),
        session.subscribe(fn),
        history.onStatus(fn),
        engine.subscribe(fn),
        plugins.subscribe(fn),
        prefs.subscribe(fn),
        editor.subscribe(fn),
        midi.subscribe(fn),
        recording.store.subscribe(fn),
        audioInput.store.subscribe(fn),
        services.files.store.subscribe(fn),
        presets.subscribe(fn),
      ];
      return () => unsubs.forEach((u) => u());
    },
  };
  commands.bindContext(() => services);
  commands.onError = (id, err) => {
    console.error(`Command ${id} failed`, err);
    session.getState().toast(`${id} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  };

  connectEngine(services);
  recording.register(new NoteRecorder(services));
  audioRecorder = new AudioRecorder(services, audioInput);
  recording.register(audioRecorder);
  connectAudioRecording(services);
  void services.controllers; // listens to live controllers from the start
  return services;
}

/**
 * Arming record mode with audio on: song mode (audio goes into the playlist), playback that runs on
 * past the song's end (no wrapping while you record), and the input opened ahead of the take.
 */
function connectAudioRecording(s: Services): void {
  let wasArmed = false;
  const sync = () => {
    const armed = s.recording.armed && s.prefs.getState().recordAudio;
    s.engine.setSongOpenEnded(armed);
    if (!armed || wasArmed) {
      wasArmed = armed;
      return;
    }
    wasArmed = true;
    if (s.view.getState().mode !== 'song') {
      s.view.getState().setMode('song');
      s.session.getState().toast('Audio records into the playlist, so AGstudio switched to Song mode.');
    }
    void s.audioInput.open().then((input) => {
      if (!input) s.session.getState().toast(s.audioInput.store.getState().error ?? 'The audio input could not be opened.', 'error');
    });
  };
  s.recording.store.subscribe(sync);
  s.prefs.subscribe((next, prev) => {
    if (next.recordAudio !== prev.recordAudio) sync();
  });
}

/** Keeps the engine in sync with the document and the transport view. */
function connectEngine(s: Services): void {
  const { engine, history, view, doc } = s;
  const project = doc.getState().project;
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  history.onChange((change) => engine.applyDocChange(change));

  const pushView = () => {
    const v = view.getState();
    engine.setTransportView({ mode: v.mode, patternId: v.currentPatternId, loop: v.loop });
  };
  pushView();
  view.subscribe((next, prev) => {
    if (next.mode !== prev.mode || next.currentPatternId !== prev.currentPatternId || next.loop !== prev.loop)
      pushView();
  });

  // A note selection belongs to one channel in one pattern.
  s.session.subscribe((next, prev) => {
    if (next.selectedChannelId !== prev.selectedChannelId) s.editor.getState().selectNotes([]);
  });
  // Drop selected clips that no longer exist (undo, delete).
  history.onChange(({ next }) => {
    const sel = s.editor.getState().clipSelection;
    if (sel.some((id) => !next.playlist.clips[id]))
      s.editor.getState().selectClips(sel.filter((id) => next.playlist.clips[id]));
  });
  view.subscribe((next, prev) => {
    if (next.currentPatternId !== prev.currentPatternId) s.editor.getState().selectNotes([]);
  });

  // Keep the current pattern and selected channel valid as the document changes.
  history.onChange(({ next }) => {
    const v = view.getState();
    if (!v.currentPatternId || !next.patterns[v.currentPatternId]) v.setCurrentPattern(next.patternOrder[0] ?? null);
    const sel = s.session.getState().selectedChannelId;
    if (sel && !next.channels[sel]) s.session.getState().selectChannel(next.channelOrder[0] ?? null);
  });

  // M5 mixer: when the selected insert is deleted (or undone away), select the master again
  // (null = master, see SessionState.selectedInsertId).
  history.onChange(({ next }) => {
    const ins = s.session.getState().selectedInsertId;
    if (ins && !next.mixer.inserts[ins]) s.session.getState().selectInsert(null);
  });
}
