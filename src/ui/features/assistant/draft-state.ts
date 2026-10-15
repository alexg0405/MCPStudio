/**
 * Text waiting to go into the AI studio's box, put there from elsewhere (the Ask AI card's "Open in
 * AI studio"). The window takes it when it opens, or right away when it is open.
 */
import { createStore } from 'zustand/vanilla';

export const assistantDraft = createStore<{ text: string }>(() => ({ text: '' }));

/** Puts text in the AI studio's box. */
export function prefillAssistant(text: string): void {
  assistantDraft.setState({ text });
}

export function clearAssistantDraft(): void {
  if (assistantDraft.getState().text) assistantDraft.setState({ text: '' });
}
