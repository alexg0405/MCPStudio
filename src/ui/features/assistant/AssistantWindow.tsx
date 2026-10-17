import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { AI_MODELS, CODEX_MODELS, isCodexModel, type AiBackend } from '@app/assistant/claude';
import type { AssistantState } from '@app/assistant/assistant';
import { resolveFocus } from '@app/ai/focus';
import type { PerformanceRole } from '@core/beat/local';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';
import { Icon } from '../../controls/Icon';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { quickChips, chipHint } from '../ask-ai/chips';
import { assistantDraft, clearAssistantDraft } from './draft-state';
import { FocusChip } from './FocusChip';
import { Message } from './Message';
import { TakeView } from './TakeView';
import styles from './Assistant.module.css';

const ROLES: { value: PerformanceRole; label: string }[] = [
  { value: 'auto', label: 'Figure it out' },
  { value: 'drums', label: 'Drums (beatbox)' },
  { value: '808', label: '808 line (hum)' },
  { value: 'melody', label: 'Melody (hum)' },
];

const IDEAS = [
  'Dark trap at 140, 808s that slide',
  'Boom bap at 90 with swing',
  'Drill with sliding 808s',
  'Busier hats',
  'More 808 slides',
  'Put the snare on its own track with a plate reverb',
  'Make a reverb bus and send the lead to it',
  'Swap the lead for a pluck',
  'Turn the 808 down 3 dB',
  'Arrange it: 4 bars, then 8 bars with the hats',
];

/** The first ideas a new conversation offers (the rest are in the ⋯ menu under Ideas). */
const STARTERS = IDEAS.slice(0, 3);
/** Quick requests about the part shown as chips (the rest behind ⋯). */
const SHOWN_CHIPS = 3;

