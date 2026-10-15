import { describe, expect, it, vi } from 'vitest';
import { createPrefsStore } from './stores/prefs';
import { createSessionStore } from './stores/session';
import { playbackAdvice, watchPlaybackHealth } from './playback-health';
import type { EngineApi } from '@engine/api';

function fakeEngine() {
  const subs = new Set<() => void>();
  const e = {
    playing: false,
    keepUp: undefined as number | undefined,
    stats: () => ({ keepUp: e.keepUp }),
    subscribe: (fn: () => void) => (subs.add(fn), () => void subs.delete(fn)),
    set(playing: boolean) {
      e.playing = playing;
      for (const f of subs) f();
    },
  };
  return e;
}

describe('playback health', () => {
  it('says once that playback can’t keep up after two struggling seconds', () => {
    vi.useFakeTimers();
    const engine = fakeEngine();
    const prefs = createPrefsStore();
    prefs.getState().set({ audioBuffer: 'small' });
    const session = createSessionStore();
    const stop = watchPlaybackHealth(engine as unknown as EngineApi, prefs, session);
    engine.set(true);
    engine.keepUp = 0.99;
    vi.advanceTimersByTime(3000);
    expect(session.getState().toasts).toHaveLength(0);
    engine.keepUp = 0.6;
    vi.advanceTimersByTime(2000);
    const toasts = session.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.text).toMatch(/40% of the sound/);
    expect(toasts[0]!.text).toMatch(/Audio buffer to Large/);
    vi.advanceTimersByTime(5000);
    expect(session.getState().toasts).toHaveLength(1);
    stop();
    vi.useRealTimers();
  });

  it('leaves the buffer advice out when it is already large', () => {
    expect(playbackAdvice(0.9, 'large')).not.toMatch(/Audio buffer/);
    expect(playbackAdvice(0.9, 'large')).toMatch(/10%/);
  });
});
