import { describe, expect, it, vi } from 'vitest';
import type { EngineApi } from '@engine/api';
import { watchAutoBuffer } from './audio-buffer-watch';
import { createPrefsStore, type PrefsState } from './stores/prefs';
import { createSessionStore } from './stores/session';

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

function setup(patch: Partial<PrefsState> = {}) {
  vi.useFakeTimers();
  const engine = fakeEngine();
  const prefs = createPrefsStore();
  prefs.getState().set({ audioBuffer: 'auto', autoBufferSize: 'small', ...patch });
  const session = createSessionStore();
  let t = 0;
  const stop = watchAutoBuffer(engine as unknown as EngineApi, prefs, session, () => false, () => t);
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      t += 1000;
      vi.advanceTimersByTime(1000);
    }
  };
  return { engine, prefs, session, stop, tick };
}

describe('watchAutoBuffer', () => {
  it('moves to a bigger buffer, remembers it, and says so, when playback struggles', () => {
    const { engine, prefs, session, stop, tick } = setup();
    engine.set(true);
    engine.keepUp = 1;
    tick(5);
    expect(prefs.getState().autoBufferSize).toBe('small');
    engine.keepUp = 0.8;
    tick(3);
    expect(prefs.getState().autoBufferSize).toBe('medium');
    expect(prefs.getState().audioBuffer).toBe('auto');
    expect(session.getState().toasts.at(-1)?.text).toMatch(/medium audio buffer/);
    stop();
    vi.useRealTimers();
  });

  it('does nothing when a size was chosen by hand, or while stopped', () => {
    const chosen = setup({ audioBuffer: 'small', audioBufferPicked: true });
    chosen.engine.set(true);
    chosen.engine.keepUp = 0.5;
    chosen.tick(10);
    expect(chosen.prefs.getState().autoBufferSize).toBe('small');
    chosen.stop();
    const idle = setup();
    idle.engine.keepUp = 0.5;
    idle.tick(10);
    expect(idle.prefs.getState().autoBufferSize).toBe('small');
    idle.stop();
    vi.useRealTimers();
  });
});
