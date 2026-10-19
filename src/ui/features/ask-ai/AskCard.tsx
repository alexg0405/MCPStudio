import { useEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { resolveFocus } from '@app/ai/focus';
import type { AssistantFacade } from '@app/assistant/facade';
import { onFrame } from '../../frame-loop';
import { placeBeside } from '../../controls/place';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { prefillAssistant } from '../assistant/draft-state';
import { Message } from '../assistant/Message';
import { anchorBox, type AskAnchor } from './anchors';
import { askStore, closeAsk, setAskFocus } from './ask-state';
import { chipHint, quickChips } from './chips';
import { Icon } from '../../controls/Icon';
import styles from './AskCard.module.css';

/** The gap between the card and what it sits next to, in px. */
const CARD_GAP_PX = 8;
/** The sides the card tries, in order, to sit beside what it was opened from. */
const CARD_SIDES = ['below', 'above', 'right', 'left'] as const;

/** The Ask AI card, while it is open (an app overlay). */
export function AskCardOverlay() {
  const open = useStore(askStore, (s) => s.open);
  return open ? <AskCard /> : null;
}

/** It follows what it was opened from (windows move, the playlist scrolls), placed on the frame loop. */
function useFollowAnchor(card: RefObject<HTMLDivElement | null>, anchor: AskAnchor | null): void {
  useEffect(() => {
    let lastTransform = '';
    return onFrame(() => {
      const el = card.current;
      if (!el) return;
      const box = anchor ? anchorBox(anchor) : null;
      // What it sat next to went away (selection cleared, window closed): it stays where it is.
      if (!box && lastTransform) return;
      const { x, y } = placeBeside(box, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight, [...CARD_SIDES], CARD_GAP_PX);
      const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (transform === lastTransform) return;
      lastTransform = transform;
      el.style.transform = transform;
      // Shown once placed (transparent, not hidden, before that: the box can take the keyboard at once).
      el.style.opacity = '1';
    });
  }, [card, anchor]);
}

/** A click elsewhere closes the card, but never while the AI works or a request is half typed. */
function useCloseOnOutsideClick(card: RefObject<HTMLDivElement | null>, assistant: AssistantFacade, typedText: string): void {
  const typedTextRef = useRef(typedText);
  useEffect(() => {
    typedTextRef.current = typedText;
  }, [typedText]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (card.current?.contains(e.target as Node)) return;
      if (assistant.store.getState().phase !== 'idle' || typedTextRef.current.trim()) return;
      closeAsk();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [card, assistant]);
}

/** What the part's label says on hover: what Studio changes, or why the card asks about the whole song. */
function scopeHint(label: string | null, isGone: boolean): string {
  if (label) return `Studio changes only ${label}; everything else in the song stays as it is`;
  if (isGone) return 'The part you picked is no longer in the song: this asks about the whole song';
  return 'No part picked: this asks about the whole song';
}

/** The words in the part's label. */
function scopeText(label: string | null, isGone: boolean): string {
  if (label) return label;
  return isGone ? 'That part is gone: the whole song' : 'The whole song';
}

/** The line shown while Studio works: how far the listening is, or that it is thinking or busy. */
function busyText(phase: string, listening: { label: string; fraction: number } | null): string {
  if (phase === 'listening' && listening) return `${listening.label} (${Math.round(listening.fraction * 100)}%)…`;
  if (phase === 'thinking') return 'Working on it…';
  return 'Studio is busy…';
}

/**
 * "Ask AI about this part": the part it is about (× asks about the whole song), a box for the request
 * (Enter asks, Shift+Enter is a new line, Esc closes), quick requests, the replies with Undo, and ways
 * to hear the part or carry on in the AI studio. It sits next to what it was opened from.
 */
function AskCard() {
  const services = useServices();
  const assistant = services.assistant;
  const focus = useStore(askStore, (s) => s.focus);
  const anchor = useStore(askStore, (s) => s.anchor);
  const since = useStore(askStore, (s) => s.since);
  const phase = useStore(assistant.store, (s) => s.phase);
  const listening = useStore(assistant.store, (s) => s.listening);
  const messages = useStore(assistant.store, (s) => s.messages);
  const label = useStore(services.doc, (d) => (focus ? (resolveFocus(d.project, focus)?.label ?? null) : null));
  const [text, setText] = useState('');
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const isBusy = phase !== 'idle';
  const replies = messages.filter((m) => m.id > since);
  const isGone = !!focus && !label;

  useFollowAnchor(card, anchor);
  // The box takes the keyboard (shortcuts and the typing keyboard wait while you type).
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [focus, anchor]);
  useCloseOnOutsideClick(card, assistant, text);

  const ask = (request: string) => {
    const trimmed = request.trim();
    if (!trimmed || assistant.store.getState().phase !== 'idle') return;
    setText('');
    const askedFocus = askStore.getState().focus;
    void assistant.send(trimmed, { focus: isGone ? null : askedFocus }).then(() => {
      // Follow-ups from here use the part as the answer left it (copies made for it).
      const focusNow = assistant.store.getState().focus;
      const state = askStore.getState();
      if (state.open && state.focus === askedFocus && focusNow) setAskFocus(focusNow);
    });
  };

  const openStudio = () => {
    if (assistant.store.getState().phase === 'idle') assistant.setFocus(isGone ? null : focus);
    if (text.trim()) prefillAssistant(text.trim());
    openWindow(services, 'assistant');
    closeAsk();
  };

  const chips = isGone ? [] : quickChips(focus);
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
      <AskHeader label={label} isGone={isGone} hasFocus={!!focus} isBusy={isBusy} />
      {(replies.length > 0 || isBusy) && <AskReplies replies={replies} phase={phase} listening={listening} isBusy={isBusy} assistant={assistant} />}
      <textarea
        ref={input}
        className={styles.prompt}
        rows={2}
        value={text}
        placeholder={label ? 'What should change here? e.g. “smooth the transition in”' : 'What should Studio change?'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // (Enter that confirms an input-method choice isn't a send)
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            ask(text);
          }
        }}
        data-hint="Say what to change in this part; Enter asks, Shift+Enter makes a new line, Esc closes"
      />
      {chips.length > 0 && (
        <div className={styles.chips}>
          {chips.map((c) => (
            <button key={c} className={styles.chip} disabled={isBusy} onClick={() => ask(c)} data-hint={chipHint(c, label)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        {isBusy ? (
          <button className={styles.primary} onClick={() => assistant.cancel()} data-hint="Stop waiting for Studio">
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
        <button className={styles.link} disabled={!label} onClick={() => void assistant.playFocus(focus)} data-hint="Play this part on a loop (song mode)">
          ▶ Play this part
        </button>
        <span className={styles.spacer} />
        <button className={styles.link} onClick={openStudio} data-hint="Carry on in Studio window, still about this part">
          Open in Studio
        </button>
      </div>
    </div>
  );
}

/** The top of the card: its title, the part it is about (× asks about the whole song) and a close button. */
function AskHeader({ label, isGone, hasFocus, isBusy }: { label: string | null; isGone: boolean; hasFocus: boolean; isBusy: boolean }) {
  return (
    <div className={styles.head}>
      <span className={styles.title}>
        <Icon name="studio" size={14} /> Ask Studio
      </span>
      <span className={`${styles.scope} ${hasFocus && !isGone ? '' : styles.scopeAll}`} data-hint={scopeHint(label, isGone)}>
        <span className={styles.scopeText}>{scopeText(label, isGone)}</span>
        {hasFocus && !isGone && (
          <button
            className={styles.scopeClear}
            disabled={isBusy}
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
  );
}

interface AskRepliesProps {
  replies: React.ComponentProps<typeof Message>['message'][];
  phase: string;
  listening: { label: string; fraction: number } | null;
  isBusy: boolean;
  assistant: AssistantFacade;
}

/** Studio's replies to this card's requests, with a status line and Stop while it works; they scroll into view. */
function AskReplies({ replies, phase, listening, isBusy, assistant }: AskRepliesProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length, phase]);
  return (
    <div className={styles.replies} ref={list}>
      {replies.map((m) => (
        <Message key={m.id} message={m} />
      ))}
      {isBusy && (
        <div className={styles.status}>
          <span className={styles.spark}>
            <Icon name="studio" size={13} />
          </span>
          <span className={styles.statusText}>{busyText(phase, listening)}</span>
          <span className={styles.spacer} />
          <button className={styles.link} onClick={() => assistant.cancel()} data-hint="Stop waiting for Studio">
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
