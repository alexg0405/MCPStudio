import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { registerFeatures } from '..';
import { getWindowType } from '../../workspace/registry';
import { selectorFor } from '../tours/target';
import { WHATS_NEW, WHATS_NEW_VERSION } from './entries';
import { closeWhatsNew, isWhatsNewDue, openWhatsNew, showWhatsNewAfterUpdate, whatsNewStore } from './whats-new-state';

const AI_WORD = /\bA\.?I\.?\b/;

describe('when What’s new opens by itself', () => {
  it('is due once per version, and only for someone who has used AGstudio before', () => {
    const due = (seenVersion: string, hasSeenWelcome: boolean) =>
      isWhatsNewDue({ seenVersion, currentVersion: '2026.10', hasSeenWelcome });
    expect(due('', true)).toBe(true); // used it before this feature existed
    expect(due('2026.04', true)).toBe(true); // an older list
    expect(due('2026.10', true)).toBe(false); // already seen
    expect(due('', false)).toBe(false); // the first start has the welcome screen
  });

  it('opens once after an update, remembers it, and does not open again', () => {
    const s = createTestServices();
    s.prefs.getState().set({ welcomeSeen: true, whatsNewSeen: '' });
    expect(showWhatsNewAfterUpdate(s)).toBe(true);
    expect(whatsNewStore.getState().open).toBe(true);
    expect(s.prefs.getState().whatsNewSeen).toBe(WHATS_NEW_VERSION);
    closeWhatsNew();
    expect(showWhatsNewAfterUpdate(s)).toBe(false);
    expect(whatsNewStore.getState().open).toBe(false);
  });

  it('opens again for the next version', () => {
    const s = createTestServices();
    s.prefs.getState().set({ welcomeSeen: true, whatsNewSeen: '2026.01' });
    expect(showWhatsNewAfterUpdate(s)).toBe(true);
    closeWhatsNew();
    s.prefs.getState().set({ whatsNewSeen: WHATS_NEW_VERSION });
    expect(showWhatsNewAfterUpdate(s)).toBe(false);
  });

  it('counts a first-time user as up to date, so the list never opens right after the welcome screen', () => {
    const s = createTestServices();
    s.prefs.getState().set({ welcomeSeen: false, whatsNewSeen: '' });
    expect(showWhatsNewAfterUpdate(s)).toBe(false);
    expect(s.prefs.getState().whatsNewSeen).toBe(WHATS_NEW_VERSION);
    expect(whatsNewStore.getState().open).toBe(false);
  });

  it('opens from Help → What’s new any time, also after it was seen', () => {
    const s = createTestServices();
    registerFeatures(s);
    s.prefs.getState().set({ welcomeSeen: true, whatsNewSeen: WHATS_NEW_VERSION });
    s.commands.run('help.whatsNew');
    expect(whatsNewStore.getState().open).toBe(true);
    closeWhatsNew();
    openWhatsNew(s);
    expect(whatsNewStore.getState().open).toBe(true);
    closeWhatsNew();
  });
});

describe('the list', () => {
  const s = createTestServices();
  registerFeatures(s);

  it('is short, illustrated and has a “Show me” for every entry, newest first', () => {
    expect(WHATS_NEW.length).toBeGreaterThanOrEqual(8);
    expect(WHATS_NEW.length).toBeLessThanOrEqual(14);
    expect(WHATS_NEW[0]!.id).toBe('help-and-tours');
    const ids = WHATS_NEW.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of WHATS_NEW) {
      expect(e.text.length, e.id).toBeGreaterThan(40);
      expect(e.show.body.length, e.id).toBeGreaterThan(30);
      expect(selectorFor(e.show.target), e.id).not.toBeNull();
    }
  });

  it('points at windows and commands that exist, and says “Studio”, never “AI”', () => {
    for (const e of WHATS_NEW) {
      const [kind, name] = e.show.target.split(':');
      if (kind === 'window') expect(getWindowType(name!), `${e.id}: window ${name}`).toBeTruthy();
      for (const m of e.show.body.matchAll(/\{key:([\w.]+)\}/g))
        expect(s.commands.get(m[1]!), `${e.id}: ${m[1]}`).toBeTruthy();
      for (const text of [e.title, e.text, e.show.title, e.show.body])
        expect(AI_WORD.test(text), `${e.id}: ${text}`).toBe(false);
    }
  });
});
