import { memo, useEffect, useRef, useState } from 'react';
import type { AssistantState } from '@app/assistant/assistant';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { Message } from './Message';
import { STARTERS } from './starter-ideas';
import styles from './Assistant.module.css';

/** How often (ms) the "Working on it…" seconds counter ticks. */
const THINKING_TICK_MS = 500;
/** How often (ms) the plugin builder's seconds counter ticks. */
const BUILDING_TICK_MS = 1000;
/** A counter shows only after this many seconds: quick answers don't flash one. */
const SECONDS_SHOWN_AFTER = 2;
/** The plugin builder fixes what its checks found in at most this many rounds. */
const MAX_FIX_ROUNDS = 3;

const BUILD_STAGES: Record<NonNullable<AssistantState['building']>['stage'], string> = {
  writing: 'Writing the code',
  checking: 'Checking the code',
  testing: 'Test-rendering it',
  fixing: 'Fixing what the checks found',
};

/** Whole seconds since mount, updated every `tickMs`. */
function useSecondsSinceMount(tickMs: number): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = performance.now();
    const timer = setInterval(() => setSeconds(Math.floor((performance.now() - startedAt) / 1000)), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return seconds;
}

/** What an empty conversation says: what to ask, with a few ways to start. */
function Intro({ isBusy, sendText }: { isBusy: boolean; sendText(text: string): void }) {
  const services = useServices();
  return (
    <div className={styles.intro}>
      <span className={styles.introMark} aria-hidden>
        <Icon name="studio" size={18} />
      </span>
      <p className={styles.introLine}>
        Ask for anything: a beat, or a change to the mixer, plugins, routing, tempo or arrangement.
      </p>
      <div className={styles.starters}>
        <button
          className={`${styles.idea} ${styles.ideaMain}`}
          disabled={isBusy}
          onClick={() => void services.assistant.checkMix()}
          data-hint="Studio listens to your mix (every mixer track: loudness, peaks, tone, width), tells you what it hears and improves it in one undoable step"
        >
          <Icon name="studio" size={13} /> Check my mix
        </button>
        {STARTERS.map((idea) => (
          <button
            key={idea}
            className={styles.idea}
            disabled={isBusy}
            onClick={() => sendText(idea)}
            data-hint={`Ask: "${idea}"`}
          >
            {idea}
          </button>
        ))}
      </div>
      <p className={styles.introFoot}>
        Every answer is one undo step. More ideas in ⋯; to beatbox or hum, press Perform.
      </p>
    </div>
  );
}

/** A mix analysis at work: which track it is rendering. */
function Listening({ listening }: { listening: NonNullable<AssistantState['listening']> }) {
  const services = useServices();
  return (
    <div className={styles.message}>
      <div className={`${styles.card} ${styles.thinking}`}>
        <Icon name="wave" size={12} className={styles.spark} />
        <span className={styles.shimmer}>
          Listening to your mix: {listening.label} ({Math.round(listening.fraction * 100)}%)…
        </span>
        <button className={styles.ghost} onClick={() => services.assistant.cancel()} data-hint="Stop listening">
          Stop
        </button>
      </div>
    </div>
  );
}

/** The plugin builder at work: what it is doing now, and a way to stop it. */
function Building({ building }: { building: NonNullable<AssistantState['building']> }) {
  const services = useServices();
  const seconds = useSecondsSinceMount(BUILDING_TICK_MS);
  return (
    <div className={styles.message}>
      <div className={`${styles.card} ${styles.thinking}`}>
        <Icon name="plug" size={12} className={styles.spark} />
        <span className={styles.shimmer}>
          Building the {building.kind} “{building.name}”: {BUILD_STAGES[building.stage].toLowerCase()}
          {building.round > 0 ? ` (fix ${building.round} of ${MAX_FIX_ROUNDS})` : ''}…
        </span>
        {seconds > SECONDS_SHOWN_AFTER && <span className={styles.seconds}>{seconds}s</span>}
        <button
          className={styles.ghost}
          onClick={() => services.assistant.cancelBuild()}
          data-hint="Stop building this plugin"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

/** "Working on it…" while the AI answers. */
function Thinking() {
  const seconds = useSecondsSinceMount(THINKING_TICK_MS);
  return (
    <div className={styles.message}>
      <div className={`${styles.card} ${styles.thinking}`}>
        <Icon name="studio" size={13} className={styles.spark} />
        <span className={styles.shimmer}>Working on it…</span>
        {seconds > SECONDS_SHOWN_AFTER && <span className={styles.seconds}>{seconds}s</span>}
      </div>
    </div>
  );
}

/** The conversation: the intro or the messages, then what Studio is doing now. Scrolls to the newest line. */
export const Conversation = memo(function Conversation({
  state,
  sendText,
}: {
  state: AssistantState;
  sendText(text: string): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const isBusy = state.phase !== 'idle';
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages.length, state.phase]);
  return (
    <div className={styles.messages} ref={scroller}>
      {state.messages.length === 0 && <Intro isBusy={isBusy} sendText={sendText} />}
      {state.messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {state.phase === 'thinking' && <Thinking />}
      {state.phase === 'listening' && state.listening && <Listening listening={state.listening} />}
      {state.building && <Building building={state.building} />}
    </div>
  );
});
