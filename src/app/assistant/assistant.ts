import { createStore, type StoreApi } from 'zustand/vanilla';
import { generateLocalBeat, type PerformanceRole } from '@core/beat/local';
import type { BeatSpec } from '@core/beat/spec';
import { encodeWav } from '@core/io/wav';
import {
  VOICE_SUMMARY_LEGEND,
  analyzeVoice,
  describeEvents,
  estimateBpm,
  quantizeToGrid,
  type GridEvent,
} from '@core/voice';
import type { RecordingHandle } from '@engine/api';
import { openMic, type MicInput } from '@platform/mic';
import type { Services } from '../services';
import { applyAnswer, type AfterEdit } from '../ai/apply';
import { pluginCatalog } from '../ai/catalog';
import { commandCatalog } from '../ai/commands';
import {
  discardDraft,
  installDraft,
  MAX_FIX_ROUNDS,
  PluginBuilder,
  type BuildStage,
  type PluginDraft,
  type PluginSpec,
  type SmokeReport,
} from '../ai/builder';
import { smokeTest } from '../ai/smoke';
import { projectContext } from '../ai/context';
import { STUDIO_PROMPT } from '../ai/prompt';
import { ACTIONS_SCHEMA, readAnswer, type AiAnswer } from '../ai/schema';
import { applyBeatSpec, type AppliedBeat } from './apply';
import { importMySounds } from './my-sounds';
import {
  AiError,
  ClaudeChat,
  DEFAULT_MODEL,
  fetchAiStatus,
  performanceBlock,
  type AiBackend,
  type AiStatus,
} from './claude';

/**
 * The beat assistant: you describe a beat (and optionally perform part of it with your voice); it
 * writes the beat into the project with Claude, or with the offline generator when no Claude key is
 * set up. Follow-ups change the same pattern. Lives for the whole session (created in services).
 */

export type AssistantPhase = 'idle' | 'counting-in' | 'recording' | 'analyzing' | 'thinking';

export interface AssistantMessage {
  id: number;
  from: 'you' | 'assistant';
  text: string;
  /** Small print under the text (what was recorded, which tracks were written). */
  detail?: string;
  error?: boolean;
  /** Made without Claude (offline generator). */
  offline?: boolean;
  /** Undo point for this beat (history cursor right after applying it). */
  beat?: { title: string; cursor: number };
  /** What an AI turn changed, one line each. */
  changes?: string[];
  /** What it couldn't do. */
  warnings?: string[];
  /** Undo point of an AI turn that edited the project (history cursor right after it). */
  undo?: number;
  /** A plugin the builder wrote: install or discard it from the message. */
  plugin?: PluginMessage;
}

export interface PluginMessage {
  draft: PluginDraft;
  /** draft: checked and ready to install; failed: still has problems (view only). */
  state: 'draft' | 'failed' | 'installing' | 'installed' | 'discarded';
}

/** A performance on the grid, ready to go with the next request. */
export interface Take {
  events: GridEvent[];
  summary: string;
  role: PerformanceRole;
  bars: number;
  bpm: number;
  /** The recording itself, for playing it back (null after a page reload: only the events are kept). */
  audio: { samples: Float32Array; sampleRate: number; startSec: number } | null;
  /** Claude has it already (sent with an earlier request). */
  sent: boolean;
}

export interface AssistantState {
  phase: AssistantPhase;
  messages: AssistantMessage[];
  take: Take | null;
  /** Live recording: count-in/progress for the UI. */
  recording: { bars: number; startedAt: number } | null;
  /** Which ways to reach Claude work (null until checked). */
  status: AiStatus | null;
  /** How to reach Claude: auto = the subscription, else an API key, else the offline generator. */
  backend: 'auto' | AiBackend | 'offline';
  model: string;
  /** What the next recording is: drums, an 808 line, a melody (or let the analysis decide). */
  role: PerformanceRole;
  bars: number;
  playAlong: boolean;
  click: boolean;
  /** Start playing a new beat as soon as it's written. */
  autoplay: boolean;
  /** Build the drums from the take's own beatboxed hits instead of the kit. */
  mySounds: boolean;
  /** The pattern the assistant is working on (follow-ups change it). */
  applied: AppliedBeat | null;
  /** Windows the last answer asked to show, and file commands waiting for a click (the UI handles and clears them). */
  uiRequests: AfterEdit[];
  /** The plugin builder at work (one plugin at a time). */
  building: { name: string; kind: 'instrument' | 'effect'; stage: BuildStage; round: number } | null;
}

