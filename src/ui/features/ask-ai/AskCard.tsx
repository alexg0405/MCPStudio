import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { resolveFocus } from '@app/ai/focus';
import { onFrame } from '../../frame-loop';
import { placeBeside } from '../../controls/place';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { prefillAssistant } from '../assistant/draft-state';
import { Message } from '../assistant/Message';
import { anchorBox } from './anchors';
import { askStore, closeAsk, setAskFocus } from './ask-state';
import { chipHint, quickChips } from './chips';
import { Icon } from '../../controls/Icon';
import styles from './AskCard.module.css';

/** The Ask AI card, while it is open (an app overlay). */
export function AskCardOverlay() {
  const open = useStore(askStore, (s) => s.open);
  return open ? <AskCard /> : null;
}

/**
 * "Ask AI about this part": the part it is about (× asks about the whole song), a box for the request
 * (Enter asks, Shift+Enter is a new line, Esc closes), quick requests, the replies with Undo, and ways
 * to hear the part or carry on in the AI studio. It sits next to what it was opened from.
 */
function AskCard() {
  const services = useServices();
  const a = services.assistant;
  const focus = useStore(askStore, (s) => s.focus);
  const anchor = useStore(askStore, (s) => s.anchor);
  const since = useStore(askStore, (s) => s.since);
  const phase = useStore(a.store, (s) => s.phase);
  const listening = useStore(a.store, (s) => s.listening);
  const messages = useStore(a.store, (s) => s.messages);
  const label = useStore(services.doc, (d) => (focus ? (resolveFocus(d.project, focus)?.label ?? null) : null));
  const [text, setText] = useState('');
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = phase !== 'idle';
  const replies = messages.filter((m) => m.id > since);
  const gone = !!focus && !label;

  // It follows what it was opened from (windows move, the playlist scrolls), placed on the frame loop.
  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const el = card.current;
      if (!el) return;
      const box = anchor ? anchorBox(anchor) : null;
      // What it sat next to went away (selection cleared, window closed): it stays where it is.
      if (!box && last) return;
      const { x, y } = placeBeside(
        box,
        el.offsetWidth,
        el.offsetHeight,
        window.innerWidth,
        window.innerHeight,
        ['below', 'above', 'right', 'left'],
        8,
      );
      const t = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (t === last) return;
      last = t;
      el.style.transform = t;
      // Shown once placed (transparent, not hidden, before that: the box can take the keyboard at once).
      el.style.opacity = '1';
    });
  }, [anchor]);

  // The box takes the keyboard (shortcuts and the typing keyboard wait while you type).
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [focus, anchor]);

  // A click elsewhere closes it, but never while the AI works or a request is half typed.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (card.current?.contains(e.target as Node)) return;
      if (a.store.getState().phase !== 'idle' || textRef.current.trim()) return;
      closeAsk();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [a]);

  // Replies scroll into view.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length, phase]);

  const ask = (request: string) => {
    const t = request.trim();
    if (!t || a.store.getState().phase !== 'idle') return;
    setText('');
    const sent = askStore.getState().focus;
    void a.send(t, { focus: gone ? null : sent }).then(() => {
      // Follow-ups from here use the part as the answer left it (copies made for it).
      const now = a.store.getState().focus;
      const st = askStore.getState();
      if (st.open && st.focus === sent && now) setAskFocus(now);
    });
  };

  const openStudio = () => {
    if (a.store.getState().phase === 'idle') a.setFocus(gone ? null : focus);
    if (text.trim()) prefillAssistant(text.trim());
    openWindow(services, 'assistant');
    closeAsk();
  };

  const chips = gone ? [] : quickChips(focus);
  return (
    <div
      ref={card}
      className={styles.card}
      style={{ opacity: 0 }}
      role="dialog"
      aria-label="Ask Studio about this part"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeAsk();
      }}
    >
      <div className={styles.head}>
        <span className={styles.title}>
          <Icon name="studio" size={14} /> Ask Studio
        </span>
        <span
          className={`${styles.scope} ${focus && !gone ? '' : styles.scopeAll}`}
          data-hint={
            label
              ? `Studio changes only ${label}; everything else in the song stays as it is`
              : gone
                ? 'The part you picked is no longer in the song: this asks about the whole song'
                : 'No part picked: this asks about the whole song'
          }
        >
          <span className={styles.scopeText}>
            {label ?? (gone ? 'That part is gone: the whole song' : 'The whole song')}
          </span>
          {focus && !gone && (
            <button
              className={styles.scopeClear}
              disabled={busy}
              onClick={() => setAskFocus(null)}
              data-hint="Ask about the whole song instead of this part"
              aria-label="Ask about the whole song"
            >
              ×
            </button>
          )}
        </span>
        <button className={styles.close} onClick={() => closeAsk()} data-hint="Close (Esc)" aria-label="Close">
          ✕
        </button>
      </div>

      {(replies.length > 0 || busy) && (
        <div className={styles.replies} ref={list}>
          {replies.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {busy && (
            <div className={styles.status}>
              <span className={styles.spark}>
                <Icon name="studio" size={13} />
              </span>
              <span className={styles.statusText}>
                {phase === 'listening' && listening
                  ? `${listening.label} (${Math.round(listening.fraction * 100)}%)…`
                  : phase === 'thinking'
                    ? 'Working on it…'
                    : 'Studio is busy…'}
              </span>
              <span className={styles.spacer} />
              <button className={styles.link} onClick={() => a.cancel()} data-hint="Stop waiting for Studio">
                Stop
              </button>
            </div>
          )}
        </div>
      )}

      <textarea
        ref={input}
        className={styles.prompt}
        rows={2}
        value={text}
        placeholder={label ? 'What should change here? e.g. “smooth the transition in”' : 'What should Studio change?'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            ask(text);
          }
        }}
        data-hint="Say what to change in this part; Enter asks, Shift+Enter makes a new line, Esc closes"
      />
      {chips.length > 0 && (
        <div className={styles.chips}>
          {chips.map((c) => (
            <button
              key={c}
              className={styles.chip}
              disabled={busy}
              onClick={() => ask(c)}
              data-hint={chipHint(c, label)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        {busy ? (
          <button className={styles.primary} onClick={() => a.cancel()} data-hint="Stop waiting for Studio">
            Stop
          </button>
        ) : (
          <button
            className={styles.primary}
            disabled={!text.trim()}
            onClick={() => ask(text)}
            data-hint={label ? `Ask Studio; only ${label} changes (one undo step)` : 'Ask Studio (one undo step)'}
          >
            Ask
          </button>
        )}
        <button
          className={styles.link}
          disabled={!label}
          onClick={() => void a.playFocus(focus)}
          data-hint="Play this part on a loop (song mode)"
        >
          ▶ Play this part
        </button>
        <span className={styles.spacer} />
        <button
          className={styles.link}
          onClick={openStudio}
          data-hint="Carry on in Studio window, still about this part"
        >
          Open in Studio
        </button>
      </div>
    </div>
  );
}
