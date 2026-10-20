/**
 * What the assistant's modules share: the services, the state store, the conversation with the AI and the
 * bookkeeping of the request in flight (its abort controller, answers waiting for an OK, the last turn's
 * problems). `BeatAssistant` creates one; each module in this folder does one job with it.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { ParamSpecs } from '@agstudio/sdk';
import type { Services } from '../../services';
import type { SmokeReport } from '../../ai/builder';
import type { AiAnswer } from '../../ai/schema';
import type { AiFocus, ResolvedFocus } from '../../ai/focus';
import type { analyzeMix } from '../../analysis/mix';
import { ClaudeChat, fetchAiStatus, type AiBackend, type AiStatus } from '../claude';
import { lastMessageId, type AssistantCore, type AssistantMessage, type AssistantState, type Take } from '../state';

/** The outside world a session talks to; tests pass fakes. */
export interface AssistantEnvironment {
  fetchImpl: typeof fetch;
  /** Runs a freshly written plugin in a test render. */
  smoke(folder: string): Promise<SmokeReport>;
  /** Mix analysis (Node has no OfflineAudioContext, so tests pass a fake). */
  analyzeMix: typeof analyzeMix;
}

/** An answer waiting for the musician's OK to change things outside the part. */
export interface PendingApproval {
  answer: AiAnswer;
  take: Take | null;
  request: string;
  analyzed: boolean;
  focus: AiFocus | null;
}

/** Ids of chat messages are counted across assistants, so a second assistant in the same tab never repeats one. */
let lastIssuedMessageId = 0;

/** The shared state of one assistant. */
export class AssistantSession {
  readonly store: StoreApi<AssistantState>;
  readonly chat: ClaudeChat;
  readonly fetchImpl: typeof fetch;
  readonly smoke: (folder: string) => Promise<SmokeReport>;
  readonly analyzeMix: typeof analyzeMix;
  /** Catalog key each backend's conversation has (sent again when the plugins change). */
  catalogSent: Partial<Record<AiBackend, string>> = {};
  /** What the last turn couldn't do, told to the AI with the next request. */
  lastProblems: string[] = [];
  /** Everything asked so far in offline mode (the generator is stateless). */
  offlinePrompt = '';
  /** How many songs the offline generator has written in this conversation: the next one is a variation. */
  offlineSongs = 0;
  /** Stops the request in flight (asking, listening, following up). Null when none is running. */
  abort: AbortController | null = null;
  /** Stops the plugin build in flight. */
  buildAbort: AbortController | null = null;
  /** Stops the phrase an answer is auditioning (a new one replaces it). */
  stopAudition: (() => void) | null = null;
  /** Answers waiting for the musician's OK to change things outside the part, by message id. */
  readonly approvals = new Map<number, PendingApproval>();

  constructor(
    readonly services: Services,
    private readonly core: AssistantCore,
    environment: AssistantEnvironment,
  ) {
    this.fetchImpl = environment.fetchImpl;
    this.smoke = environment.smoke;
    this.analyzeMix = environment.analyzeMix;
    this.chat = new ClaudeChat(this.fetchImpl);
    this.store = core.store;
    lastIssuedMessageId = Math.max(lastIssuedMessageId, lastMessageId(this.store.getState().messages));
    this.restoreSavedConversation();
    core.bindExtras(() => ({
      chats: this.chat.sessions,
      catalogs: this.catalogSent,
      offlinePrompt: this.offlinePrompt,
    }));
  }

  /** Picks up what the previous page load saved (the AI conversations, which plugins they know, the offline prompt). */
  private restoreSavedConversation(): void {
    const { saved } = this.core;
    if (saved.chats) this.chat.sessions = saved.chats;
    if (saved.catalogs) this.catalogSent = { ...saved.catalogs };
    if (typeof saved.offlinePrompt === 'string') this.offlinePrompt = saved.offlinePrompt;
  }

  /** Writes this tab's conversation now (it also saves itself after changes and when the page hides). */
  saveTab(): void {
    this.core.saveTab();
  }

  /** Adds a line to the chat and returns its message id. */
  say(from: AssistantMessage['from'], text: string, extra: Partial<AssistantMessage> = {}): number {
    const id = ++lastIssuedMessageId;
    this.store.setState((state) => ({ messages: [...state.messages, { id, from, text, ...extra }] }));
    return id;
  }

  /** Asks which ways to reach an AI work right now, and keeps the answer in the store. */
  async checkAi(): Promise<AiStatus> {
    const status = await fetchAiStatus(this.fetchImpl);
    this.store.setState({ status });
    return status;
  }

  /** The way this request will reach an AI, or null for the offline generator. */
  async route(): Promise<AiBackend | null> {
    const { backend } = this.store.getState();
    if (backend === 'offline') return null;
    const status = this.store.getState().status ?? (await this.checkAi());
    if (backend !== 'auto') return backend;
    // Auto: the Claude subscription, then ChatGPT through Codex, then a Claude API key.
    if (status.subscription.ok) return 'subscription';
    if (status.codex.ok) return 'codex';
    if (status.api.ok) return 'api';
    return null;
  }

  /** The model id this backend is asked for (Claude's, or the typed Codex model; empty = Codex's default). */
  modelFor(route: AiBackend): string {
    const state = this.store.getState();
    return route === 'codex' ? state.codexModel : state.model;
  }

  /** Sets (or clears) the part of the song the conversation is about; follow-ups keep it. */
  setFocus(focus: AiFocus | null): void {
    if (this.store.getState().focus !== focus) this.store.setState({ focus });
  }

  /** Plugin names and settings, for the <focus> block's automation lines. */
  readonly pluginInfo = (pluginId: string) => {
    const definition = this.services.plugins.get(pluginId);
    return definition ? { name: definition.name, params: definition.params as ParamSpecs } : undefined;
  };

  /** "About Verse · bars 17–32" under the musician's message (or why the part was dropped). */
  aboutText(asked: AiFocus | null, focus: ResolvedFocus | null): string | undefined {
    if (focus) return `About ${focus.label}`;
    return asked ? 'The part you picked is no longer in the song, so this is about the whole song' : undefined;
  }

  /** Resolves true when no request is running (waits up to `waitMs` for one to finish). */
  untilIdle(waitMs: number): Promise<boolean> {
    if (this.store.getState().phase === 'idle') return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (isIdle: boolean) => {
        unsubscribe();
        clearTimeout(timer);
        resolve(isIdle);
      };
      const unsubscribe = this.store.subscribe((state) => {
        if (state.phase === 'idle') finish(true);
      });
      const timer = setTimeout(() => finish(false), waitMs);
    });
  }
}
