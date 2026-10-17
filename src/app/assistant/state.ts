import { createStore, type StoreApi } from 'zustand/vanilla';
import type { PerformanceRole } from '@core/beat/local';
import type { History } from '@core/history/history';
import type { GridEvent } from '@core/voice';
import type { AfterEdit } from '../ai/ops/types';
import type { BuildStage, PluginDraft } from '../ai/builder';
import { isAiFocus, type AiFocus } from '../ai/focus';
import type { AppliedBeat } from './apply';
import type { AiBackend, AiSessions, AiStatus } from './claude';

/**
 * What the toolbar and the Studio window read before any Studio code has loaded: the state store (the
 * conversation, settings and the part being asked about), its persistence and the model list. The
 * assistant itself (`assistant.ts`, with the AI ops, arrange, voice and mix code behind it) loads on
 * first use; see `facade.ts`.
 */

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest)' },
] as const;
export const DEFAULT_MODEL = AI_MODELS[0].id;

/** The models listed for ChatGPT (Codex): its own default, or a typed model id ("Other model…"). */
export const CODEX_MODELS = [{ id: '', label: 'Codex default' }] as const;
/** What the server accepts as a Codex model id (empty = Codex's own default). */
export const CODEX_MODEL_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
export const isCodexModel = (id: unknown): id is string => id === '' || (typeof id === 'string' && CODEX_MODEL_ID.test(id));

export type AssistantPhase = 'idle' | 'counting-in' | 'recording' | 'analyzing' | 'listening' | 'thinking';

export interface AssistantMessage {
  id: number;
  from: 'you' | 'assistant';
  text: string;
  /** Small print under the text (what was recorded, which tracks were written). */
  detail?: string;
  error?: boolean;
  /** Made without an AI (offline generator). */
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
  /** What `query` actions asked to look at, as text. */
  lookups?: string;
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
  /** The AI has it already (sent with an earlier request). */
  sent: boolean;
}

