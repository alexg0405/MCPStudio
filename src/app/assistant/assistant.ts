import type { StoreApi } from 'zustand/vanilla';
import type { Services } from '../services';
import type { SmokeReport, PluginSpec } from '../ai/builder';
import type { AiFocus } from '../ai/focus';
import type { AiAnswer } from '../ai/schema';
import { analyzeMix } from '../analysis/mix';
import { playFocus } from './play-focus';
import type { AssistantApi } from './api';
import type { AiBackend, AiStatus } from './claude';
import {
  createAssistantCore,
  type AssistantCore,
  type AssistantState,
  type ExternalApplied,
  type ExternalApply,
} from './state';
import { applyExternal, reportExternal } from './beat-assistant/external-apply';
import { balanceMix, CHECK_MIX_REQUEST } from './beat-assistant/mix-listening';
import { buildPlugin, cancelBuild, discardPlugin, installPlugin } from './beat-assistant/plugin-building';
import { AssistantSession } from './beat-assistant/session';
import { send } from './beat-assistant/send';
import { createTakeRecorder, type TakeRecorder } from './beat-assistant/take-recorder';
import { approve, listenAndAsk } from './beat-assistant/turn';

/**
 * The beat assistant: you describe a beat (and optionally perform part of it with your voice); it writes
 * the beat into the project with an AI, or with the offline generator when none is set up. Follow-ups change
 * the same pattern. Lives for the whole session (created in services).
 *
 * This class is the public surface; the work is split by job into `beat-assistant/` (sending a request,
 * applying the answer, the take recorder, mix listening, the plugin builder, edits from AI apps), each
 * module working on the shared `AssistantSession`.
 */

export {
  AI_MODELS,
  DEFAULT_MODEL,
  type ApprovalMessage,
  type AssistantMessage,
  type AssistantPhase,
  type AssistantState,
  type PluginMessage,
  type Take,
} from './state';
export { inferRole, roleLabel } from './beat-assistant/performance-role';

/** The plugin builder carries the SDK guide and every template (~65 kB): the smoke test loads with it. */
const smokeTest = (folder: string): Promise<SmokeReport> =>
  import('../ai/smoke').then((module) => module.smokeTest(folder));

/** What the assistant needs from outside; tests pass fakes. */
export interface AssistantDeps {
  fetch?: typeof fetch;
  smoke?: (folder: string) => Promise<SmokeReport>;
  /** Mix analysis (tests pass a fake: Node has no OfflineAudioContext). */
  analyze?: typeof analyzeMix;
  /** The state store when the facade already made it (see facade.ts); otherwise created here. */
  core?: AssistantCore;
}

/** The Studio assistant (the public surface; see the file comment). */
export class BeatAssistant implements AssistantApi {
  readonly store: StoreApi<AssistantState>;
  private readonly session: AssistantSession;
  private readonly recorder: TakeRecorder;

  constructor(
    private readonly services: Services,
    deps: AssistantDeps = {},
  ) {
    const core = deps.core ?? createAssistantCore(services.history);
    this.session = new AssistantSession(services, core, {
      fetchImpl: deps.fetch ?? ((...args) => fetch(...args)),
      smoke: deps.smoke ?? smokeTest,
      analyzeMix: deps.analyze ?? analyzeMix,
    });
    this.store = this.session.store;
    this.recorder = createTakeRecorder(this.session);
  }

  /** Answers waiting for the musician's OK to change things outside the part, by message id (tests look). */
  get approvals(): AssistantSession['approvals'] {
    return this.session.approvals;
  }

  /** Writes this tab's conversation now (it also saves itself after changes and when the page hides). */
  saveTab(): void {
    this.session.saveTab();
  }

  set(patch: Partial<AssistantState>): void {
    this.store.setState(patch);
  }

  checkAi(): Promise<AiStatus> {
    return this.session.checkAi();
  }

  /** The way this request will reach an AI, or null for the offline generator. */
  route(): Promise<AiBackend | null> {
    return this.session.route();
  }

  // ---------------------------------------------------------------- asking

  /**
   * Asks for a beat or any change. `focus`: the part of the song the request is about (it becomes the
   * conversation's part; null clears it); without it the conversation's part, if any, stays.
   */
  send(prompt: string, opts: { focus?: AiFocus | null } = {}): Promise<void> {
    return send(this.session, prompt, opts);
  }

  /**
   * The musician's choice on an answer that reaches outside the part: 'all' applies everything (the
   * part still gets its own copies of shared patterns), 'part' only what stays inside it. One undo step.
   */
  approve(messageId: number, choice: 'all' | 'part'): Promise<void> {
    return approve(this.session, messageId, choice);
  }

  /** Stops waiting for the AI. */
  cancel(): void {
    this.session.abort?.abort();
  }

