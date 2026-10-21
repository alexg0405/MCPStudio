import { CommandRegistry } from '@core/commands/registry';
import { Keymap, type Platform } from '@core/commands/keymap';
import type { History } from '@core/history/history';
import type { ClipId, Project } from '@core/model/types';
import type { EngineApi, EngineOptions } from '@engine/api';
import { Engine } from '@engine/engine';
import type { SampleCache } from '@engine/samples';
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
import { watchPlaybackHealth } from './playback-health';
import { AUDIO_BUFFER_HINT, createPrefsStore, effectiveBuffer, type PrefsStore } from './stores/prefs';
import { createEditorStore, type EditorStore, type PianoRollViewState, type PlaylistViewState } from './stores/editor';
import { ControllerRouter } from './controllers';
import { LiveInput } from './live-input';
import { ScoreLog } from './score-log';
import { NoteRecorder } from './note-recorder';
import { MidiInput } from './midi-input';
import { watchAutoBuffer } from './audio-buffer-watch';
import { ProjectFiles } from './project-files';
import { ProjectsService, type ProjectSources } from './projects/service';
import { VersionService } from './versions/service';
import type { VersionBackend } from './versions/backend';
import { AssistantFacade } from './assistant/facade';
import { McpLink } from './mcp/bridge';
import { Pwa } from './pwa/pwa';
import { idbPresetStorage, PresetLibrary, type PresetStorage } from './presets';
import { PluginMeta, type PluginMetaStorage } from './plugins/meta';
import type { PluginServer } from './plugins/server';
import { UserPlugins } from './plugins/user-plugins';
import { SampleBrowser, type SampleBrowserOptions } from './samples/browser';
import { TapRegistry } from './taps';
import { MeterService } from './metering/service';
import { createTrackAnalyzer, type AnalysisStorage, type TrackAnalyzer } from './dj/analysis-cache';
import { createDecksFactory, type DecksAccess } from './dj/decks-factory';
import { LauncherSession } from './launcher/session';
import { DemoSession } from './demo-session';
import {
  connectAudioRecording,
  connectEngine,
  createEngineOptions,
  createSampleCache,
  followCustomKeys,
  followMetronomeSettings,
  followOutputDevice,
  rebootEngineOnBufferChange,
} from './service-wiring';

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
  /**
   * Decoded samples, shared by the realtime engine, exports and every other offline render (pass
   * `{ plugins, sampleCache }` as engine options), with a memory budget (prefs.sampleMemoryMb).
   */
  readonly sampleCache: SampleCache;
  /** Live audio of running plugin instances for their editors (`host.tap()`; `view(owner)`). */
  readonly taps: TapRegistry;
  /**
   * The metering suite: live loudness, true peak, stereo and spectrum of the master or an insert (leases that open a
   * meter only while something looks), the Meters window's settings and the loudness report.
   */
  readonly meters: MeterService;
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
  /**
   * Save points of the project: made on save, after minutes of editing, before big changes and when the tab closes, kept
   * in this browser and listed in the Versions window (src/app/versions). Starts making them when `start()` is called.
   */
  readonly versions: VersionService;
  /** The list of your projects (files the app remembers, autosaves, projects with versions) and what to do with each. */
  readonly projects: ProjectsService;
  /** The demo song a guided tour runs on, with the musician's own project kept safe until it ends (`app/demo-session.ts`). */
  readonly demo: DemoSession;
  /** The beat assistant (describe or perform a beat; Claude or the offline generator writes it). Its code loads on first use. */
  readonly assistant: AssistantFacade;
  /** AI apps (Claude Code, Claude Desktop…) controlling the project over MCP: the tools and the dev server's channel. */
  readonly mcp: McpLink;
  /** The installable app: installed or not, Chrome's install prompt, the service worker and its update (src/app/pwa). */
  readonly pwa: Pwa;
  /** Your own presets (kept in this browser) and which preset each plugin loaded last. */
  readonly presets: PresetLibrary;
  /**
   * Your own plugins as things to manage: the list (yours and the built-ins), share and install `.agplugin` bundles,
   * duplicate, rename, switch off, delete to the trash. Needs the dev server for anything that touches `plugins/`.
   */
  readonly userPlugins: UserPlugins;
  /** DJ mode: each song's tempo, beat grid, key, energy, sections and mix points (cached by content hash). */
  readonly trackAnalyzer: TrackAnalyzer;
  /**
   * The sample browser's model: the files of your sample folders with their analysis (category, tempo, key…), favorites,
   * tags, the filter and the audition settings. Started by its feature; not part of the project.
   */
  readonly sampleBrowser: SampleBrowser;
  /**
   * DJ live decks: created on first use (the audio graph on the first song loaded), always the same object.
   * Deck state is live performance state: not in the project, not in History.
   */
  readonly decks: DecksAccess;
  /**
   * The clip launcher while it plays (Performance mode): launching slots and scenes, stopping tracks, the performance
   * record. Live state, not the project; the grid itself is `project.launcher`.
   */
  readonly launcher: LauncherSession;
  /** Replaces the audio engine with a fresh AudioContext (after AudioWorklet code changed). */
  rebootEngine(): Promise<void>;
  /** Fires after any store, registry or engine change; used to refresh command enabled/checked state. */
  subscribe(fn: () => void): () => void;
}

