/**
 * The small "keep A in step with B" connections `createServices` makes while it builds the app: prefs to keymap, engine and
 * sample cache; the document and the view to the engine; the selections to what still exists. Each function subscribes
 * once and, where the first value matters, applies it right away. Their order in `createServices` is part of how the app
 * starts (a subscription made earlier hears a change first), so keep it when adding one.
 */
import type { Keymap } from '@core/commands/keymap';
import type { History } from '@core/history/history';
import type { PluginOwner } from '@core/model/types';
import { setPluginState } from '@core/ops/channels';
import { heardProject } from '@core/query/hear';
import { isTakeClip } from '@core/query/takes';
import type { JsonValue } from '@agstudio/sdk';
import type { EngineApi, EngineOptions } from '@engine/api';
import { SampleCache } from '@engine/samples';
import { createOpfsDerivedStore } from '@platform/derived-store';
import { isOpfsAvailable } from '@platform/opfs';
import { opfsSampleProvider } from './persistence/project-io';
import type { PluginRegistry } from './plugins/registry';
import type { RecordController } from './recording';
import type { Services } from './services';
import { effectiveBuffer, type PrefsState, type PrefsStore } from './stores/prefs';
import type { SessionStore } from './stores/session';
import type { TapRegistry } from './taps';

/** The smallest and largest memory budget for decoded samples, in MB (the prefs value is clamped into this). */
const MIN_SAMPLE_MEMORY_MB = 256;
const MAX_SAMPLE_MEMORY_MB = 16384;
/** The budget when the pref is not a number, in MB. */
const DEFAULT_SAMPLE_MEMORY_MB = 1536;
const BYTES_PER_MB = 1024 * 1024;

/** Your own shortcuts (Help → Keyboard shortcuts) are kept in prefs; the keymap follows them. */
export function followCustomKeys(prefs: PrefsStore, keymap: Keymap): void {
  let appliedKeys: PrefsState['customKeys'] | null = null;
  const apply = () => {
    const keys = prefs.getState().customKeys;
    if (keys === appliedKeys) return;
    appliedKeys = keys;
    keymap.setUserBindings(keys);
  };
  prefs.subscribe(apply);
  apply();
}

/**
 * The decoded-sample cache the engine, exports and every offline render share. Embedded samples come from the app's
 * sample store (OPFS, or memory when that is unavailable). AIFF isn't transcoded here (that would run on the main
 * thread): the engine's decoder parses it in a Worker. Time-stretched clip copies are kept in OPFS, so each is made once
 * per file and tempo. Its memory budget follows `prefs.sampleMemoryMb`.
 */
export function createSampleCache(prefs: PrefsStore): SampleCache {
  const cache = new SampleCache(opfsSampleProvider({ transcode: false }), {
    ...(isOpfsAvailable() ? { store: createOpfsDerivedStore() } : {}),
  });
  const applyBudget = () => {
    const megabytes = prefs.getState().sampleMemoryMb;
    const clamped = Math.min(MAX_SAMPLE_MEMORY_MB, Math.max(MIN_SAMPLE_MEMORY_MB, Number.isFinite(megabytes) ? megabytes : DEFAULT_SAMPLE_MEMORY_MB));
    cache.budgetBytes = clamped * BYTES_PER_MB;
  };
  prefs.subscribe(applyBudget);
  applyBudget();
  return cache;
}

/** What the engine needs from the app: the plugins, the sample cache, where plugin state goes and what to do when a plugin fails. */
export function createEngineOptions(parts: {
  plugins: PluginRegistry;
  sampleCache: SampleCache;
  history: History;
  session: SessionStore;
  taps: TapRegistry;
}): EngineOptions {
  const { plugins, sampleCache, history, session, taps } = parts;
  return {
    plugins,
    sampleCache,
    onPluginStateRequest: (owner: PluginOwner, state: JsonValue) => history.transact('Plugin state', (d) => setPluginState(d, owner, state)),
    onPluginFault: (_owner, pluginId, error) => {
      const message = error === 'missing' ? `Plugin "${pluginId}" is not installed` : `Plugin "${pluginId}" failed`;
      console.error(message, error);
      session.getState().toast(message, 'error');
    },
    onPluginTap: (owner, tap, live) => taps.report(owner, tap, live),
    // A diagnostic switch: `?nopark` keeps every idle plugin in the audio graph, for measuring and for finding out whether parking matters.
    idleParking: !new URLSearchParams(globalThis.location?.search ?? '').has('nopark'),
  };
}

/** The chosen output device (the engine host remembers it across reboots); a toast when it is not available. */
export function followOutputDevice(prefs: PrefsStore, session: SessionStore, engine: EngineApi): void {
  let appliedDeviceId = '';
  const apply = () => {
    const deviceId = prefs.getState().outputDevice;
    if (deviceId === appliedDeviceId) return;
    appliedDeviceId = deviceId;
    void engine.setOutputDevice(deviceId).then((isAvailable) => {
      const isStillChosen = prefs.getState().outputDevice === deviceId;
      if (isAvailable || !deviceId || !isStillChosen) return;
      session.getState().toast('Your chosen sound output isn’t available, so the system default plays (Options → Settings…).', 'error');
    });
  };
  prefs.subscribe(apply);
  apply();
}

/**
 * A new buffer size needs a new AudioContext: reboot the engine (playback carries on from where it was). The size is
 * the chosen one, or what Auto has settled on (it moves up when playback can't keep up).
 */