  /** Forgets the conversation: the next request starts fresh (and makes a new pattern). */
  newBeat(): void {
    const { session } = this;
    session.chat.reset();
    session.catalogSent = {};
    session.lastProblems = [];
    session.offlinePrompt = '';
    session.offlineSongs = 0;
    session.offlineEdits = 0;
    session.approvals.clear();
    this.store.setState({ applied: null, messages: [], take: this.store.getState().take, focus: null });
  }

  /** The UI opened the windows the last answer asked for. */
  clearUiRequests(): void {
    if (this.store.getState().uiRequests.length) this.store.setState({ uiRequests: [] });
  }

  // ---------------------------------------------------------------- AI apps over MCP

  /**
   * Applies actions an AI app sent over MCP (src/app/mcp): the same applier as an answer from Studio, one
   * undo step labelled with the app's name, and a message in this chat ("Claude Code changed: …") with the
   * usual Undo. With a focus, edits outside the part wait for `approveOutside`. Playback only changes when
   * the actions ask for it. Resolves when the follow-up steps (leveling…) are done.
   */
  applyExternal(answer: AiAnswer, options: ExternalApply): Promise<ExternalApplied> {
    return applyExternal(this.session, answer, options);
  }

  /** A line in this chat about something an AI app did (a command, an undo…), with an Undo when it changed the project. */
  reportExternal(
    client: string,
    text: string,
    extra: { undo?: number; changes?: string[]; warnings?: string[] } = {},
  ): void {
    reportExternal(this.session, client, text, extra);
  }

  // ---------------------------------------------------------------- the part a request is about

  /** Sets (or clears) the part of the song the conversation is about; follow-ups keep it. */
  setFocus(focus: AiFocus | null): void {
    this.session.setFocus(focus);
  }

  /**
   * Plays a part: a span of the song loops in song mode from its start; selected notes play their
   * pattern in pattern mode. Default: the conversation's part. False when there is nothing to play.
   */
  playFocus(focus: AiFocus | null = this.store.getState().focus): boolean {
    return playFocus(this.services, focus);
  }

  // ---------------------------------------------------------------- recording

  /** Records `bars` bars after a one-bar count-in (needs a user gesture for the mic prompt). */
  record(): Promise<void> {
    return this.recorder.record();
  }

  /** Input level of the live recording (0..1), for meters on the frame loop. */
  recordingLevel(): number {
    return this.recorder.level();
  }

  /** Seconds since bar 1 of the live recording (negative while counting in), or null. */
  recordingPosition(): number | null {
    return this.recorder.position();
  }

  /** Ends the recording now (keeps what was recorded). */
  stopRecording(): void {
    this.recorder.stop();
  }

  cancelRecording(): void {
    this.recorder.cancel();
  }

  /** A recording made elsewhere (phone voice memo, an audio file): bar 1 is where the sound starts. */
  importRecording(file: Pick<File, 'name' | 'arrayBuffer'>): Promise<void> {
    return this.recorder.importFile(file);
  }

  clearTake(): void {
    this.store.setState({ take: null });
  }

  /** Plays the take back (as recorded) on the preview bus. */
  playTake(): void {
    this.recorder.playTake();
  }

  // ---------------------------------------------------------------- listening to the mix

  /**
   * Renders and measures the mix (every mixer track too), shows what it found, and asks the AI again with
   * the analysis so it can mix with real numbers. `fromUser`: the musician asked for a mix check (their
   * message goes in the chat first). Without an AI it still shows the findings.
   */
  listenAndAsk(request: string, fromUser: boolean, focus?: AiFocus | null): Promise<void> {
    return listenAndAsk(this.session, request, { fromUser, ...(focus !== undefined ? { focus } : {}) });
  }

  /** The "Check my mix" button: listen, then let the AI improve the mix with the numbers. */
  checkMix(): Promise<void> {
    return this.listenAndAsk(CHECK_MIX_REQUEST, true);
  }

  /**
   * "Balance the mix": levels the song without an AI (auto-level: the role buses around the kick, or for a
   * mix built by hand just its loudness), one undo step, with progress in the Studio. It waits while the
   * song plays.
   */
  balanceMix(): Promise<void> {
    return balanceMix(this.session);
  }

  // ---------------------------------------------------------------- plugin builder

  /**
   * Has the plugin builder write a new plugin (asked for by an answer's build_plugin action). Its result
   * arrives as a message with Install and Discard.
   */
  buildPlugin(spec: PluginSpec): Promise<void> {
    return buildPlugin(this.session, spec);
  }

  cancelBuild(): void {
    cancelBuild(this.session);
  }

  /** Installs a checked draft: it moves into plugins/ and hot reload adds it to the browser. */
  installPlugin(messageId: number): Promise<void> {
    return installPlugin(this.session, messageId);
  }

  discardPlugin(messageId: number): Promise<void> {
    return discardPlugin(this.session, messageId);
  }
}