/** Mac (Cmd shortcuts) or anything else (Ctrl), from what the browser says it runs on. */
export function detectPlatform(): Platform {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
}

/** What tests and the app's entry point can change about the services; the defaults are the real thing. */
export interface ServiceOptions {
  platform?: Platform;
  /**
   * Make the engine (the AudioContext and the sounds) after the first paint, or when something first needs it, instead
   * of during startup (see EngineHostOptions.deferred). The app's entry point turns it on; tests leave it off.
   */
  deferEngine?: boolean;
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
  /** Where the notes about your plugins (author, origin) live (default: IndexedDB). */
  pluginMetaStorage?: PluginMetaStorage;
  /** The dev server's plugin endpoints (default: the page's fetch to `/api/plugins`). */
  pluginServer?: PluginServer;
  /** Where track analyses are kept (default: IndexedDB). */
  analysisStorage?: AnalysisStorage;
  /** The sample browser's storage, analysis runner and folders (default: IndexedDB, Workers, your sample folders). */
  sampleBrowser?: SampleBrowserOptions;
  /**
   * Where versions and project cards are kept (default: IndexedDB and OPFS). `null` keeps none (the default in a browser
   * without them); tests pass memory stores.
   */
  versionBackend?: VersionBackend | null;
  /** Where the project list reads the remembered files and autosaves from (default: IndexedDB and OPFS). */
  projectSources?: ProjectSources;
}

/**
 * Builds the app's services in the order they depend on each other. The steps below are numbered; the order matters
 * for subscriptions (a store hears its subscribers in the order they subscribed) and for the engine, which is created
 * before anything that talks to it.
 */
