import { memo, type MouseEvent as ReactMouseEvent } from 'react';
import type { AssistantApi } from '@app/assistant/api';
import type { AssistantState } from '@app/assistant/assistant';
import { AI_MODELS, CODEX_MODELS, isCodexModel, type AiBackend } from '@app/assistant/claude';
import type { Services } from '@app/services';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import {
  activeBackend,
  autoLabel,
  BACKENDS,
  modelLabel,
  notSetUpReason,
  pillLabel,
  setupSuffix,
} from './backend-labels';
import { IDEAS } from './starter-ideas';
import styles from './Assistant.module.css';

/** Width (px) the options menu is assumed to have: it opens with its right edge under the ⋯ button, inside the window. */
const MENU_WIDTH_PX = 230;

/** "Other model…": a Codex model id typed in (empty = Codex's own default). */
async function askCodexModel(services: Services, state: AssistantState): Promise<void> {
  const values = await showFormDialog({
    title: 'Other ChatGPT model',
    message:
      'The Codex model id to use with your ChatGPT plan, for example gpt-5.5. Leave it empty for Codex’s own default.',
    fields: [{ kind: 'text', key: 'id', label: 'Model id', placeholder: 'gpt-5.5' }],
    values: { id: state.codexModel },
  });
  if (!values) return;
  const modelId = String(values.id ?? '')
    .trim()
    .toLowerCase();
  if (!isCodexModel(modelId)) {
    services.session
      .getState()
      .toast('A model id has letters, digits and . _ : - only (up to 64 characters).', 'error');
    return;
  }
  services.assistant.set({ codexModel: modelId });
}

/** The "Who answers" choices. */
function backendEntries(assistant: AssistantApi, state: AssistantState): MenuEntry[] {
  return [
    { kind: 'label', label: 'Who answers' },
    ...BACKENDS.map<MenuEntry>((option) => ({
      label: (option.value === 'auto' ? autoLabel(state) : option.label) + setupSuffix(option.value, state),
      checked: state.backend === option.value,
      hint: option.hint,
      onSelect: () => {
        assistant.set({ backend: option.value });
        void assistant.checkAi();
      },
    })),
  ];
}

/** The model choices of the AI that answers (nothing for the offline generator). */
function modelEntries(services: Services, state: AssistantState, backend: AiBackend | null): MenuEntry[] {
  const assistant = services.assistant;
  if (backend === 'codex') {
    return [
      { kind: 'separator' },
      { kind: 'label', label: 'Model' },
      ...CODEX_MODELS.map<MenuEntry>((model) => ({
        label: model.label,
        checked: state.codexModel === model.id,
        hint: 'Let Codex pick the model for your ChatGPT plan',
        onSelect: () => assistant.set({ codexModel: model.id }),
      })),
      {
        label: state.codexModel ? `Other model: ${state.codexModel}…` : 'Other model…',
        checked: state.codexModel !== '',
        hint: 'Type the id of a Codex model, for example gpt-5.5',
        onSelect: () => void askCodexModel(services, state),
      },
    ];
  }
  if (!backend) return [];
  return [
    { kind: 'separator' },
    { kind: 'label', label: 'Model' },
    ...AI_MODELS.map<MenuEntry>((model) => ({
      label: model.label,
      checked: state.model === model.id,
      hint: 'Which Claude model writes your beats',
      onSelect: () => assistant.set({ model: model.id }),
    })),
  ];
}

/** Auto-play, Check my mix, Ideas, reconnect and New chat. */
function actionEntries(assistant: AssistantApi, state: AssistantState, sendText: (text: string) => void): MenuEntry[] {
  const isBusy = state.phase !== 'idle';
  return [
    { kind: 'separator' },
    {
      label: 'Auto-play new beats',
      checked: state.autoplay,
      hint: 'Start playing each new beat right away',
      onSelect: () => assistant.set({ autoplay: !state.autoplay }),
    },
    {
      label: 'Check my mix',
      icon: 'studio',
      disabled: isBusy,
      hint: 'Studio listens to your mix (every mixer track: loudness, peaks, tone, width), tells you what it hears and improves it in one undoable step',
      onSelect: () => void assistant.checkMix(),
    },
    {
      kind: 'submenu',
      label: 'Ideas',
      disabled: isBusy,
      hint: 'Things to ask for, to get started',
      items: IDEAS.map<MenuEntry>((idea) => ({
        label: idea,
        hint: `Ask: "${idea}"`,
        onSelect: () => sendText(idea),
      })),
    },
    { kind: 'separator' },
    {
      label: 'Check the AI connection again',
      hint: 'Look again for your Claude subscription (Claude Code), your ChatGPT plan (Codex) and an API key',
      onSelect: () => void assistant.checkAi(),
    },
    {
      label: 'New chat',
      disabled: isBusy || state.messages.length === 0,
      hint: 'Start over: a new conversation (the next beat makes a new pattern)',
      onSelect: () => assistant.newBeat(),
    },
  ];
}

/** The header: who answers (a compact pill), whether it is set up, New chat and the ⋯ menu. */
export const Header = memo(function Header({
  state,
  sendText,
}: {
  state: AssistantState;
  sendText(text: string): void;
}) {
  const services = useServices();
  const assistant = services.assistant;
  const backend = activeBackend(state);
  const isBusy = state.phase !== 'idle';
  const notSetUp = notSetUpReason(state);

  const openMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const button = event.currentTarget.getBoundingClientRect();
    const entries = [
      ...backendEntries(assistant, state),
      ...modelEntries(services, state, backend),
      ...actionEntries(assistant, state, sendText),
    ];
    showContextMenu({ x: Math.max(4, button.right - MENU_WIDTH_PX), y: button.bottom + 4 }, entries);
  };

  return (
    <div className={styles.header}>
      <button
        className={styles.modelPill}
        onClick={openMenu}
        data-hint={
          backend
            ? `Answers come from ${modelLabel(state)}: click to change who answers or the model`
            : 'Answers come from the built-in offline generator: click to use your Claude subscription, your ChatGPT plan or an API key'
        }
      >
        <span className={`${styles.modelDot} ${backend ? styles.modelDotOn : ''}`} aria-hidden />
        {pillLabel(state)}
        <Icon name="chevronDown" size={9} className={styles.modelCaret} />
      </button>
      {notSetUp && (
        <button
          className={styles.offline}
          onClick={() => void assistant.checkAi()}
          data-hint={`${notSetUp} Click to check again.`}
        >
          Not set up
        </button>
      )}
      <span className={styles.spacer} />
      <button
        className={styles.headerButton}
        disabled={isBusy || state.messages.length === 0}
        onClick={() => assistant.newBeat()}
        data-hint="New chat: start over with a new conversation (the next beat makes a new pattern)"
        aria-label="New chat"
      >
        <Icon name="plus" size={13} />
      </button>
      <button
        className={styles.headerButton}
        onClick={openMenu}
        data-hint="Studio options: who answers, the model, auto-play, check my mix, ideas, new chat"
        aria-label="Studio options"
      >
        <span className={styles.dots}>⋯</span>
      </button>
    </div>
  );
});