export interface AssistantState {
  phase: AssistantPhase;
  messages: AssistantMessage[];
  take: Take | null;
  /** Live recording: count-in/progress for the UI. */
  recording: { bars: number; startedAt: number } | null;
  /** Which ways to reach an AI work (null until checked). */
  status: AiStatus | null;
  /** How to reach the AI: auto = the Claude subscription, else ChatGPT (Codex), else a Claude API key, else the offline generator. */
  backend: 'auto' | AiBackend | 'offline';
  /** The Claude model (for the subscription and the API key). */
  model: string;
  /** The ChatGPT (Codex) model id; empty = Codex's own default. */
  codexModel: string;
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

/** What a reload keeps besides the store: the assistant's own bookkeeping (it owns these once it has loaded). */
export interface TabExtras {
  /** The AI conversation of each backend. */
  chats?: AiSessions;
  /** Catalog key each backend's conversation has. */
  catalogs?: Partial<Record<AiBackend, string>>;
  /** Everything asked so far in offline mode. */
  offlinePrompt?: string;
}

/** Highest message id in a conversation (new ids continue after it). */
export function lastMessageId(messages: readonly AssistantMessage[]): number {
  return messages.reduce((n, m) => Math.max(n, typeof m.id === 'number' ? m.id : 0), 0);
}

export interface AssistantCore {
  readonly store: StoreApi<AssistantState>;
  /** The bookkeeping restored from this tab's last session. */
  readonly saved: TabExtras;
  /** The assistant says where to read its bookkeeping from when the tab is saved. */
  bindExtras(read: () => TabExtras): void;
  /** Writes the tab's conversation now (also on a timer after changes and on pagehide). */
  saveTab(): void;
}

/**
 * The state store with everything that survives a reload (settings in localStorage, this tab's conversation in
 * sessionStorage). Cheap and DOM-light: created at startup so the toolbar and windows can subscribe before
 * the assistant's code has loaded.
 */
export function createAssistantCore(history: Pick<History, 'onChange'>): AssistantCore {
  const saved = loadPrefs();
  const store = createStore<AssistantState>()(() => ({
    phase: 'idle',
    messages: [],
    take: null,
    recording: null,
    status: null,
    backend:
      saved.backend === 'subscription' ||
      saved.backend === 'api' ||
      saved.backend === 'codex' ||
      saved.backend === 'offline'
        ? saved.backend
        : 'auto',
    model: typeof saved.model === 'string' ? saved.model : DEFAULT_MODEL,
    codexModel: isCodexModel(saved.codexModel) ? saved.codexModel : '',
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
  const extras: TabExtras = {};
  let readExtras: () => TabExtras = () => extras;

  // A reload starts a new history that numbers its steps from 1 again: the undo points of the old
  // session would point at unrelated steps, so the answers keep their text but lose their Undo.
  let raw: unknown;
  try {
    raw = JSON.parse(globalThis.sessionStorage?.getItem(TAB_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Partial<{
      messages: AssistantMessage[];
      applied: AppliedBeat;
      take: Take;
      chats: unknown;
      catalogs: unknown;
      offlinePrompt: string;
      focus: unknown;
    }>;
    const messages = (Array.isArray(r.messages) ? r.messages.filter((m) => typeof m?.text === 'string') : []).map(
      ({ undo: _undo, ...m }) => (m.beat ? { ...m, beat: { ...m.beat, cursor: -1 } } : m),
    );
    const applied = r.applied && typeof r.applied.patternId === 'string' && r.applied.channels ? r.applied : null;
    const take = r.take && Array.isArray(r.take.events) ? { ...r.take, audio: null } : null;
    const focus = isAiFocus(r.focus) ? r.focus : null;
    store.setState({ messages, applied, take, focus });
    // Only what a backend name maps to as text is kept (the older single-session format is dropped).
    const strings = (v: unknown): Partial<Record<AiBackend, string>> => {
      const out: Partial<Record<AiBackend, string>> = {};
      if (typeof v === 'object' && v !== null)
        for (const b of ['subscription', 'api', 'codex'] as const) {
          const x = (v as Record<string, unknown>)[b];
          if (typeof x === 'string' && x) out[b] = x;
        }
      return out;
    };
    if (r.chats) extras.chats = strings(r.chats);
    if (r.catalogs) extras.catalogs = strings(r.catalogs);
    if (typeof r.offlinePrompt === 'string') extras.offlinePrompt = r.offlinePrompt;
  }

  // Another project opened (or a new one): the part belonged to the old one.
  history.onChange(({ origin, next }) => {
    const f = store.getState().focus;
    if (origin === 'load' && f && f.projectId !== next.projectId) store.setState({ focus: null });
  });

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** This tab's conversation, current beat and take (without the audio) for a page reload. */
  const saveTab = (): void => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const { messages, applied, take, focus } = store.getState();
    try {
      globalThis.sessionStorage?.setItem(
        TAB_KEY,
        JSON.stringify({
          messages: messages.slice(-40),
          applied,
          take: take ? { ...take, audio: null } : null,
          focus,
          ...readExtras(),
        }),
      );
    } catch {
      /* storage full or unavailable: the conversation just won't survive a reload */
    }
  };
  store.subscribe(() => {
    if (saveTimer === undefined) saveTimer = setTimeout(saveTab, 500);
  });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', saveTab);

  store.subscribe((next, prev) => {
    if (
      next.backend === prev.backend &&
      next.model === prev.model &&
      next.codexModel === prev.codexModel &&
      next.role === prev.role &&
      next.bars === prev.bars &&
      next.playAlong === prev.playAlong &&
      next.click === prev.click &&
      next.autoplay === prev.autoplay &&
      next.mySounds === prev.mySounds
    )
      return;
    try {
      const { backend, model, codexModel, role, bars, playAlong, click, autoplay, mySounds } = next;
      globalThis.localStorage?.setItem(
        PREFS_KEY,
        JSON.stringify({ backend, model, codexModel, role, bars, playAlong, click, autoplay, mySounds }),
      );
    } catch {
      /* per-browser convenience only */
    }
  });

  return {
    store,
    saved: extras,
    bindExtras(read) {
      readExtras = read;
    },
    saveTab,
  };
}
