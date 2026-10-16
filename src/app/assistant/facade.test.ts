import { describe, expect, it } from 'vitest';
import type { AiFocus } from '../ai/focus';
import { createTestServices } from '../testing';
import { BeatAssistant } from './assistant';

describe('AssistantFacade (the Studio loads on first use)', () => {
  it('answers from the state store before the assistant has loaded', () => {
    const s = createTestServices();
    const a = s.assistant;
    expect(a.instance).toBeNull();
    expect(a.store.getState().phase).toBe('idle');
    a.set({ autoplay: false, bars: 4 });
    expect(a.store.getState()).toMatchObject({ autoplay: false, bars: 4 });
    expect(a.recordingLevel()).toBe(0);
    expect(a.recordingPosition()).toBeNull();
    expect(a.playFocus(null)).toBe(false);
    a.cancel();
    a.stopRecording();
    expect(a.instance).toBeNull();
  });

  it('is the same assistant once loaded: one store, one instance', async () => {
    const s = createTestServices();
    const a = s.assistant;
    const store = a.store;
    const [first, second] = await Promise.all([a.load(), a.load()]);
    expect(first).toBeInstanceOf(BeatAssistant);
    expect(second).toBe(first);
    expect(a.instance).toBe(first);
    expect(first.store).toBe(store);
    expect(s.assistant.store).toBe(store);
  });

  it('keeps calls in order: New chat asked before the load runs once it is there', async () => {
    const s = createTestServices();
    const a = s.assistant;
    a.store.setState({ messages: [{ id: 1, from: 'you', text: 'hi' }] });
    a.newBeat();
    expect(a.store.getState().messages).toHaveLength(1);
    await a.load();
    await Promise.resolve();
    expect(a.store.getState().messages).toEqual([]);
  });

  it('forgets the part of the song when another project opens, before any Studio code has loaded', () => {
    const s = createTestServices();
    const project = s.doc.getState().project;
    const focus: AiFocus = { kind: 'range', projectId: project.projectId, from: 0, to: 3840 };
    s.assistant.setFocus(focus);
    expect(s.assistant.store.getState().focus).toBe(focus);
    s.history.load(project);
    expect(s.assistant.store.getState().focus).toBe(focus);
    s.history.load({ ...project, projectId: 'other' });
    expect(s.assistant.store.getState().focus).toBeNull();
    expect(s.assistant.instance).toBeNull();
  });
});