export function createServices(opts: ServiceOptions = {}): Services {
  // 1. Commands, keys and the project (documents, view and session state, prefs).
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
  followCustomKeys(prefs, keymap);

  // 2. Editing state and the live note inputs. They reach the engine through `engineRef`, which is set in step 4.
  const editor = createEditorStore(opts.pianoRoll, opts.playlist);
  let engineRef: EngineApi | null = null;
  const live = new LiveInput(
    () => engineRef as EngineApi,
    () => session.getState().selectedChannelId,
  );
  const midi = new MidiInput(live);
  const scoreLog = new ScoreLog(live);
  const taps = new TapRegistry();

  // 3. The sample cache and the engine options that use it.
  const sampleCache = createSampleCache(prefs);
  const engineOptions = createEngineOptions({ plugins, sampleCache, history, session, taps });

  // 4. The engine, and everything that follows the prefs into it (output device, buffer size, health checks).
  const makeEngine =
    opts.createEngine ?? ((o: EngineOptions) => Engine.realtime(o, AUDIO_BUFFER_HINT[effectiveBuffer(prefs.getState())]));
  const engine = new EngineHost(() => makeEngine(engineOptions), { deferred: !!opts.deferEngine });
  plugins.subscribe((ids) => engine.pluginsChanged(ids));
  engineRef = engine;
  followOutputDevice(prefs, session, engine);
  rebootEngineOnBufferChange(prefs, engine);
  watchPlaybackHealth(engine, prefs, session);
  watchAutoBuffer(engine, prefs, session, () => midi.enabled);

  // 5. Recording, the audio input, and the services built on the engine.
  const recording = new RecordController(engine, (kind) =>
    kind === 'audio' ? prefs.getState().recordAudio : prefs.getState().recordNotes,
  );
  const audioInput = new AudioInputService({
    engine,
    prefs,
    doc,
    ...(opts.openAudioStream ? { openStream: opts.openAudioStream } : {}),
  });
  followMetronomeSettings(prefs, engine, recording);
  // Before connectEngine: a drag's first edit lets automation go of the control before the engine hears it.
  const automation = new AutomationService({ history, doc, engine, recording, view, editor, plugins, session });

  const presets = new PresetLibrary(opts.presetStorage ?? idbPresetStorage, (message) =>
    session.getState().toast(message, 'error'),
  );
  void presets.load();
  const trackAnalyzer = createTrackAnalyzer(opts.analysisStorage ? { storage: opts.analysisStorage } : {});
  const sampleBrowser = new SampleBrowser(opts.sampleBrowser);
  const launcher = new LauncherSession({
    engine,
    doc,
    history,
    toast: (message, kind) => session.getState().toast(message, kind),
    onRecorded: (clips) => editor.getState().selectClips(clips as ClipId[]),
  });

  // 6. The services object. The ones that need the whole object (or are rarely used) are made on first use.
  let files: ProjectFiles | null = null;
  let audioRecorder: AudioRecorder | null = null;
  let controllers: ControllerRouter | null = null;
  let assistant: AssistantFacade | null = null;
  let mcp: McpLink | null = null;
  let pwa: Pwa | null = null;
  let meters: MeterService | null = null;
  let versions: VersionService | null = null;
  let projects: ProjectsService | null = null;
  let demo: DemoSession | null = null;
  let userPlugins: UserPlugins | null = null;
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
    sampleCache,
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
      return (assistant ??= new AssistantFacade(services));
    },
    get mcp() {
      return (mcp ??= new McpLink(services));
    },
    get pwa() {
      return (pwa ??= new Pwa());
    },
    get meters() {
      return (meters ??= new MeterService(services));
    },
    get versions() {
      return (versions ??= new VersionService(services, opts.versionBackend));
    },
    get projects() {
      return (projects ??= new ProjectsService(services, opts.projectSources));
    },
    get demo() {
      return (demo ??= new DemoSession(services));
    },
    presets,
    get userPlugins() {
      return (userPlugins ??= new UserPlugins({
        plugins,
        doc,
        history,
        presets,
        session,
        meta: new PluginMeta(opts.pluginMetaStorage),
        ...(opts.pluginServer ? { server: opts.pluginServer } : {}),
      }));
    },
    trackAnalyzer,
    sampleBrowser,
    decks: createDecksFactory(() => services),
    launcher,
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
        launcher.store.subscribe(fn),
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

  // 7. Connections that need the finished services object.
  connectEngine(services);
  recording.register(new NoteRecorder(services));
  audioRecorder = new AudioRecorder(services, audioInput);
  recording.register(audioRecorder);
  connectAudioRecording(services);
  void services.controllers; // listens to live controllers from the start
  return services;
}
