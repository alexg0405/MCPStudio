import { createStore, type StoreApi } from 'zustand/vanilla';
import { generateLocalBeat, type PerformanceRole } from '@core/beat/local';
import { inferStyle } from '@core/beat/style';
import type { BeatSpec } from '@core/beat/spec';
import { encodeWav } from '@core/io/wav';
import { ticksPerBar } from '@core/time/ppq';
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
import type { ParamSpecs } from '@agstudio/sdk';
import type { Services } from '../services';
import { applyAnswer, type AfterEdit } from '../ai/apply';
import { pluginCatalog } from '../ai/catalog';
import { commandCatalog } from '../ai/commands';
import type { BuildStage, PluginDraft, PluginSpec, SmokeReport } from '../ai/builder';
import { focusContext, isAiFocus, resolveFocus, type AiFocus, type ResolvedFocus } from '../ai/focus';
import { analyzeMix, formatMixReport, summarizeMixReport, type AnalyzeRange } from '../analysis/mix';
import { afterStepFor, type AfterStepResult } from './after-steps';
import { audition } from './audition';
import { projectContext } from '../ai/context';
import { formatLookups } from '../ai/read';
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

// The plugin builder carries the SDK guide and every template (~65 kB): it loads when a plugin is first built.
/** Rounds of look-ups (query actions) one request may take before Studio has to answer. */
const MAX_LOOKUPS = 3;

const builder = () => import('../ai/builder');
const smokeTest = (folder: string): Promise<SmokeReport> => import('../ai/smoke').then((m) => m.smokeTest(folder));

/**
 * The beat assistant: you describe a beat (and optionally perform part of it with your voice); it
 * writes the beat into the project with Claude, or with the offline generator when no Claude key is
 * set up. Follow-ups change the same pattern. Lives for the whole session (created in services).
 */

export type AssistantPhase = 'idle' | 'counting-in' | 'recording' | 'analyzing' | 'listening' | 'thinking';

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
  /** What a mix analysis found, one line each. */
  findings?: string[];
  /** An answer that also changes things outside the part being worked on: waiting for the musician's OK. */
  approval?: ApprovalMessage;
}

export interface ApprovalMessage {
  /** The part ("bars 2–3"). */
  part: string;
  /** What reaches outside it, one line each. */
  outside: string[];
  /** ask: waiting; all: applied with the outside edits; part: applied to the part only; expired: no longer possible. */
  state: 'ask' | 'all' | 'part' | 'expired';
}

/** An edit from an AI app over MCP. */
export interface ExternalApply {
  /** The app's name for the chat and the undo label ("Claude Code"). */
  client: string;
  /** What it did, in a sentence for the musician (also the undo label). */
  summary: string;
  /** Limit the edit to this part of the song. */
  focus?: AiFocus | null;
  /** With a focus: edits beyond the part are allowed. */
  approveOutside?: boolean;
  /** Wait for follow-up work (leveling, filters) before returning (default true). */
  waitForFollowups?: boolean;
  /** A file-dialog command the actions asked for: the app shows the musician a button. */
  onGesture?(commandId: string, args: unknown): void;
}

export interface ExternalApplied {
  /** applied; needs_approval: nothing changed, the edit reaches outside the part; busy: Studio is mid-request. */
  status: 'applied' | 'needs_approval' | 'busy';
  changes: string[];
  warnings: string[];
  edited: boolean;
  /** The history point before the edit: `undo` with it goes back here. */
  beforePoint: number;
  /** The history point after it (null when nothing changed). */
  undoPoint: number | null;
  /** What the follow-up steps did. */
  followups: string[];
  findings?: string[];
  /** needs_approval: the part and what reaches outside it. */
  part?: string;
  outside?: string[];
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
  /** A mix analysis in progress: which part it is rendering, 0–1. */
  listening: { label: string; fraction: number } | null;
  /**
   * The part of the song the conversation is about ("Ask AI about this part"): the AI changes only
   * it. Follow-ups keep it; New chat and opening another project clear it.
   */
  focus: AiFocus | null;
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
  private readonly analyze: typeof analyzeMix;
  private buildAbort: AbortController | null = null;
  /** Stops the phrase an answer is auditioning (a new one replaces it). */
  private stopAudition: (() => void) | null = null;
  /** Everything asked so far in offline mode (the generator is stateless). */
  private offlinePrompt = '';

