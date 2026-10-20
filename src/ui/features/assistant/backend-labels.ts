/** The words for who answers: the ways to reach an AI, which one is active now, the model's name and why one isn't set up. */
import { AI_MODELS, type AiBackend } from '@app/assistant/claude';
import type { AssistantState } from '@app/assistant/assistant';

/** The choices in the "Who answers" menu. */
export const BACKENDS: { value: AssistantState['backend']; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Your Claude subscription if it is set up, else your ChatGPT plan (Codex), else a Claude API key, else the offline generator',
  },
  {
    value: 'subscription',
    label: 'Claude (my subscription)',
    hint: 'Through Claude Code, signed in with your Claude account',
  },
  {
    value: 'codex',
    label: 'ChatGPT (my plan, via Codex)',
    hint: 'Through the Codex CLI (it comes with the ChatGPT app), signed in with your ChatGPT account',
  },
  { value: 'api', label: 'Claude (API key)', hint: 'Claude through an Anthropic API key' },
  {
    value: 'offline',
    label: 'Offline generator',
    hint: 'The built-in generator: beats, and whole songs (chords, bass, melody, drums and an arrangement) from words like "a sad trap song at 140". No AI, no network',
  },
];

/** What "Auto" resolves to right now, for the label. */
export function autoLabel(state: AssistantState): string {
  if (!state.status) return 'Auto (checking…)';
  if (state.status.subscription.ok) return 'Auto: my Claude subscription';
  if (state.status.codex.ok) return 'Auto: my ChatGPT plan (Codex)';
  if (state.status.api.ok) return 'Auto: Claude API key';
  return 'Auto: offline generator';
}

/** The AI that answers right now (null: the offline generator, or still checking). */
export function activeBackend(state: AssistantState): AiBackend | null {
  if (state.backend === 'subscription' || state.backend === 'api' || state.backend === 'codex') return state.backend;
  if (state.backend === 'offline' || !state.status) return null;
  if (state.status.subscription.ok) return 'subscription';
  if (state.status.codex.ok) return 'codex';
  if (state.status.api.ok) return 'api';
  return null;
}

/** The model that answers, as a full label for the tooltip ("Claude Opus 5.5 (best)", "ChatGPT gpt-5.5"). */
export function modelLabel(state: AssistantState): string {
  if (activeBackend(state) === 'codex') {
    return state.codexModel ? `ChatGPT ${state.codexModel}` : 'ChatGPT (Codex default model)';
  }
  return AI_MODELS.find((model) => model.id === state.model)?.label ?? state.model;
}

/** The model pill's text: "Opus 5.5", "ChatGPT", "Offline", "Checking…". */
export function pillLabel(state: AssistantState): string {
  if (state.backend === 'auto' && !state.status) return 'Checking…';
  const backend = activeBackend(state);
  if (!backend) return 'Offline';
  if (backend === 'codex') return state.codexModel || 'ChatGPT';
  return modelLabel(state)
    .replace(/^Claude /, '')
    .replace(/\s*\(.*\)$/, '');
}

/** Why the chosen way to reach an AI doesn't work yet, in words for the musician (undefined when it does or is unknown). */
export function notSetUpReason(state: AssistantState): string | undefined {
  const status = state.status;
  if (state.backend === 'subscription') return status?.subscription.reason;
  if (state.backend === 'codex') return status?.codex.reason;
  if (state.backend === 'api') return status?.api.reason;
  const isNoneSetUp = status && !status.subscription.ok && !status.codex.ok && !status.api.ok;
  if (state.backend === 'auto' && isNoneSetUp) {
    return `To use an AI: ${status.subscription.reason ?? 'sign in to Claude Code'} Or, for ChatGPT: ${status.codex.reason ?? 'sign in to Codex'}`;
  }
  return undefined;
}

/** The "(not set up)" suffix a backend's menu entry carries when the last check found it unusable. */
export function setupSuffix(backend: AssistantState['backend'], state: AssistantState): string {
  const status = state.status;
  if (!status) return '';
  if (backend === 'subscription' && !status.subscription.ok) return ' (not set up)';
  if (backend === 'codex' && !status.codex.ok) return ' (not set up)';
  if (backend === 'api' && !status.api.ok) return ' (no key)';
  return '';
}
