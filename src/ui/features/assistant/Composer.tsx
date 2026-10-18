import type { RefObject } from 'react';
import type { AssistantState } from '@app/assistant/assistant';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { chipHint } from '../ask-ai/chips';
import { FocusChip } from './FocusChip';
import styles from './Assistant.module.css';

/** Quick requests about the part shown as chips (the rest behind ⋯). */
const SHOWN_CHIPS = 3;

/** What the box asks for, by what the conversation has: a take, a part, or nothing yet. */
function placeholderFor(state: AssistantState, partLabel: string | null): string {
  if (state.take) return 'What should your take become? e.g. "808s like this, dark trap at 140"';
  if (partLabel) return `What should change in ${partLabel}?`;
  return 'Describe a beat, or any change…';
}

/** Quick requests about the part the conversation is about: the first few as chips, the rest in a menu. */
function IdeaChips({
  chips,
  partLabel,
  isBusy,
  send,
}: {
  chips: readonly string[];
  partLabel: string | null;
  isBusy: boolean;
  send(text: string): void;
}) {
  return (
    <div className={styles.ideas}>
      {chips.slice(0, SHOWN_CHIPS).map((idea) => (
        <button
          key={idea}
          className={styles.idea}
          disabled={isBusy}
          onClick={() => send(idea)}
          data-hint={chipHint(idea, partLabel)}
        >
          {idea}
        </button>
      ))}
      {chips.length > SHOWN_CHIPS && (
        <button
          className={styles.idea}
          disabled={isBusy}
          onClick={(event) => {
            const button = event.currentTarget.getBoundingClientRect();
            const rest = chips.slice(SHOWN_CHIPS).map((idea) => ({
              label: idea,
              hint: chipHint(idea, partLabel),
              onSelect: () => send(idea),
            }));
            showContextMenu({ x: button.left, y: button.bottom + 4 }, rest);
          }}
          data-hint={`More things to ask about ${partLabel}`}
          aria-label="More ideas"
        >
          ⋯
        </button>
      )}
    </div>
  );
}

/** The Perform toggle and the Send / Stop button under the box. */
function FieldBar({
  state,
  prompt,
  isPerformOpen,
  isPerformHeld,
  onTogglePerform,
  send,
}: {
  state: AssistantState;
  prompt: string;
  isPerformOpen: boolean;
  isPerformHeld: boolean;
  onTogglePerform(): void;
  send(): void;
}) {
  const assistant = useServices().assistant;
  const isBusy = state.phase !== 'idle';
  const isWaiting = state.phase === 'thinking' || state.phase === 'listening';
  let performHint = 'Perform part of a beat: beatbox the drums or hum an 808 line or melody into your microphone';
  if (isPerformHeld) performHint = 'The performance controls stay open while you have a take (Clear it to close them)';
  else if (isPerformOpen) performHint = 'Hide the performance controls';
  return (
    <div className={styles.fieldBar}>
      <button
        className={`${styles.performToggle} ${isPerformOpen ? styles.performOn : ''}`}
        onClick={onTogglePerform}
        disabled={isPerformHeld}
        aria-pressed={isPerformOpen}
        data-hint={performHint}
      >
        <Icon name="mic" size={12} />
        Perform
      </button>
      <span className={styles.spacer} />
      {isWaiting ? (
        <button
          className={`${styles.sendButton} ${styles.sendStop}`}
          onClick={() => assistant.cancel()}
          data-hint="Stop waiting (Esc in the box does the same)"
          aria-label="Stop"
        >
          <Icon name="stop" size={12} />
        </button>
      ) : (
        <button
          className={`${styles.sendButton} ${styles.sendReady}`}
          disabled={isBusy || (!prompt.trim() && !state.take)}
          onClick={send}
          data-hint="Send (Enter)"
          aria-label="Send"
        >
          <Icon name="send" size={13} />
        </button>
      )}
    </div>
  );
}

/** What the composer needs from the window. */
export interface ComposerProps {
  state: AssistantState;
  /** The box's text. */
  prompt: string;
  onPromptChange(text: string): void;
  /** Sends the box's text, or `text` when given (a chip). */
  send(text?: string): void;
  /** The label of the part the conversation is about, when it is still in the song. */
  partLabel: string | null;
  /** Quick requests about that part. */
  chips: readonly string[];
  isPerformOpen: boolean;
  isPerformHeld: boolean;
  onTogglePerform(): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/** The compose area: idea chips for the part, the box (with the part chip) and the Perform / Send bar. */
export function Composer(props: ComposerProps) {
  const { state, prompt, send, partLabel, chips, inputRef } = props;
  const assistant = useServices().assistant;
  const isBusy = state.phase !== 'idle';
  const isWaiting = state.phase === 'thinking' || state.phase === 'listening';
  return (
    <div className={styles.compose}>
      {chips.length > 0 && <IdeaChips chips={chips} partLabel={partLabel} isBusy={isBusy} send={send} />}
      <div className={`${styles.field} ${isBusy ? styles.fieldBusy : ''}`}>
        <FocusChip />
        <textarea
          ref={inputRef}
          className={styles.prompt}
          rows={2}
          value={prompt}
          placeholder={placeholderFor(state, partLabel)}
          onChange={(event) => props.onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an input-method choice (Japanese, Chinese, Korean…) isn't a send.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            } else if (event.key === 'Escape' && isWaiting) {
              event.preventDefault();
              assistant.cancel();
            }
          }}
          data-hint="Describe the beat or the change you want; Enter sends, Shift+Enter makes a new line, Esc stops Studio while it works"
        />
        <FieldBar
          state={state}
          prompt={prompt}
          isPerformOpen={props.isPerformOpen}
          isPerformHeld={props.isPerformHeld}
          onTogglePerform={props.onTogglePerform}
          send={() => send()}
        />
      </div>
    </div>
  );
}