let messageSeq = 0;
const PREFS_KEY = 'agstudio:assistant:v1';
const TAB_KEY = 'agstudio:assistant:tab:v1';

function loadPrefs(): Partial<AssistantState> {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<AssistantState>) : {};
  } catch {
    return {};
  }
}

export class BeatAssistant {
  readonly store: StoreApi<AssistantState>;
  private readonly chat: ClaudeChat;
  /** Catalog key Claude has in this conversation (sent again when the plugins change). */
  private catalogSent: string | null = null;
  /** What the last turn couldn't do, told to Claude with the next request. */
  private lastProblems: string[] = [];
  private readonly fetchImpl: typeof fetch;
  private handle: RecordingHandle | null = null;
  private mic: MicInput | null = null;
  private abort: AbortController | null = null;
  private readonly smoke: (folder: string) => Promise<SmokeReport>;
  private buildAbort: AbortController | null = null;
  /** Everything asked so far in offline mode (the generator is stateless). */
  private offlinePrompt = '';

  constructor(
    private readonly s: Services,
    deps: { fetch?: typeof fetch; smoke?: (folder: string) => Promise<SmokeReport> } = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
    this.smoke = deps.smoke ?? smokeTest;
    this.chat = new ClaudeChat(this.fetchImpl);
    const saved = loadPrefs();
    this.store = createStore<AssistantState>()(() => ({
      phase: 'idle',
      messages: [],
      take: null,
      recording: null,
      status: null,
      backend:
        saved.backend === 'subscription' || saved.backend === 'api' || saved.backend === 'offline'
          ? saved.backend
          : 'auto',
      model: typeof saved.model === 'string' ? saved.model : DEFAULT_MODEL,
      role: saved.role ?? 'auto',
      bars: saved.bars ?? 2,
      playAlong: saved.playAlong ?? false,
      click: saved.click ?? true,
      autoplay: saved.autoplay ?? true,
      mySounds: saved.mySounds ?? false,
      applied: null,
      uiRequests: [],
      building: null,
    }));
    this.restoreTab();
    this.store.subscribe(() => this.scheduleTabSave());
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.saveTab());
    this.store.subscribe((next, prev) => {
      if (
        next.backend === prev.backend &&
        next.model === prev.model &&
        next.role === prev.role &&
        next.bars === prev.bars &&
        next.playAlong === prev.playAlong &&
        next.click === prev.click &&
        next.autoplay === prev.autoplay &&
        next.mySounds === prev.mySounds
      )
        return;
      try {
        const { backend, model, role, bars, playAlong, click, autoplay, mySounds } = next;
        globalThis.localStorage?.setItem(
          PREFS_KEY,
          JSON.stringify({ backend, model, role, bars, playAlong, click, autoplay, mySounds }),
        );
      } catch {
        /* per-browser convenience only */
      }
    });
  }

  set(patch: Partial<AssistantState>): void {
    this.store.setState(patch);
  }

  // ---------------------------------------------------------------- reload survival

  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  private scheduleTabSave(): void {
    if (this.saveTimer === undefined) this.saveTimer = setTimeout(() => this.saveTab(), 500);
  }

  /** This tab's conversation, current beat and take (without the audio) for a page reload. */
  private saveTab(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const { messages, applied, take } = this.store.getState();
    try {
      globalThis.sessionStorage?.setItem(
        TAB_KEY,
        JSON.stringify({
          messages: messages.slice(-40),
          applied,
          take: take ? { ...take, audio: null } : null,
          chat: this.chat.sessionId,
          catalog: this.catalogSent,
          offlinePrompt: this.offlinePrompt,
        }),
      );
    } catch {
      /* storage full or unavailable: the conversation just won't survive a reload */
    }
  }

  private restoreTab(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(globalThis.sessionStorage?.getItem(TAB_KEY) ?? 'null');
    } catch {
      return;
    }
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as Partial<{
      messages: AssistantMessage[];
      applied: AppliedBeat;
      take: Take;
      chat: string;
      catalog: string;
      offlinePrompt: string;
    }>;
    const messages = Array.isArray(r.messages) ? r.messages.filter((m) => typeof m?.text === 'string') : [];
    messageSeq = Math.max(messageSeq, ...messages.map((m) => (typeof m.id === 'number' ? m.id : 0)));
    const applied = r.applied && typeof r.applied.patternId === 'string' && r.applied.channels ? r.applied : null;
    const take = r.take && Array.isArray(r.take.events) ? { ...r.take, audio: null } : null;
    this.store.setState({ messages, applied, take });
    if (typeof r.chat === 'string') this.chat.sessionId = r.chat;
    if (typeof r.catalog === 'string') this.catalogSent = r.catalog;
    if (typeof r.offlinePrompt === 'string') this.offlinePrompt = r.offlinePrompt;
  }

  async checkAi(): Promise<AiStatus> {
    const status = await fetchAiStatus(this.fetchImpl);
    this.store.setState({ status });
    return status;
  }

  /** The way this request will reach Claude, or null for the offline generator. */
  async route(): Promise<AiBackend | null> {
    const { backend } = this.store.getState();
    if (backend === 'offline') return null;
    const status = this.store.getState().status ?? (await this.checkAi());
    if (backend !== 'auto') return backend;
    if (status.subscription.ok) return 'subscription';
    if (status.api.ok) return 'api';
    return null;
  }

  private say(from: AssistantMessage['from'], text: string, extra: Partial<AssistantMessage> = {}): void {
    this.store.setState((st) => ({ messages: [...st.messages, { id: ++messageSeq, from, text, ...extra }] }));
  }

  // ---------------------------------------------------------------- recording

  /** Records `bars` bars after a one-bar count-in (needs a user gesture for the mic prompt). */
  async record(): Promise<void> {
    const st = this.store.getState();
    if (st.phase !== 'idle') return;
    const project = this.s.doc.getState().project;
    try {
      this.mic = await openMic({ echoCancellation: st.playAlong });
      // Performing over the beat means the current pattern, not the song.
      if (st.playAlong) this.s.view.getState().setMode('pattern');
      const ts = project.transport.timeSig;
      this.handle = await this.s.engine.record(this.mic.stream, {
        bpm: project.transport.bpm,
        beatsPerBar: ts.num,
        countInBeats: ts.num,
        bars: st.bars,
        click: st.click,
        inputLatency: this.mic.latency,
        playAlong: st.playAlong,
      });
    } catch (e) {
      this.releaseMic();
      this.say('assistant', e instanceof Error ? e.message : String(e), { error: true });
      return;
    }
    const handle = this.handle;
    this.store.setState({ phase: 'counting-in', recording: { bars: st.bars, startedAt: performance.now() } });
    const tick = setInterval(() => {
      if (this.handle !== handle) return clearInterval(tick);
      if (handle.position() >= 0 && this.store.getState().phase === 'counting-in')
        this.store.setState({ phase: 'recording' });
    }, 50);
    try {
      const rec = await handle.done;
      this.store.setState({ phase: 'analyzing', recording: null });
      // Let the UI paint "analyzing" before the (synchronous) analysis runs.
      await new Promise((r) => setTimeout(r, 30));
      this.useAudio(rec.samples, rec.sampleRate, rec.barOneSec, project.transport.bpm, st.bars);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        this.say('assistant', `Recording failed: ${e instanceof Error ? e.message : e}`, { error: true });
    } finally {
      clearInterval(tick);
      this.handle = null;
      this.releaseMic();
      this.store.setState({ phase: 'idle', recording: null });
    }
  }

  /** Input level of the live recording (0..1), for meters on the frame loop. */
  recordingLevel(): number {
    return this.handle?.level() ?? 0;
  }

  /** Seconds since bar 1 of the live recording (negative while counting in), or null. */
  recordingPosition(): number | null {
    return this.handle ? this.handle.position() : null;
  }

  /** Ends the recording now (keeps what was recorded). */
  stopRecording(): void {
    this.handle?.stop();
  }

  cancelRecording(): void {
    this.handle?.cancel();
  }

  private releaseMic(): void {
    this.mic?.close();
    this.mic = null;
  }

  /** A recording made elsewhere (phone voice memo, an audio file): bar 1 is where the sound starts. */
  async importRecording(file: Pick<File, 'name' | 'arrayBuffer'>): Promise<void> {
    if (this.store.getState().phase !== 'idle') return;
    this.store.setState({ phase: 'analyzing' });
    try {
      const ctx = new OfflineAudioContext(1, 1, 48000);
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      const samples = buffer.getChannelData(0).slice();
      const project = this.s.doc.getState().project;
      const st = this.store.getState();
      const raw = analyzeVoice(samples, buffer.sampleRate, { mode: analysisMode(st.role) });
      if (raw.length === 0) throw new Error("I couldn't hear any sounds in that file.");
      const bpm = estimateBpm(raw) ?? project.transport.bpm;
      const startSec = Math.max(0, (raw[0]?.time ?? 0) - 0.01);
      const bars = Math.max(1, Math.min(4, Math.ceil(((buffer.duration - startSec) * bpm) / 60 / 4)));
      this.useAudio(samples, buffer.sampleRate, startSec, bpm, bars, raw);
    } catch (e) {
      this.say('assistant', e instanceof Error ? e.message : String(e), { error: true });
    } finally {
      this.store.setState({ phase: 'idle' });
    }
  }

  private useAudio(
    samples: Float32Array,
    sampleRate: number,
    startSec: number,
    bpm: number,
    bars: number,
    analyzed?: ReturnType<typeof analyzeVoice>,
  ): void {
    const role = this.store.getState().role;
    const raw = analyzed ?? analyzeVoice(samples, sampleRate, { mode: analysisMode(role) });
    const events = quantizeToGrid(raw, { bpm, startSec, bars }, { resolution: 0.5 });
    if (events.length === 0) {
      this.say('assistant', "I didn't catch any sounds in that take. Try again a bit louder or closer to the mic.", {
        error: true,
      });
      return;
    }
    this.store.setState({
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

  /** The take analyzed again for a specific instrument (null when that finds nothing). */
  private reanalyze(take: Take, role: PerformanceRole): Take | null {
    if (!take.audio) return null;
    const { samples, sampleRate, startSec } = take.audio;
    const raw = analyzeVoice(samples, sampleRate, { mode: analysisMode(role) });
    const events = quantizeToGrid(raw, { bpm: take.bpm, startSec, bars: take.bars }, { resolution: 0.5 });
    if (events.length === 0) return null;
    return { ...take, events, summary: describeEvents(events), role, sent: false };
  }

  clearTake(): void {
    this.store.setState({ take: null });
  }

  /** Plays the take back (as recorded) on the preview bus. */
  playTake(): void {
    const take = this.store.getState().take;
    if (!take?.audio) return;
    const { samples, sampleRate, startSec } = take.audio;
    const from = Math.max(0, Math.floor((startSec - 0.05) * sampleRate));
    const wav = encodeWav([samples.subarray(from)], sampleRate, { bitDepth: 32 });
    void this.s.engine.previewAudio(wav.slice().buffer);
  }

  // ---------------------------------------------------------------- asking

  /** Asks for a beat (or a change to the current one). */
  async send(prompt: string): Promise<void> {
    const st = this.store.getState();
    if (st.phase !== 'idle') return;
    const text = prompt.trim();
    let take = st.take;
    if (!text && !take) return;
    // "808s that go like this" after a take left on "figure it out": listen again as an 808 line.
    if (take && take.role === 'auto') {
      const role = inferRole(text);
      if (role) {
        take = this.reanalyze(take, role) ?? take;
        this.store.setState({ take });
      }
    }
    const takeNote = take
      ? `with your ${take.bars}-bar take (${take.events.length} sound${take.events.length === 1 ? '' : 's'}${
          take.role === 'auto' ? '' : `, as ${roleLabel(take.role)}`
        })`
      : undefined;
    this.say('you', text || 'Turn my take into a beat.', takeNote ? { detail: takeNote } : {});
    this.store.setState({ phase: 'thinking' });
    const project = this.s.doc.getState().project;
    let spec: BeatSpec | null = null;
    let offline = false;
    const route = await this.route();
    if (route) {
      const abort = new AbortController();
      this.abort = abort;
      try {
        const answer = await this.chat.ask<AiAnswer>({
          system: STUDIO_PROMPT,
          schema: ACTIONS_SCHEMA,
          text: this.turnText(text || 'Make a beat from my performance.', take),
          model: st.model,
          backend: route,
          signal: abort.signal,
          read: (raw) => {
            const r = readAnswer(raw);
            return 'error' in r ? { error: r.error } : { value: r.answer };
          },
        });
        if (take) this.store.setState({ take: { ...take, sent: true } });
        this.applyTurn(answer, take, text);
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          this.say('assistant', 'Stopped.', {});
          this.store.setState({ phase: 'idle' });
          return;
        }
        if (e instanceof AiError && e.kind === 'not-configured' && st.backend === 'auto') {
          // Its setup changed since the last check: write this one offline, and look again.
          void this.checkAi();
        } else {
          this.say('assistant', e instanceof Error ? e.message : String(e), { error: true });
          this.store.setState({ phase: 'idle' });
          return;
        }
      } finally {
        this.abort = null;
      }
    }
    if (!spec) {
      offline = true;
      this.offlinePrompt = `${this.offlinePrompt} ${text}`.trim();
      spec = generateLocalBeat({
        prompt: this.offlinePrompt,
        bpm: project.transport.bpm,
        ...(take ? { performance: { events: take.events, role: take.role, bars: take.bars } } : {}),
      });
      // A take from a file keeps its own tempo unless the request names one.
      if (take && spec.bpm === undefined && Math.abs(take.bpm - project.transport.bpm) > 0.5) spec.bpm = take.bpm;
    }
    const useHits = !!take?.audio && this.store.getState().mySounds && take.events.some((e) => e.kind !== 'tonal');
    const samples =
      take?.audio && useHits ? await importMySounds({ events: take.events, audio: take.audio }).catch(() => ({})) : {};
    const applied = applyBeatSpec(this.s, spec, this.store.getState().applied, { samples });
    const parts = spec.tracks.map((t) => t.name).join(', ');
    this.say('assistant', spec.message ?? `Wrote "${spec.title}".`, {
      detail: `"${spec.title}": ${parts}${spec.bpm ? ` · ${spec.bpm} BPM` : ''}`,
      offline,
      beat: { title: spec.title, cursor: this.s.history.status().cursor },
    });
    this.store.setState({ phase: 'idle', applied });
    if (this.store.getState().autoplay) {
      this.s.view.getState().setMode('pattern');
      this.s.engine.play();
    }
  }

  /** This turn's message to Claude: the request, the project, and what Claude doesn't have yet. */
  private turnText(prompt: string, take: Take | null): string {
    const parts = [`<request>\n${prompt.trim()}\n</request>`, `<project>\n${projectContext(this.s)}\n</project>`];
    const catalog = pluginCatalog(this.s.plugins);
    const commands = commandCatalog(this.s);
    const key = `${catalog.key}:${commands.key}`;
    if (!this.chat.hasHistory || this.catalogSent !== key) {
      parts.push(`<plugins>\n${catalog.text}\n</plugins>`, `<commands>\n${commands.text}\n</commands>`);
      this.catalogSent = key;
    }
    if (take && !take.sent)
      parts.push(
        performanceBlock({
          summary: `${VOICE_SUMMARY_LEGEND}\n${take.summary}`,
          role: take.role,
          bars: take.bars,
          bpm: take.bpm,
        }),
      );
    if (this.lastProblems.length)
      parts.push(
        `<last-turn-problems>\nThese actions of your last answer couldn't be applied:\n- ${this.lastProblems.join('\n- ')}\n</last-turn-problems>`,
      );
    return parts.join('\n\n');
  }

  /** Applies Claude's answer as one undo step and reports it in the chat. */
  private applyTurn(answer: AiAnswer, take: Take | null, request: string): void {
    let result: ReturnType<typeof applyAnswer>;
    try {
      result = applyAnswer(this.s, answer, {
        previousBeat: this.store.getState().applied,
        ...(request ? { label: request } : {}),
      });
    } catch (e) {
      console.error('[agstudio] applying the AI answer failed', e);
      this.say('assistant', `Something went wrong applying that: ${e instanceof Error ? e.message : e}`, {
        error: true,
      });
      this.store.setState({ phase: 'idle' });
      return;
    }
    this.lastProblems = result.warnings;
    const cursor = this.s.history.status().cursor;
    // App commands: most run now; file dialogs wait for the musician's click (the UI asks).
    const changes = [...result.changes];
    for (const a of result.after) {
      if (a.kind !== 'command') continue;
      const title = this.s.commands.get(a.id)?.title.replace(/…$/, '') ?? a.id;
      if (a.gesture) changes.push(`${title}: waiting for your click`);
      else if (this.s.commands.run(a.id, a.args)) changes.push(`Ran “${title}”`);
      else result.warnings.push(`command: “${title}” isn't available right now`);
    }
    this.say('assistant', answer.message || (changes.length ? 'Done.' : 'Nothing to change.'), {
      ...(changes.length ? { changes } : {}),
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      ...(result.edited ? { undo: cursor } : {}),
      ...(result.beat
        ? { beat: { title: this.s.doc.getState().project.patterns[result.beat.patternId]?.name ?? 'Beat', cursor } }
        : {}),
    });
    this.store.setState({
      phase: 'idle',
      ...(result.beat ? { applied: result.beat } : {}),
      uiRequests: result.after.filter((a) => a.kind === 'open' || (a.kind === 'command' && a.gesture)),
    });
    void take;
    // Playback the answer asked for (or a new beat with autoplay on).
    for (const a of result.after) {
      if (a.kind === 'mode') this.s.view.getState().setMode(a.mode);
      else if (a.kind === 'stop') this.s.engine.stop();
      else if (a.kind === 'metronome') this.s.prefs.getState().set({ metronome: a.on });
      else if (a.kind === 'play') {
        if (a.mode) this.s.view.getState().setMode(a.mode);
        if (a.record) this.s.recording.setArmed(true);
        this.s.engine.play(a.fromTick ?? 0);
      }
    }
    for (const a of result.after) if (a.kind === 'build_plugin') void this.buildPlugin(a.spec);
    const played = result.after.some((a) => a.kind === 'play' || a.kind === 'stop');
    if (result.beat && !played && this.store.getState().autoplay) {
      this.s.view.getState().setMode('pattern');
      this.s.engine.play();
    }
  }

  // ---------------------------------------------------------------- plugin builder

  /**
   * Has the plugin builder write a new plugin (asked for by an answer's build_plugin action). Its
   * result arrives as a message with Install and Discard.
   */
  async buildPlugin(spec: PluginSpec): Promise<void> {
    const busy = this.store.getState().building;
    if (busy) {
      this.say('assistant', `I'm still building “${busy.name}”; one plugin at a time.`, { error: true });
      return;
    }
    const route = await this.route();
    if (!route) {
      this.say('assistant', 'Writing a plugin needs Claude (your subscription or an API key); it is not set up.', {
        error: true,
      });
      return;
    }
    const abort = new AbortController();
    this.buildAbort = abort;
    const at = (stage: BuildStage, round: number) =>
      this.store.setState({ building: { name: spec.name, kind: spec.kind, stage, round } });
    at('writing', 0);
    try {
      const builder = new PluginBuilder({ fetch: this.fetchImpl, smoke: this.smoke });
      const taken = [...this.s.plugins.list().map((e) => e.def.id), ...this.s.plugins.scripts().map((e) => e.def.id)];
      const result = await builder.build(spec, {
        model: this.store.getState().model,
        backend: route,
        signal: abort.signal,
        progress: at,
        taken,
      });
      if (result.ok) {
        const { draft } = result;
        const level = draft.report?.peakDb != null ? ` Test render peak ${Math.round(draft.report.peakDb)} dBFS.` : '';
        this.say('assistant', draft.message || `“${draft.name}” is ready.`, {
          detail: `Checked and test-rendered${draft.rounds ? ` after ${draft.rounds} fix${draft.rounds === 1 ? '' : 'es'}` : ''}.${level}`,
          plugin: { draft, state: 'draft' },
        });
      } else {
        this.say('assistant', `I couldn't get “${spec.name}” working after ${MAX_FIX_ROUNDS} rounds of fixes.`, {
          error: true,
          warnings: result.problems.slice(0, 8),
          ...(result.draft ? { plugin: { draft: result.draft, state: 'failed' as const } } : {}),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') this.say('assistant', `Stopped building “${spec.name}”.`);
      else this.say('assistant', e instanceof Error ? e.message : String(e), { error: true });
    } finally {
      this.buildAbort = null;
      this.store.setState({ building: null });
    }
  }

  cancelBuild(): void {
    this.buildAbort?.abort();
  }

  /** Installs a checked draft: it moves into plugins/ and hot reload adds it to the browser. */
  async installPlugin(messageId: number): Promise<void> {
    const msg = this.store.getState().messages.find((m) => m.id === messageId);
    if (!msg?.plugin || msg.plugin.state !== 'draft') return;
    const { draft } = msg.plugin;
    this.setPluginState(messageId, 'installing');
    try {
      const { replaced } = await installDraft(this.fetchImpl, draft.id);
      const loaded = await this.waitForPlugin(draft.id);
      this.setPluginState(messageId, 'installed');
      this.s.session
        .getState()
        .toast(
          loaded
            ? `Installed “${draft.name}”${replaced ? ' (the old version is in plugins/_backup)' : ''}. Find it in the browser under Plugins.`
            : `Installed “${draft.name}” in plugins/${draft.folder}; it appears once the app reloads it.`,
        );
    } catch (e) {
      this.setPluginState(messageId, 'draft');
      this.s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async discardPlugin(messageId: number): Promise<void> {
    const msg = this.store.getState().messages.find((m) => m.id === messageId);
    if (!msg?.plugin || (msg.plugin.state !== 'draft' && msg.plugin.state !== 'failed')) return;
    this.setPluginState(messageId, 'discarded');
    await discardDraft(this.fetchImpl, msg.plugin.draft.id).catch(() => {});
  }

  private setPluginState(messageId: number, state: PluginMessage['state']): void {
    this.store.setState((st) => ({
      messages: st.messages.map((m) => (m.id === messageId && m.plugin ? { ...m, plugin: { ...m.plugin, state } } : m)),
    }));
  }

  /** Waits for hot reload to bring a newly installed plugin into the registry. */
  private waitForPlugin(id: string, ms = 15_000): Promise<boolean> {
    if (this.s.plugins.get(id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const stop = this.s.plugins.subscribe(() => {
        if (!this.s.plugins.get(id)) return;
        clearTimeout(timer);
        stop();
        resolve(true);
      });
      const timer = setTimeout(() => {
        stop();
        resolve(false);
      }, ms);
    });
  }

  /** The UI opened the windows the last answer asked for. */
  clearUiRequests(): void {
    if (this.store.getState().uiRequests.length) this.store.setState({ uiRequests: [] });
  }

  /** Stops waiting for Claude. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Forgets the conversation: the next request starts fresh (and makes a new pattern). */
  newBeat(): void {
    this.chat.reset();
    this.catalogSent = null;
    this.lastProblems = [];
    this.offlinePrompt = '';
    this.store.setState({ applied: null, messages: [], take: this.store.getState().take });
  }
}

/** What a request says the take is ("808s that go like…", "my beatbox"), if anything. */
export function inferRole(prompt: string): Exclude<PerformanceRole, 'auto'> | null {
  const t = prompt.toLowerCase();
  if (/\b808s?\b|\bbass ?line|\bbass\b|\bsub\b/.test(t)) return '808';
  if (/\bmelod|\blead\b|\btune\b|\bsing|\bhook\b|\bhumm?(ed|ing)? (a |the )?(melody|tune)/.test(t)) return 'melody';
  if (/\bbeat ?box|\bdrums?\b|\bkicks?\b|\bsnares?\b|\bhats?\b|\bpercussion\b/.test(t)) return 'drums';
  return null;
}

function analysisMode(role: PerformanceRole): 'auto' | 'drums' | 'tonal' {
  return role === 'drums' ? 'drums' : role === 'auto' ? 'auto' : 'tonal';
}

export function roleLabel(role: PerformanceRole): string {
  return { auto: 'auto', drums: 'drums', '808': 'an 808 line', melody: 'a melody' }[role];
}