export function AssistantWindow() {
  const services = useServices();
  const a = services.assistant;
  const st = useStore(a.store);
  // Text handed over from elsewhere (the Ask AI card's "Open in AI studio") starts the box.
  const [prompt, setPrompt] = useState(() => assistantDraft.getState().text);
  // The performance strip (record, bars, what the noises are…) shows only when asked for.
  const [perform, setPerform] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // The part the conversation is about, if it is still in the song (its label, for the idea chips).
  const part = useStore(services.doc, (d) => (st.focus ? (resolveFocus(d.project, st.focus)?.label ?? null) : null));

  useEffect(() => {
    if (a.store.getState().status === null) void a.checkAi();
  }, [a]);

  useEffect(() => {
    if (assistantDraft.getState().text) clearAssistantDraft();
    return assistantDraft.subscribe(({ text }) => {
      if (!text) return;
      setPrompt(text);
      clearAssistantDraft();
      input.current?.focus();
    });
  }, []);

  const busy = st.phase !== 'idle';
  const send = (text = prompt) => {
    if (busy || (!text.trim() && !st.take)) return;
    setPrompt('');
    void a.send(text);
  };
  // The header and the conversation get one `send` for good (it reads the latest through a ref), so typing in the
  // box re-renders the box and not the whole conversation.
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  const sendText = useCallback((text: string) => sendRef.current(text), []);
  const live = st.phase === 'counting-in' || st.phase === 'recording';
  // A take, a recording or its analysis keeps the strip open.
  const held = live || st.phase === 'analyzing' || !!st.take;
  const showPerform = perform || held;
  const chips = part ? quickChips(st.focus) : [];

  return (
    <div className={styles.assistant}>
      <Header st={st} send={sendText} />
      <Messages st={st} send={sendText} />
      {showPerform && <Performance st={st} />}
      <div className={styles.compose}>
        {chips.length > 0 && (
          <div className={styles.ideas}>
            {chips.slice(0, SHOWN_CHIPS).map((idea) => (
              <button
                key={idea}
                className={styles.idea}
                disabled={busy}
                onClick={() => send(idea)}
                data-hint={chipHint(idea, part)}
              >
                {idea}
              </button>
            ))}
            {chips.length > SHOWN_CHIPS && (
              <button
                className={styles.idea}
                disabled={busy}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  showContextMenu(
                    { x: r.left, y: r.bottom + 4 },
                    chips.slice(SHOWN_CHIPS).map((idea) => ({
                      label: idea,
                      hint: chipHint(idea, part),
                      onSelect: () => send(idea),
                    })),
                  );
                }}
                data-hint={`More things to ask about ${part}`}
                aria-label="More ideas"
              >
                ⋯
              </button>
            )}
          </div>
        )}
        <div className={`${styles.field} ${busy ? styles.fieldBusy : ''}`}>
          <FocusChip />
          <textarea
            ref={input}
            className={styles.prompt}
            rows={2}
            value={prompt}
            placeholder={
              st.take
                ? 'What should your take become? e.g. "808s like this, dark trap at 140"'
                : part
                  ? `What should change in ${part}?`
                  : 'Describe a beat, or any change…'
            }
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter that confirms an input-method choice (Japanese, Chinese, Korean…) isn't a send.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === 'Escape' && (st.phase === 'thinking' || st.phase === 'listening')) {
                e.preventDefault();
                a.cancel();
              }
            }}
            data-hint="Describe the beat or the change you want; Enter sends, Shift+Enter makes a new line, Esc stops Studio while it works"
          />
          <div className={styles.fieldBar}>
            <button
              className={`${styles.performToggle} ${showPerform ? styles.performOn : ''}`}
              onClick={() => setPerform(!showPerform)}
              disabled={held}
              aria-pressed={showPerform}
              data-hint={
                held
                  ? 'The performance controls stay open while you have a take (Clear it to close them)'
                  : showPerform
                    ? 'Hide the performance controls'
                    : 'Perform part of a beat: beatbox the drums or hum an 808 line or melody into your microphone'
              }
            >
              <Icon name="mic" size={12} />
              Perform
            </button>
            <span className={styles.spacer} />
            {st.phase === 'thinking' || st.phase === 'listening' ? (
              <button
                className={`${styles.sendButton} ${styles.sendStop}`}
                onClick={() => a.cancel()}
                data-hint="Stop waiting (Esc in the box does the same)"
                aria-label="Stop"
              >
                <Icon name="stop" size={12} />
              </button>
            ) : (
              <button
                className={`${styles.sendButton} ${styles.sendReady}`}
                disabled={busy || (!prompt.trim() && !st.take)}
                onClick={() => send()}
                data-hint="Send (Enter)"
                aria-label="Send"
              >
                <Icon name="send" size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const BACKENDS: { value: AssistantState['backend']; label: string; hint: string }[] = [
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
  { value: 'offline', label: 'Offline generator', hint: 'The built-in beat generator: no AI, no network' },
];

/** What "Auto" resolves to right now, for the label. */
function autoLabel(st: AssistantState): string {
  if (!st.status) return 'Auto (checking…)';
  if (st.status.subscription.ok) return 'Auto: my Claude subscription';
  if (st.status.codex.ok) return 'Auto: my ChatGPT plan (Codex)';
  if (st.status.api.ok) return 'Auto: Claude API key';
  return 'Auto: offline generator';
}

/** The AI that answers right now (null: the offline generator, or still checking). */
function activeBackend(st: AssistantState): AiBackend | null {
  if (st.backend === 'subscription' || st.backend === 'api' || st.backend === 'codex') return st.backend;
  if (st.backend === 'offline' || !st.status) return null;
  if (st.status.subscription.ok) return 'subscription';
  if (st.status.codex.ok) return 'codex';
  if (st.status.api.ok) return 'api';
  return null;
}

const modelLabel = (st: AssistantState): string =>
  activeBackend(st) === 'codex'
    ? st.codexModel
      ? `ChatGPT ${st.codexModel}`
      : 'ChatGPT (Codex default model)'
    : (AI_MODELS.find((m) => m.id === st.model)?.label ?? st.model);

/** The model pill's text: "Opus 5.5", "ChatGPT", "Offline", "Checking…". */
function pillLabel(st: AssistantState): string {
  if (st.backend === 'auto' && !st.status) return 'Checking…';
  const backend = activeBackend(st);
  if (!backend) return 'Offline';
  if (backend === 'codex') return st.codexModel || 'ChatGPT';
  return modelLabel(st)
    .replace(/^Claude /, '')
    .replace(/\s*\(.*\)$/, '');
}

/** Why the chosen way to reach an AI doesn't work yet, in words for the musician (undefined when it does or is unknown). */
function notSetUp(st: AssistantState): string | undefined {
  const s = st.status;
  if (st.backend === 'subscription') return s?.subscription.reason;
  if (st.backend === 'codex') return s?.codex.reason;
  if (st.backend === 'api') return s?.api.reason;
  if (st.backend === 'auto' && s && !s.subscription.ok && !s.codex.ok && !s.api.ok)
    return `To use an AI: ${s.subscription.reason ?? 'sign in to Claude Code'} Or, for ChatGPT: ${s.codex.reason ?? 'sign in to Codex'}`;
  return undefined;
}

/** The header: who answers (a compact pill), whether it is set up, New chat and the ⋯ menu. */
const Header = memo(function Header({ st, send }: { st: AssistantState; send(text: string): void }) {
  const services = useServices();
  const a = services.assistant;
  const backend = activeBackend(st);
  const busy = st.phase !== 'idle';
  const reason = notSetUp(st);

  /** "Other model…": a Codex model id typed in (empty = Codex's own default). */
  const askCodexModel = async () => {
    const values = await showFormDialog({
      title: 'Other ChatGPT model',
      message: 'The Codex model id to use with your ChatGPT plan, for example gpt-5.5. Leave it empty for Codex’s own default.',
      fields: [{ kind: 'text', key: 'id', label: 'Model id', placeholder: 'gpt-5.5' }],
      values: { id: st.codexModel },
    });
    if (!values) return;
    const id = String(values.id ?? '').trim().toLowerCase();
    if (!isCodexModel(id))
      return services.session.getState().toast('A model id has letters, digits and . _ : - only (up to 64 characters).', 'error');
    a.set({ codexModel: id });
  };

  const menu = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const entries: MenuEntry[] = [
      { kind: 'label', label: 'Who answers' },
      ...BACKENDS.map<MenuEntry>((b) => ({
        label:
          (b.value === 'auto' ? autoLabel(st) : b.label) +
          (b.value === 'subscription' && st.status && !st.status.subscription.ok ? ' (not set up)' : '') +
          (b.value === 'codex' && st.status && !st.status.codex.ok ? ' (not set up)' : '') +
          (b.value === 'api' && st.status && !st.status.api.ok ? ' (no key)' : ''),
        checked: st.backend === b.value,
        hint: b.hint,
        onSelect: () => {
          a.set({ backend: b.value });
          void a.checkAi();
        },
      })),
    ];
    if (backend === 'codex')
      entries.push(
        { kind: 'separator' },
        { kind: 'label', label: 'Model' },
        ...CODEX_MODELS.map<MenuEntry>((m) => ({
          label: m.label,
          checked: st.codexModel === m.id,
          hint: 'Let Codex pick the model for your ChatGPT plan',
          onSelect: () => a.set({ codexModel: m.id }),
        })),
        {
          label: st.codexModel ? `Other model: ${st.codexModel}…` : 'Other model…',
          checked: st.codexModel !== '',
          hint: 'Type the id of a Codex model, for example gpt-5.5',
          onSelect: () => void askCodexModel(),
        },
      );
    else if (backend)
      entries.push(
        { kind: 'separator' },
        { kind: 'label', label: 'Model' },
        ...AI_MODELS.map<MenuEntry>((m) => ({
          label: m.label,
          checked: st.model === m.id,
          hint: 'Which Claude model writes your beats',
          onSelect: () => a.set({ model: m.id }),
        })),
      );
    entries.push(
      { kind: 'separator' },
      {
        label: 'Auto-play new beats',
        checked: st.autoplay,
        hint: 'Start playing each new beat right away',
        onSelect: () => a.set({ autoplay: !st.autoplay }),
      },
      {
        label: 'Check my mix',
        icon: 'studio',
        disabled: busy,
        hint: 'Studio listens to your mix (every mixer track: loudness, peaks, tone, width), tells you what it hears and improves it in one undoable step',
        onSelect: () => void a.checkMix(),
      },
      {
        kind: 'submenu',
        label: 'Ideas',
        disabled: busy,
        hint: 'Things to ask for, to get started',
        items: IDEAS.map<MenuEntry>((idea) => ({ label: idea, hint: `Ask: "${idea}"`, onSelect: () => send(idea) })),
      },
      { kind: 'separator' },
      {
        label: 'Check the AI connection again',
        hint: 'Look again for your Claude subscription (Claude Code), your ChatGPT plan (Codex) and an API key',
        onSelect: () => void a.checkAi(),
      },
      {
        label: 'New chat',
        disabled: busy || st.messages.length === 0,
        hint: 'Start over: a new conversation (the next beat makes a new pattern)',
        onSelect: () => a.newBeat(),
      },
    );
    showContextMenu({ x: Math.max(4, r.right - 230), y: r.bottom + 4 }, entries);
  };

  return (
    <div className={styles.header}>
      <button
        className={styles.modelPill}
        onClick={menu}
        data-hint={
          backend
            ? `Answers come from ${modelLabel(st)}: click to change who answers or the model`
            : 'Answers come from the built-in offline generator: click to use your Claude subscription, your ChatGPT plan or an API key'
        }
      >
        <span className={`${styles.modelDot} ${backend ? styles.modelDotOn : ''}`} aria-hidden />
        {pillLabel(st)}
        <Icon name="chevronDown" size={9} className={styles.modelCaret} />
      </button>
      {reason && (
        <button
          className={styles.offline}
          onClick={() => void a.checkAi()}
          data-hint={`${reason} Click to check again.`}
        >
          Not set up
        </button>
      )}
      <span className={styles.spacer} />
      <button
        className={styles.headerButton}
        disabled={busy || st.messages.length === 0}
        onClick={() => a.newBeat()}
        data-hint="New chat: start over with a new conversation (the next beat makes a new pattern)"
        aria-label="New chat"
      >
        <Icon name="plus" size={13} />
      </button>
      <button
        className={styles.headerButton}
        onClick={menu}
        data-hint="Studio options: who answers, the model, auto-play, check my mix, ideas, new chat"
        aria-label="Studio options"
      >
        <span className={styles.dots}>⋯</span>
      </button>
    </div>
  );
});

const Messages = memo(function Messages({ st, send }: { st: AssistantState; send(text: string): void }) {
  const services = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const busy = st.phase !== 'idle';
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [st.messages.length, st.phase]);
  return (
    <div className={styles.messages} ref={ref}>
      {st.messages.length === 0 && (
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
              disabled={busy}
              onClick={() => void services.assistant.checkMix()}
              data-hint="Studio listens to your mix (every mixer track: loudness, peaks, tone, width), tells you what it hears and improves it in one undoable step"
            >
              <Icon name="studio" size={13} /> Check my mix
            </button>
            {STARTERS.map((idea) => (
              <button
                key={idea}
                className={styles.idea}
                disabled={busy}
                onClick={() => send(idea)}
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
      )}
      {st.messages.map((m) => (
        <Message key={m.id} m={m} />
      ))}
      {st.phase === 'thinking' && <Thinking />}
      {st.phase === 'listening' && st.listening && <Listening listening={st.listening} />}
      {st.building && <Building building={st.building} />}
    </div>
  );
});

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

const STAGES: Record<NonNullable<AssistantState['building']>['stage'], string> = {
  writing: 'Writing the code',
  checking: 'Checking the code',
  testing: 'Test-rendering it',
  fixing: 'Fixing what the checks found',
};

/** The plugin builder at work: what it is doing now, and a way to stop it. */
function Building({ building }: { building: NonNullable<AssistantState['building']> }) {
  const services = useServices();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setSeconds(Math.floor((performance.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={styles.message}>
      <div className={`${styles.card} ${styles.thinking}`}>
        <Icon name="plug" size={12} className={styles.spark} />
        <span className={styles.shimmer}>
          Building the {building.kind} “{building.name}”: {STAGES[building.stage].toLowerCase()}
          {building.round > 0 ? ` (fix ${building.round} of 3)` : ''}…
        </span>
        {seconds > 2 && <span className={styles.seconds}>{seconds}s</span>}
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

function Thinking() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setSeconds(Math.floor((performance.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={styles.message}>
      <div className={`${styles.card} ${styles.thinking}`}>
        <Icon name="studio" size={13} className={styles.spark} />
        <span className={styles.shimmer}>Working on it…</span>
        {seconds > 2 && <span className={styles.seconds}>{seconds}s</span>}
      </div>
    </div>
  );
}

function Performance({ st }: { st: AssistantState }) {
  const services = useServices();
  const a = services.assistant;
  const meter = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const live = st.phase === 'counting-in' || st.phase === 'recording';
  const [dragOver, setDragOver] = useState(false);

  // Level meter and count-in on the frame loop (no React renders while recording).
  useEffect(() => {
    if (!live) return;
    const bpm = services.doc.getState().project.transport.bpm;
    return onFrame(() => {
      const level = a.recordingLevel();
      if (meter.current) meter.current.style.transform = `scaleX(${Math.min(1, level * 1.4)})`;
      const pos = a.recordingPosition();
      if (status.current && pos !== null) {
        const beats = (pos * bpm) / 60;
        status.current.textContent =
          pos < 0
            ? `Count-in… ${Math.ceil(-beats)}`
            : `Recording bar ${Math.min(st.bars, Math.floor(beats / 4) + 1)} of ${st.bars}`;
      }
    });
  }, [live, a, services, st.bars]);

  const counts = st.take ? summarize(st.take.events) : '';
  return (
    <div
      className={`${styles.performance} ${dragOver ? styles.dragOver : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const file = [...e.dataTransfer.files].find((f) => /\.(wav|aiff?|mp3|m4a|ogg|opus|flac|webm)$/i.test(f.name));
        if (!file) return;
        e.preventDefault();
        void a.importRecording(file);
      }}
    >
      <div className={styles.row}>
        {live ? (
          <button
            className={`${styles.record} ${styles.recording}`}
            onClick={() => a.stopRecording()}
            data-hint="Stop recording"
          >
            <Icon name="stop" size={12} /> Stop
          </button>
        ) : (
          <button
            className={styles.record}
            disabled={st.phase !== 'idle'}
            onClick={() => void a.record()}
            data-hint={`Record ${st.bars} bar${st.bars === 1 ? '' : 's'} after a one-bar count-in (uses your microphone)`}
          >
            <Icon name="mic" size={14} /> Record
          </button>
        )}
        {live ? (
          <div className={styles.liveInfo}>
            <span ref={status}>Count-in…</span>
            <div className={styles.meter}>
              <div ref={meter} className={styles.meterFill} />
            </div>
          </div>
        ) : (
          <>
            <label className={styles.option} data-hint="How long to record">
              Bars
              <select value={st.bars} onChange={(e) => a.set({ bars: Number(e.target.value) })} disabled={busy(st)}>
                {[1, 2, 4].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.option} data-hint="What your noises stand for">
              Noises are
              <select
                value={st.role}
                onChange={(e) => a.set({ role: e.target.value as PerformanceRole })}
                disabled={busy(st)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {!live && (
        <div className={styles.row}>
          <label className={styles.switch} data-hint="Hear a click while you record (the count-in always clicks)">
            <input type="checkbox" checked={st.click} onChange={(e) => a.set({ click: e.target.checked })} />
            Click
          </label>
          <label
            className={styles.switch}
            data-hint="Play the current pattern while you record (use headphones so the mic doesn't pick it up)"
          >
            <input type="checkbox" checked={st.playAlong} onChange={(e) => a.set({ playAlong: e.target.checked })} />
            Play my beat along
          </label>
          <label
            className={styles.switch}
            data-hint="Build the drums from your own beatboxed kick, snare and hat instead of the kit"
          >
            <input type="checkbox" checked={st.mySounds} onChange={(e) => a.set({ mySounds: e.target.checked })} />
            Use my sounds
          </label>
          <span className={styles.spacer} />
          <FileButton disabled={busy(st)} onFile={(f) => void a.importRecording(f)} />
        </div>
      )}
      {st.phase === 'analyzing' && <div className={styles.dim}>Listening back…</div>}
      {st.take && !live && (
        <>
          <TakeView take={st.take} />
          <div className={styles.row}>
            <span className={styles.dim}>{counts}</span>
            <span className={styles.spacer} />
            <button
              className={styles.ghost}
              disabled={!st.take.audio}
              onClick={() => a.playTake()}
              data-hint={
                st.take.audio
                  ? 'Play your take back'
                  : 'The recording itself is gone after a reload (its notes are kept)'
              }
            >
              Play take
            </button>
            <button className={styles.ghost} onClick={() => a.clearTake()} data-hint="Forget this take">
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const busy = (st: AssistantState) => st.phase !== 'idle';

function summarize(events: readonly { kind: string }[]): string {
  const n: Record<string, number> = {};
  for (const e of events) n[e.kind] = (n[e.kind] ?? 0) + 1;
  const names: Record<string, [string, string]> = {
    kick: ['kick', 'kicks'],
    snare: ['snare', 'snares'],
    hat: ['hat', 'hats'],
    tonal: ['note', 'notes'],
  };
  return Object.entries(n)
    .map(([k, c]) => `${c} ${(names[k] ?? [k, k])[c === 1 ? 0 : 1]}`)
    .join(', ');
}

function FileButton({ disabled, onFile }: { disabled: boolean; onFile(file: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className={styles.ghost}
        disabled={disabled}
        onClick={() => input.current?.click()}
        data-hint="Use a recording you already have (e.g. a voice memo); you can also drop it here"
      >
        Use a recording…
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}
