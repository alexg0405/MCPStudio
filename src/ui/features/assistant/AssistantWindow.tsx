import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { resolveFocus } from '@app/ai/focus';
import { useServices } from '../../services-context';
import { quickChips } from '../ask-ai/chips';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import { assistantDraft, clearAssistantDraft } from './draft-state';
import { Header } from './Header';
import { PerformanceStrip } from './PerformanceStrip';
import styles from './Assistant.module.css';

/** The Studio window: the AI chat that writes beats and changes the project. */
export function AssistantWindow() {
  const services = useServices();
  const assistant = services.assistant;
  const state = useStore(assistant.store);
  // Text handed over from elsewhere (the Ask AI card's "Open in AI studio") starts the box.
  const [prompt, setPrompt] = useState(() => assistantDraft.getState().text);
  // The performance strip (record, bars, what the noises are…) shows only when asked for.
  const [isPerformToggledOn, setIsPerformToggledOn] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // The part the conversation is about, if it is still in the song (its label, for the idea chips).
  const partLabel = useStore(services.doc, (doc) =>
    state.focus ? (resolveFocus(doc.project, state.focus)?.label ?? null) : null,
  );

  useEffect(() => {
    if (assistant.store.getState().status === null) void assistant.checkAi();
  }, [assistant]);

  useEffect(() => {
    if (assistantDraft.getState().text) clearAssistantDraft();
    return assistantDraft.subscribe(({ text }) => {
      if (!text) return;
      setPrompt(text);
      clearAssistantDraft();
      input.current?.focus();
    });
  }, []);

  const isBusy = state.phase !== 'idle';
  const send = (text = prompt) => {
    if (isBusy || (!text.trim() && !state.take)) return;
    setPrompt('');
    void assistant.send(text);
  };
  // The header and the conversation get one `sendText` for good (it reads the latest through a ref), so typing in
  // the box re-renders the box and not the whole conversation.
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  const sendText = useCallback((text: string) => sendRef.current(text), []);

  const isRecording = state.phase === 'counting-in' || state.phase === 'recording';
  // A take, a recording or its analysis keeps the strip open.
  const isPerformHeld = isRecording || state.phase === 'analyzing' || !!state.take;
  const isPerformOpen = isPerformToggledOn || isPerformHeld;

  return (
    <div className={styles.assistant}>
      <Header state={state} sendText={sendText} />
      <Conversation state={state} sendText={sendText} />
      {isPerformOpen && <PerformanceStrip state={state} />}
      <Composer
        state={state}
        prompt={prompt}
        onPromptChange={setPrompt}
        send={send}
        partLabel={partLabel}
        chips={partLabel ? quickChips(state.focus) : []}
        isPerformOpen={isPerformOpen}
        isPerformHeld={isPerformHeld}
        onTogglePerform={() => setIsPerformToggledOn(!isPerformOpen)}
        inputRef={input}
      />
    </div>
  );
}