  constructor(
    private readonly s: Services,
    deps: {
      fetch?: typeof fetch;
      smoke?: (folder: string) => Promise<SmokeReport>;
      /** Mix analysis (tests pass a fake: Node has no OfflineAudioContext). */
      analyze?: typeof analyzeMix;
    } = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
    this.smoke = deps.smoke ?? smokeTest;
    this.analyze = deps.analyze ?? analyzeMix;
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
      listening: null,
      focus: null,
    }));
    this.restoreTab();
    // Another project opened (or a new one): the part belonged to the old one.
    s.history.onChange(({ origin, next }) => {
      const f = this.store.getState().focus;
      if (origin === 'load' && f && f.projectId !== next.projectId) this.setFocus(null);
    });
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
    const { messages, applied, take, focus } = this.store.getState();
    try {
      globalThis.sessionStorage?.setItem(
        TAB_KEY,
        JSON.stringify({
          messages: messages.slice(-40),
          applied,
          take: take ? { ...take, audio: null } : null,
          focus,
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
      focus: unknown;
    }>;
    // A reload starts a new history that numbers its steps from 1 again: the undo points of the old
    // session would point at unrelated steps, so the answers keep their text but lose their Undo.
    const messages = (Array.isArray(r.messages) ? r.messages.filter((m) => typeof m?.text === 'string') : []).map(
      ({ undo: _undo, ...m }) => (m.beat ? { ...m, beat: { ...m.beat, cursor: -1 } } : m),
    );
    messageSeq = Math.max(messageSeq, ...messages.map((m) => (typeof m.id === 'number' ? m.id : 0)));
    const applied = r.applied && typeof r.applied.patternId === 'string' && r.applied.channels ? r.applied : null;
    const take = r.take && Array.isArray(r.take.events) ? { ...r.take, audio: null } : null;
    const focus = isAiFocus(r.focus) ? r.focus : null;
    this.store.setState({ messages, applied, take, focus });
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

  private say(from: AssistantMessage['from'], text: string, extra: Partial<AssistantMessage> = {}): number {
    const id = ++messageSeq;
    this.store.setState((st) => ({ messages: [...st.messages, { id, from, text, ...extra }] }));
    return id;
  }

  /** Answers waiting for the musician's OK to change things outside the part, by message id. */
  private readonly approvals = new Map<
    number,
    { answer: AiAnswer; take: Take | null; request: string; analyzed: boolean; focus: AiFocus | null }
  >();

  /**
   * The musician's choice on an answer that reaches outside the part: 'all' applies everything (the
   * part still gets its own copies of shared patterns), 'part' only what stays inside it. One undo step.
   */
  async approve(messageId: number, choice: 'all' | 'part'): Promise<void> {
    const pending = this.approvals.get(messageId);
    const setState = (state: ApprovalMessage['state']) =>
      this.store.setState((st) => ({
        messages: st.messages.map((m) => (m.id === messageId && m.approval ? { ...m, approval: { ...m.approval, state } } : m)),
      }));
    // Another project is open now: the answer was about the old one.
    if (!pending || (pending.focus && pending.focus.projectId !== this.s.doc.getState().project.projectId)) {
      this.approvals.delete(messageId);
      setState('expired');
      return;
    }
    if (this.store.getState().phase !== 'idle') return;
    this.approvals.delete(messageId);
    setState(choice);
    const { answer, take, request, analyzed, focus } = pending;
    const listen = await this.applyTurn(answer, take, request, analyzed, focus, choice === 'all' ? 'allow' : 'refuse');
    if (listen) await this.listenAndAsk(request, false, focus);
  }

  /** Answers still waiting for an OK are about the song as it was: a new request retires them. */
  private retireApprovals(): void {
    if (this.approvals.size === 0) return;
    const ids = new Set(this.approvals.keys());
    this.approvals.clear();
    this.store.setState((st) => ({
      messages: st.messages.map((m) => (ids.has(m.id) && m.approval ? { ...m, approval: { ...m.approval, state: 'expired' as const } } : m)),
    }));
  }

  // ---------------------------------------------------------------- AI apps over MCP

  /**
   * Applies actions an AI app sent over MCP (src/app/mcp): the same applier as an answer from Studio,
   * one undo step labelled with the app's name, and a message in this chat ("Claude Code changed: …")
   * with the usual Undo. With a focus, edits outside the part wait for `approveOutside`. Playback
   * only changes when the actions ask for it. Resolves when the follow-up steps (leveling…) are done.
   */
  async applyExternal(answer: AiAnswer, opts: ExternalApply): Promise<ExternalApplied> {
    const empty: ExternalApplied = {
      status: 'applied',
      changes: [],
      warnings: [],
      edited: false,
      beforePoint: this.s.history.status().cursor,
      undoPoint: null,
      followups: [],
    };
    if (!(await this.untilIdle(15_000)))
      return { ...empty, status: 'busy', warnings: ['Studio is busy with another request. Try again in a moment.'] };
    const part = resolveFocus(this.s.doc.getState().project, opts.focus ?? null);
    const ctx = {
      previousBeat: part?.notes ? null : this.store.getState().applied,
      label: opts.summary,
      source: opts.client,
      focus: part,
    };
    // Working on a part: edits that also reach outside it wait for the app to say it is allowed.
    if (part && !opts.approveOutside) {
      const dry = applyAnswer(this.s, answer, { ...ctx, dryRun: true });
      if (dry.outsideFocus?.length)
        return {
          ...empty,
          status: 'needs_approval',
          part: part.label,
          outside: [...new Set(dry.outsideFocus)],
          warnings: dry.warnings,
        };
    }
    const result = applyAnswer(this.s, answer, {
      ...ctx,
      ...(part ? { focusOutside: opts.approveOutside ? ('allow' as const) : ('refuse' as const) } : {}),
    });
    const cursor = this.s.history.status().cursor;
    const changes = [...result.changes];
    const warnings = [...result.warnings];
    // App commands: most run now; file dialogs need the musician's click (the app shows a button).
    for (const a of result.after) {
      if (a.kind !== 'command') continue;
      const title = this.s.commands.get(a.id)?.title.replace(/…$/, '') ?? a.id;
      if (a.gesture) {
        opts.onGesture?.(a.id, a.args);
        changes.push(`${title}: waiting for the musician's click`);
      } else if (this.s.commands.run(a.id, a.args)) changes.push(`Ran “${title}”`);
      else warnings.push(`command: “${title}” isn't available right now`);
    }
    const verb = result.edited ? 'changed' : changes.length ? 'did' : 'tried to change';
    const summary = opts.summary.trim() || answer.message.trim();
    this.say('assistant', `${opts.client} ${verb}: ${summary || 'the project'}`, {
      detail: 'over MCP',
      ...(changes.length ? { changes } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(result.edited ? { undo: cursor } : {}),
      ...(result.beat
        ? { beat: { title: this.s.doc.getState().project.patterns[result.beat.patternId]?.name ?? 'Beat', cursor } }
        : {}),
    });
    if (result.beat) this.store.setState({ applied: result.beat });
    const windows = result.after.filter((a) => a.kind === 'open');
    if (windows.length) this.store.setState({ uiRequests: windows });
    if (result.selectClips?.length) this.s.editor.getState().selectClips(result.selectClips);
    const followups: string[] = [];
    if (opts.waitForFollowups !== false)
      await this.runAfterSteps(result.after, result.edited ? cursor : null, {
        quietWaitMs: 30_000,
        onResult: (r) =>
          followups.push(r.message, ...(r.changes ?? []), ...(r.warnings ?? []).map((w) => `Could not: ${w}`)),
      });
    const undoPoint = this.s.history.status().cursor;
    // Playback the actions asked for (nothing else starts or stops the music).
    if (result.edited)
      await Promise.race([this.s.engine.ready().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
    for (const a of result.after) {
      if (a.kind === 'mode') this.s.view.getState().setMode(a.mode);
      else if (a.kind === 'stop') this.s.engine.stop();
      else if (a.kind === 'metronome') this.s.prefs.getState().set({ metronome: a.on });
      else if (a.kind === 'play') {
        if (a.mode) this.s.view.getState().setMode(a.mode);
        this.s.engine.play(a.fromTick ?? 0);
      } else if (a.kind === 'build_plugin') void this.buildPlugin(a.spec);
    }
    return {
      status: 'applied',
      changes,
      warnings,
      edited: result.edited || undoPoint !== empty.beforePoint,
      beforePoint: empty.beforePoint,
      undoPoint: undoPoint !== empty.beforePoint ? undoPoint : null,
      followups,
      ...(result.findings?.length ? { findings: result.findings } : {}),
    };
  }

  /** A line in this chat about something an AI app did (a command, an undo…), with an Undo when it changed the project. */
  reportExternal(
    client: string,
    text: string,
    extra: { undo?: number; changes?: string[]; warnings?: string[] } = {},
  ): void {
    this.say('assistant', `${client} ${text}`, { detail: 'over MCP', ...extra });
  }

  /** Resolves true when no request is running (waits up to `ms` for one to finish). */
  private untilIdle(ms: number): Promise<boolean> {
    if (this.store.getState().phase === 'idle') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        off();
        clearTimeout(timer);
        resolve(ok);
      };
      const off = this.store.subscribe((st) => {
        if (st.phase === 'idle') done(true);
      });
      const timer = setTimeout(() => done(false), ms);
    });
  }

  // ---------------------------------------------------------------- the part a request is about

  /** Sets (or clears) the part of the song the conversation is about; follow-ups keep it. */
  setFocus(focus: AiFocus | null): void {
    if (this.store.getState().focus !== focus) this.store.setState({ focus });
  }

  /**
   * Plays a part: a span of the song loops in song mode from its start; selected notes play their
   * pattern in pattern mode. Default: the conversation's part. False when there is nothing to play.
   */
  playFocus(focus: AiFocus | null = this.store.getState().focus): boolean {
    const r = resolveFocus(this.s.doc.getState().project, focus);
    if (!r) return false;
    const v = this.s.view.getState();
    if (r.notes) {
      v.setCurrentPattern(r.notes.patternId);
      this.s.session.getState().selectChannel(r.notes.channelId);
      v.setMode('pattern');
      this.s.engine.play();
    } else {
      v.setLoop({ start: r.from, end: r.to });
      v.setMode('song');
      this.s.engine.play(r.from);
    }
    return true;
  }

  /** Plugin names and settings, for the <focus> block's automation lines. */
  private readonly pluginInfo = (id: string) => {
    const def = this.s.plugins.get(id);
    return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
  };

  /** "About Verse · bars 17–32" under the musician's message (or why the part was dropped). */
  private aboutText(asked: AiFocus | null, focus: ResolvedFocus | null): string | undefined {
    if (focus) return `About ${focus.label}`;
    return asked ? 'The part you picked is no longer in the song, so this is about the whole song' : undefined;
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

  /**
   * Asks for a beat or any change. `focus`: the part of the song the request is about (it becomes the
   * conversation's part; null clears it); without it the conversation's part, if any, stays.
   */
  async send(prompt: string, opts: { focus?: AiFocus | null } = {}): Promise<void> {
    const st = this.store.getState();
    if (st.phase !== 'idle') return;
    const text = prompt.trim();
    let take = st.take;
    if (!text && !take) return;
    if (opts.focus !== undefined) this.setFocus(opts.focus);
    this.retireApprovals();
    // The part as it is now; a part that no longer exists is dropped. Kept as sent for the answer.
    const asked = this.store.getState().focus;
    const focus = resolveFocus(this.s.doc.getState().project, asked);
    if (asked && !focus) this.setFocus(null);
    const snapshot = focus ? asked : null;
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
    const detail = [takeNote, this.aboutText(asked, focus)].filter(Boolean).join(' · ');
    this.say('you', text || 'Turn my take into a beat.', detail ? { detail } : {});
    this.store.setState({ phase: 'thinking' });
    const project = this.s.doc.getState().project;
    let spec: BeatSpec | null = null;
    let offline = false;
    // Stop works from the start, also while it checks how to reach Claude.
    const abort = new AbortController();
    this.abort = abort;
    const route = await this.route();
    if (abort.signal.aborted) {
      this.abort = null;
      this.say('assistant', 'Stopped.', {});
      this.store.setState({ phase: 'idle' });
      return;
    }
    if (!route) this.abort = null;
    if (route) {
      try {
        const answer = await this.chat.ask<AiAnswer>({
          system: STUDIO_PROMPT,
          schema: ACTIONS_SCHEMA,
          text: this.turnText(text || 'Make a beat from my performance.', take, undefined, focus),
          model: st.model,
          backend: route,
          signal: abort.signal,
          read: (raw) => {
            const r = readAnswer(raw);
            return 'error' in r ? { error: r.error } : { value: r.answer };
          },
        });
        if (take) this.store.setState({ take: { ...take, sent: true } });
        if (await this.applyTurn(answer, take, text, false, snapshot)) await this.listenAndAsk(text, false, snapshot);
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
    if (focus) {
      // The offline generator writes whole beats: it can't change one part of a song.
      this.say(
        'assistant',
        'Changing one part of the song needs Claude (your subscription or an API key), and it isn’t set up. Set it up in Studio’s settings, or clear the part to make a beat with the offline generator.',
        { offline: true },
      );
      this.store.setState({ phase: 'idle' });
      return;
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

  /** This turn's message to Claude: the request, the project, the part it is about, and what Claude doesn't have yet. */
  private turnText(
    prompt: string,
    take: Take | null,
    analysis?: string,
    focus?: ResolvedFocus | null,
    lookups?: string,
  ): string {
    const parts = [`<request>\n${prompt.trim()}\n</request>`, `<project>\n${projectContext(this.s)}\n</project>`];
    if (focus) parts.push(`<focus>\n${focusContext(this.s.doc.getState().project, focus, this.pluginInfo)}\n</focus>`);
    if (lookups)
      parts.push(
        `<lookups>\n${lookups}\n</lookups>\nThis is what you asked to look at (read just now). Answer the request with it; look up again only if something is still missing.`,
      );
    if (analysis)
      parts.push(
        `<mix-analysis>\n${analysis}\n</mix-analysis>\nThis is how the mix sounds right now (rendered and measured just now). Answer the request with it; don't ask for another analysis.`,
      );
    const catalog = pluginCatalog(this.s.plugins, this.s.presets);
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

  /**
   * Applies Claude's answer as one undo step and reports it in the chat. True when the answer asked
   * to hear the mix first (and this turn wasn't already the answer to an analysis).
   */
  private async applyTurn(
    answer: AiAnswer,
    take: Take | null,
    request: string,
    analyzed = false,
    focus: AiFocus | null = null,
    /** Edits beyond the part: undefined asks the musician first (when there are any). */
    outside?: 'refuse' | 'allow',
    /** How many rounds of look-ups (query actions) led to this answer. */
    lookups = 0,
  ): Promise<boolean> {
    let result: ReturnType<typeof applyAnswer>;
    // The part as it is now (it may have moved while Claude was thinking).
    const part = resolveFocus(this.s.doc.getState().project, focus);
    const ctx = {
      // Selected notes: a beat makes a new pattern instead of rewriting theirs.
      previousBeat: part?.notes ? null : this.store.getState().applied,
      ...(request ? { label: request } : {}),
      focus: part,
      ...(outside ? { focusOutside: outside } : {}),
    };
    try {
      // Working on a part: an answer that also reaches outside it waits for the musician's OK.
      if (part && !outside) {
        const dry = applyAnswer(this.s, answer, { ...ctx, dryRun: true });
        if (dry.outsideFocus?.length) {
          const id = this.say('assistant', answer.message || 'Here is what I would change.', {
            approval: { part: part.label, outside: [...new Set(dry.outsideFocus)], state: 'ask' },
          });
          this.approvals.set(id, { answer, take, request, analyzed, focus });
          this.store.setState({ phase: 'idle' });
          return false;
        }
      }
      result = applyAnswer(this.s, answer, ctx);
    } catch (e) {
      console.error('[agstudio] applying the Studio answer failed', e);
      this.say('assistant', `Something went wrong applying that: ${e instanceof Error ? e.message : e}`, {
        error: true,
      });
      this.store.setState({ phase: 'idle' });
      return false;
    }
    const listen = result.after.some((a) => a.kind === 'analyze_mix');
    this.lastProblems = result.warnings;
    const cursor = this.s.history.status().cursor;
    // App commands: most run now; file dialogs wait for the musician's click (the UI asks).
    const changes = [...result.changes, ...(result.ui ?? [])];
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
    // The part after the edit (copies made for it, clips that moved), unless the musician changed it meanwhile.
    if (part && result.focus && this.store.getState().focus === focus) this.setFocus(result.focus);
    if (result.selectClips?.length) this.s.editor.getState().selectClips(result.selectClips);
    const notes = result.focus?.kind === 'notes' ? result.focus : null;
    if (
      notes &&
      this.s.view.getState().currentPatternId === notes.patternId &&
      this.s.session.getState().selectedChannelId === notes.channelId
    )
      this.s.editor.getState().selectNotes(notes.noteIds);
    // Follow-up steps (leveling the mix…) finish before anything plays, in the answer's undo step.
    const listened = await this.runAfterSteps(result.after, result.edited ? cursor : null);
    // New instruments and effects load in the background: start playing once they can sound (or after a few seconds).
    if (result.edited) await Promise.race([this.s.engine.ready().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
    // Playback the answer asked for (or, with autoplay on, what it arranged or a new beat).
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
    // Let the musician hear the sound it made (not over the playing song).
    const listenTo = result.after.find((a) => a.kind === 'audition');
    if (listenTo?.kind === 'audition' && !this.s.engine.playing) {
      this.stopAudition?.();
      this.stopAudition = audition(this.s, listenTo.channelId, listenTo.phrase);
    }
    // The musician pressed Play themselves while it finished: leave their playback alone.
    const played = listened || result.after.some((a) => a.kind === 'play' || a.kind === 'stop');
    if (!played && this.store.getState().autoplay) {
      if (part && result.edited) {
        // The part it changed, on a loop.
        this.playFocus(result.focus ?? focus);
      } else if (result.touched) {
        // The song around what changed: from a bar before it.
        const bar = ticksPerBar(this.s.doc.getState().project.transport.timeSig);
        this.s.view.getState().setMode('song');
        this.s.engine.play(Math.max(0, result.touched.from - bar));
      } else if (result.beat) {
        this.s.view.getState().setMode('pattern');
        this.s.engine.play();
      }
    }
    // It asked to look at something (query actions): ask again with what the read tools returned.
    if (result.queries?.length) {
      if (lookups >= MAX_LOOKUPS) {
        this.say('assistant', 'I looked at what I could, but I still need more than I can read in one go. Ask me about one part at a time.', {});
        return false;
      }
      await this.lookUpAndAsk(request, result.queries, focus, lookups + 1, analyzed);
      return false;
    }
    return listen && !analyzed;
  }

  /** Asks Claude again with what its look-ups found (read just now), and applies the answer. */
  private async lookUpAndAsk(
    request: string,
    queries: NonNullable<ReturnType<typeof applyAnswer>['queries']>,
    focus: AiFocus | null,
    round: number,
    analyzed: boolean,
  ): Promise<void> {
    this.store.setState({ phase: 'thinking' });
    const route = await this.route();
    if (!route) {
      this.store.setState({ phase: 'idle' });
      return;
    }
    const own = this.abort === null;
    const abort = this.abort ?? new AbortController();
    this.abort = abort;
    try {
      const answer = await this.chat.ask<AiAnswer>({
        system: STUDIO_PROMPT,
        schema: ACTIONS_SCHEMA,
        text: this.turnText(request, null, undefined, resolveFocus(this.s.doc.getState().project, focus), formatLookups(queries)),
        model: this.store.getState().model,
        backend: route,
        signal: abort.signal,
        read: (raw) => {
          const r = readAnswer(raw);
          return 'error' in r ? { error: r.error } : { value: r.answer };
        },
      });
      if (await this.applyTurn(answer, null, request, analyzed, focus, undefined, round)) await this.listenAndAsk(request, false, focus);
    } catch (e) {
      const stopped = e instanceof DOMException && e.name === 'AbortError';
      this.say('assistant', stopped ? 'Stopped.' : e instanceof Error ? e.message : String(e), {
        ...(stopped ? {} : { error: true }),
      });
      this.store.setState({ phase: 'idle' });
    } finally {
      if (own) this.abort = null;
    }
  }

  /**
   * Runs the answer's follow-up steps (see after-steps.ts) with progress; Stop cancels them. Their
   * heavy work waits while the musician plays the song (rendering next to playback makes it choppy).
   * True when the musician started playback meanwhile.
   */
  private async runAfterSteps(
    after: readonly AfterEdit[],
    entry: number | null,
    /** `quietWaitMs`: give up waiting for the music to stop after this long (an AI app is waiting for the answer). */
    opts: { quietWaitMs?: number; onResult?(res: AfterStepResult): void } = {},
  ): Promise<boolean> {
    const items = after.filter((a) => afterStepFor(a.kind));
    if (!items.length) return false;
    let listened = this.s.engine.playing;
    const offPlaying = this.s.engine.subscribe(() => {
      if (this.s.engine.playing) listened = true;
    });
    let label = 'Finishing up';
    let fraction = 0;
    const whenQuiet = () =>
      new Promise<void>((resolve) => {
        if (!this.s.engine.playing) return resolve();
        this.store.setState({ listening: { label: 'Waiting while you listen (stop playback to finish)', fraction } });
        const done = () => {
          off();
          clearTimeout(giveUp);
          this.store.setState({ listening: { label, fraction } });
          resolve();
        };
        const off = this.s.engine.subscribe(() => {
          if (!this.s.engine.playing) done();
        });
        const giveUp = opts.quietWaitMs === undefined ? undefined : setTimeout(done, opts.quietWaitMs);
      });
    const abort = new AbortController();
    this.abort = abort;
    this.store.setState({ phase: 'listening', listening: { label: 'Finishing up', fraction: 0 } });
    try {
      // The answer's undo step; when it changed nothing itself (a request that is only leveling or a
      // filter), the first step that edits makes it, and the steps after it join it.
      let own = entry;
      for (const item of items) {
        const was = this.s.history.status().cursor;
        const res = await afterStepFor(item.kind)!(item, {
          s: this.s,
          entry: own,
          signal: abort.signal,
          progress: (l, f) => {
            label = l;
            fraction = f;
            if (!this.s.engine.playing) this.store.setState({ listening: { label, fraction } });
          },
          whenQuiet,
        });
        const now = this.s.history.status().cursor;
        const made = own === null && now !== was;
        if (made) own = now;
        if (res) opts.onResult?.(res);
        if (res)
          this.say('assistant', res.message, {
            ...(res.changes?.length ? { changes: res.changes } : {}),
            ...(res.warnings?.length ? { warnings: res.warnings } : {}),
            ...(made ? { undo: now } : {}),
          });
      }
    } catch (e) {
      const stopped = e instanceof DOMException && e.name === 'AbortError';
      if (!stopped) this.say('assistant', `I couldn't finish: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      offPlaying();
      if (this.abort === abort) this.abort = null;
      this.store.setState({ phase: 'idle', listening: null });
    }
    return listened;
  }

  // ---------------------------------------------------------------- listening to the mix

  /**
   * Renders and measures the mix (every mixer track too), shows what it found, and asks Claude again
   * with the analysis so it can mix with real numbers. `fromUser`: the musician asked for a mix check
   * (their message goes in the chat first). Without Claude it still shows the findings.
   */
  async listenAndAsk(request: string, fromUser: boolean, focus?: AiFocus | null): Promise<void> {
    const st = this.store.getState();
    if (fromUser && st.phase !== 'idle') return;
    // The part to listen to (and to change): the one given, else the conversation's.
    const asked = focus === undefined ? st.focus : focus;
    const part = resolveFocus(this.s.doc.getState().project, asked);
    const snapshot = part ? asked : null;
    if (fromUser) {
      const about = this.aboutText(asked, part);
      this.say('you', request, about ? { detail: about } : {});
    }
    const range: AnalyzeRange | undefined = part
      ? part.notes
        ? { patternId: part.notes.patternId }
        : { from: part.from, to: part.to }
      : undefined;
    const abort = new AbortController();
    this.abort = abort;
    this.store.setState({ phase: 'listening', listening: { label: 'The mix', fraction: 0 } });
    let analysis: string;
    try {
      const report = await this.analyze(this.s, {
        signal: abort.signal,
        onProgress: (fraction, label) => this.store.setState({ listening: { label, fraction } }),
        ...(range ? { range } : {}),
      });
      analysis = formatMixReport(report);
      this.say('assistant', `I listened to ${report.what}.`, {
        detail: summarizeMixReport(report),
        ...(report.notes.length ? { findings: report.notes } : {}),
      });
    } catch (e) {
      const stopped = e instanceof DOMException && e.name === 'AbortError';
      this.say('assistant', stopped ? 'Stopped.' : `I couldn't listen to the mix: ${e instanceof Error ? e.message : e}`, {
        ...(stopped ? {} : { error: true }),
      });
      this.store.setState({ phase: 'idle', listening: null });
      this.abort = null;
      return;
    }
    this.store.setState({ phase: 'thinking', listening: null });
    const route = await this.route();
    if (!route) {
      this.say('assistant', 'Connect Claude (the ⋯ menu in Studio) and I can make these changes for you; the findings above are a start.', {
        offline: true,
      });
      this.store.setState({ phase: 'idle' });
      this.abort = null;
      return;
    }
    try {
      const answer = await this.chat.ask<AiAnswer>({
        system: STUDIO_PROMPT,
        schema: ACTIONS_SCHEMA,
        text: this.turnText(request, null, analysis, resolveFocus(this.s.doc.getState().project, snapshot)),
        model: this.store.getState().model,
        backend: route,
        signal: abort.signal,
        read: (raw) => {
          const r = readAnswer(raw);
          return 'error' in r ? { error: r.error } : { value: r.answer };
        },
      });
      await this.applyTurn(answer, null, request, true, snapshot);
    } catch (e) {
      const stopped = e instanceof DOMException && e.name === 'AbortError';
      this.say('assistant', stopped ? 'Stopped.' : e instanceof Error ? e.message : String(e), {
        ...(stopped ? {} : { error: true }),
      });
      this.store.setState({ phase: 'idle' });
    } finally {
      this.abort = null;
    }
  }

  /** The "Check my mix" button: listen, then let Claude improve the mix with the numbers. */
  checkMix(): Promise<void> {
    return this.listenAndAsk(
      'Listen to my mix and make it sound better: balance the levels, fix what clashes or sounds harsh, muddy or thin, and get the master to a good loudness without clipping. Tell me what you changed and why.',
      true,
    );
  }

  /**
   * "Balance the mix": levels the song without Claude (auto-level: the role buses around the kick,
   * or for a mix built by hand just its loudness), one undo step, with progress in the Studio. It
   * waits while the song plays.
   */
  async balanceMix(): Promise<void> {
    if (this.store.getState().phase !== 'idle') return;
    const style = inferStyle(this.s.doc.getState().project);
    await this.runAfterSteps([{ kind: 'level_mix', style }], null);
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
      const { PluginBuilder, MAX_FIX_ROUNDS } = await builder();
      const plugin = new PluginBuilder({ fetch: this.fetchImpl, smoke: this.smoke });
      const taken = [...this.s.plugins.list().map((e) => e.def.id), ...this.s.plugins.scripts().map((e) => e.def.id)];
      const result = await plugin.build(spec, {
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
      const { installDraft } = await builder();
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
    await builder()
      .then(({ discardDraft }) => discardDraft(this.fetchImpl, msg.plugin!.draft.id))
      .catch(() => {});
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
    this.approvals.clear();
    this.store.setState({ applied: null, messages: [], take: this.store.getState().take, focus: null });
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