export function rebootEngineOnBufferChange(prefs: PrefsStore, engine: { reboot(): Promise<void> }): void {
  let appliedBuffer = effectiveBuffer(prefs.getState());
  prefs.subscribe((p) => {
    const size = effectiveBuffer(p);
    if (size === appliedBuffer) return;
    appliedBuffer = size;
    void engine.reboot();
  });
}

/** The engine plays the metronome and count-in from the prefs (count-in only while record is armed). */
export function followMetronomeSettings(prefs: PrefsStore, engine: EngineApi, recording: RecordController): void {
  const sync = () => {
    const p = prefs.getState();
    engine.setSession({ metronome: p.metronome, countInBars: recording.armed ? p.countInBars : 0 });
  };
  prefs.subscribe(sync);
  recording.store.subscribe(sync);
  sync();
}

/**
 * Arming record mode with audio on: song mode (audio goes into the playlist), playback that runs on
 * past the song's end (no wrapping while you record), and the input opened ahead of the take.
 */
export function connectAudioRecording(s: Services): void {
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

/** Keeps the engine in sync with the document and the transport view, and the selections pointing at things that exist. */
export function connectEngine(s: Services): void {
  followDocumentAsHeard(s);
  followTransportView(s);
  keepSelectionsValid(s);
}

/**
 * The engine plays a copy of the project (`heardProject`): listening differently without touching the document, such as
 * one take on its own (comping) or a clip's original recording instead of its pitch-corrected render (the Pitch editor's
 * A/B). Both are session state in the editor store, and every change of the document passes through the same filter.
 */
function followDocumentAsHeard(s: Services): void {
  const { engine, history, doc } = s;
  const listening = () => {
    const e = s.editor.getState();
    return { audition: e.auditionTake, original: e.pitchOriginal, uncleaned: e.cleanupOriginal, unaligned: e.alignOriginal };
  };
  const isListeningDifferently = () => {
    const l = listening();
    return l.audition !== null || l.original.length > 0 || l.uncleaned.length > 0 || l.unaligned.length > 0;
  };
  const project = doc.getState().project;
  engine.applyDocChange({ next: heardProject(project, listening()), prev: project, patches: null, origin: 'load' });
  history.onChange((change) => engine.applyDocChange(isListeningDifferently() ? { ...change, next: heardProject(change.next, listening()) } : change));
  s.editor.subscribe((next, prev) => {
    if (
      next.auditionTake === prev.auditionTake &&
      next.pitchOriginal === prev.pitchOriginal &&
      next.cleanupOriginal === prev.cleanupOriginal &&
      next.alignOriginal === prev.alignOriginal
    )
      return;
    const now = doc.getState().project;
    engine.applyDocChange({ next: heardProject(now, listening()), prev: now, patches: null, origin: 'edit' });
  });
  // The listened-to take or clip is gone (deleted, undone away, another project): back to the normal sound.
  history.onChange(({ next }) => {
    const e = s.editor.getState();
    if (e.auditionTake && !isTakeClip(next, e.auditionTake)) e.setAuditionTake(null);
    for (const id of e.pitchOriginal) if (next.playlist.clips[id]?.kind !== 'audio') e.setPitchOriginal(id, false);
    for (const id of e.cleanupOriginal) if (next.playlist.clips[id]?.kind !== 'audio') e.setCleanupOriginal(id, false);
    for (const id of e.alignOriginal) if (next.playlist.clips[id]?.kind !== 'audio') e.setAlignOriginal(id, false);
  });
}

/** The engine plays the pattern or the song and loops where the view says. */
function followTransportView(s: Services): void {
  const { engine, view } = s;
  const pushView = () => {
    const v = view.getState();
    engine.setTransportView({ mode: v.mode, patternId: v.currentPatternId, loop: v.loop });
  };
  pushView();
  view.subscribe((next, prev) => {
    if (next.mode !== prev.mode || next.currentPatternId !== prev.currentPatternId || next.loop !== prev.loop) pushView();
  });
}

/** Selected notes, clips, the current pattern, channel and insert fall back when what they point at is gone. */
function keepSelectionsValid(s: Services): void {
  const { history, view } = s;
  // A note selection belongs to one channel in one pattern.
  s.session.subscribe((next, prev) => {
    if (next.selectedChannelId !== prev.selectedChannelId) s.editor.getState().selectNotes([]);
  });
  // Drop selected clips that no longer exist (undo, delete).
  history.onChange(({ next }) => {
    const sel = s.editor.getState().clipSelection;
    if (sel.some((id) => !next.playlist.clips[id])) s.editor.getState().selectClips(sel.filter((id) => next.playlist.clips[id]));
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

  // When the selected insert is deleted (or undone away), select the master again (null = master, see SessionState.selectedInsertId).
  history.onChange(({ next }) => {
    const insertId = s.session.getState().selectedInsertId;
    if (insertId && !next.mixer.inserts[insertId]) s.session.getState().selectInsert(null);
    const marked = s.session.getState().markedInsertIds;
    if (marked.some((id) => !next.mixer.inserts[id])) s.session.getState().markInserts(marked.filter((id) => next.mixer.inserts[id]));
    // A/B compare forgets a snapshot that was deleted (or undone away).
    const { a, b, side } = s.session.getState().snapshotCompare;
    const exists = (id: typeof a) => !!id && !!next.mixSnapshots?.some((snapshot) => snapshot.id === id);
    if ((a && !exists(a)) || (b && !exists(b))) {
      s.session.getState().setSnapshotCompare({ a: exists(a) ? a : null, b: exists(b) ? b : null, side: exists(a) && exists(b) ? side : null });
    }
  });
}
