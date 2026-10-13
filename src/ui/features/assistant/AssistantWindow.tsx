import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { AI_MODELS } from '@app/assistant/claude';
import type { AssistantMessage, AssistantState } from '@app/assistant/assistant';
import type { PerformanceRole } from '@core/beat/local';
import { Icon } from '../../controls/Icon';
import { onFrame } from '../../frame-loop';
import { useHistoryStatus, useServices } from '../../services-context';
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
  'Chill lofi',
  'House at 124',
  'Busier hats',
  'Simpler',
  'More 808 slides',
  'Make a variation',
];

export function AssistantWindow() {
  const services = useServices();
  const a = services.assistant;
  const st = useStore(a.store);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (a.store.getState().status === null) void a.checkAi();
  }, [a]);

  const busy = st.phase !== 'idle';
  const send = (text = prompt) => {
    if (busy || (!text.trim() && !st.take)) return;
    setPrompt('');
    void a.send(text);
  };

  return (
    <div className={styles.assistant}>
      <Header st={st} />
      <Messages st={st} />
      <Performance st={st} />
      <div className={styles.compose}>
        <textarea
          className={styles.prompt}
          rows={2}
          value={prompt}
          placeholder={
            st.take ? 'What should your take become? e.g. "808s like this, dark trap at 140"' : 'Describe a beat…'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          data-hint="Describe the beat or the change you want; Enter sends, Shift+Enter makes a new line"
        />
        {st.phase === 'thinking' ? (
          <button className={styles.sendButton} onClick={() => a.cancel()} data-hint="Stop waiting">
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button
            className={`${styles.sendButton} ${styles.sendReady}`}
            disabled={busy || (!prompt.trim() && !st.take)}
            onClick={() => send()}
            data-hint="Send (Enter)"
          >
            <Icon name="send" size={14} />
          </button>
        )}
      </div>
      <div className={styles.ideas}>
        {IDEAS.map((idea) => (
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
    </div>
  );
}

const BACKENDS: { value: AssistantState['backend']; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'subscription', label: 'Claude (my subscription)' },
  { value: 'api', label: 'Claude (API key)' },
  { value: 'offline', label: 'Offline generator' },
];

/** What "Auto" resolves to right now, for the label. */
function autoLabel(st: AssistantState): string {
  if (!st.status) return 'Auto (checking…)';
  if (st.status.subscription.ok) return 'Auto: my Claude subscription';
  if (st.status.api.ok) return 'Auto: Claude API key';
  return 'Auto: offline generator';
}

function Header({ st }: { st: AssistantState }) {
  const services = useServices();
  const a = services.assistant;
  const usesClaude =
    st.backend === 'subscription' ||
    st.backend === 'api' ||
    (st.backend === 'auto' && !!st.status && (st.status.subscription.ok || st.status.api.ok));
  const reason =
    st.backend === 'subscription'
      ? st.status?.subscription.reason
      : st.backend === 'api'
        ? st.status?.api.reason
        : st.backend === 'auto' && st.status && !st.status.subscription.ok && !st.status.api.ok
          ? `To use Claude: ${st.status.subscription.reason ?? 'sign in to Claude Code'}`
          : undefined;
  return (
    <div className={styles.header}>
      <select
        className={styles.model}
        value={st.backend}
        onChange={(e) => {
          a.set({ backend: e.target.value as AssistantState['backend'] });
          void a.checkAi();
        }}
        data-hint="Who writes your beats: your Claude subscription (through Claude Code), an API key, or the built-in offline generator"
      >
        {BACKENDS.map((b) => (
          <option key={b.value} value={b.value}>
            {b.value === 'auto' ? autoLabel(st) : b.label}
            {b.value === 'subscription' && st.status && !st.status.subscription.ok ? ' (not set up)' : ''}
            {b.value === 'api' && st.status && !st.status.api.ok ? ' (no key)' : ''}
          </option>
        ))}
      </select>
      {usesClaude && (
        <select
          className={styles.model}
          value={st.model}
          onChange={(e) => a.set({ model: e.target.value })}
          data-hint="Which Claude model writes your beats"
        >
          {AI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      {reason && (
        <button
          className={styles.offline}
          onClick={() => void a.checkAi()}
          data-hint={`${reason} Click to check again.`}
        >
          <span className={styles.dotOff} /> Not set up
        </button>
      )}
      <span className={styles.spacer} />
      <label className={styles.toggle} data-hint="Start playing each new beat right away">
        <input type="checkbox" checked={st.autoplay} onChange={(e) => a.set({ autoplay: e.target.checked })} />
        Auto-play
      </label>
      <button
        className={styles.small}
        disabled={st.phase !== 'idle' || st.messages.length === 0}
        onClick={() => a.newBeat()}
        data-hint="Start over: the next request makes a new pattern"
      >
        New beat
      </button>
    </div>
  );
}

function Messages({ st }: { st: AssistantState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [st.messages.length, st.phase]);
  return (
    <div className={styles.messages} ref={ref}>
      {st.messages.length === 0 && (
        <div className={styles.intro}>
          <Icon name="sparkle" size={18} />
          <p>
            Describe a beat, or perform part of it: <b>beatbox</b> the drums or <b>hum</b> an 808 line, then say what
            you want.
          </p>
          <p className={styles.dim}>Try “dark trap at 140, 808s that go like this” after recording a take.</p>
        </div>
      )}
      {st.messages.map((m) => (
        <Message key={m.id} m={m} />
      ))}
      {st.phase === 'thinking' && <Thinking />}
    </div>
  );
}

function Message({ m }: { m: AssistantMessage }) {
  const services = useServices();
  const status = useHistoryStatus();
  const canUndo = !!m.beat && status.cursor === m.beat.cursor;
  return (
    <div className={`${styles.message} ${m.from === 'you' ? styles.mine : ''} ${m.error ? styles.errorMessage : ''}`}>
      <div className={styles.bubble}>
        {m.from === 'assistant' && !m.error && <Icon name="sparkle" size={12} className={styles.spark} />}
        {m.text}
      </div>
      {(m.detail || m.offline || m.beat) && (
        <div className={styles.detail}>
          {m.detail}
          {m.offline && <span className={styles.badge}>offline</span>}
          {m.beat && (
            <>
              <button
                className={styles.link}
                onClick={() => {
                  services.view.getState().setMode('pattern');
                  services.engine.play();
                }}
              >
                Play
              </button>
              <button
                className={styles.link}
                disabled={!canUndo}
                onClick={() => services.history.undo()}
                data-hint={canUndo ? 'Undo this beat' : 'Use Undo (Cmd+Z) to step back through later changes first'}
              >
                Undo
              </button>
            </>
          )}
        </div>
      )}
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
      <div className={`${styles.bubble} ${styles.thinking}`}>
        <Icon name="sparkle" size={12} className={styles.spark} />
        Writing your beat… {seconds > 2 ? `${seconds}s` : ''}
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
            <label className={styles.field} data-hint="How long to record">
              Bars
              <select value={st.bars} onChange={(e) => a.set({ bars: Number(e.target.value) })} disabled={busy(st)}>
                {[1, 2, 4].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field} data-hint="What your noises stand for">
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
          <label className={styles.toggle} data-hint="Hear a click while you record (the count-in always clicks)">
            <input type="checkbox" checked={st.click} onChange={(e) => a.set({ click: e.target.checked })} />
            Click
          </label>
          <label
            className={styles.toggle}
            data-hint="Play the current pattern while you record (use headphones so the mic doesn't pick it up)"
          >
            <input type="checkbox" checked={st.playAlong} onChange={(e) => a.set({ playAlong: e.target.checked })} />
            Play my beat along
          </label>
          <label
            className={styles.toggle}
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
              className={styles.link}
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
            <button className={styles.link} onClick={() => a.clearTake()} data-hint="Forget this take">
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
        className={styles.link}
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
