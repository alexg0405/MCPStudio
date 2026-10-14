import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeAfterReload } from './resume-playback';
import { createTestServices } from './testing';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('carrying on after a reload', () => {
  afterEach(() => vi.useRealTimers());

  it('plays on from where it was when the page reloaded mid-song', async () => {
    const s = createTestServices();
    const play = vi.spyOn(s.engine, 'play');
    resumeAfterReload(s, { playing: true, tick: 7680, at: 1000 }, { now: 2000 });
    await flush();
    expect(play).toHaveBeenCalledWith(7680);
  });

  it('does nothing for a stopped song, or a snapshot from long ago', async () => {
    const s = createTestServices();
    const play = vi.spyOn(s.engine, 'play');
    resumeAfterReload(s, { playing: false, tick: 960, at: 1000 }, { now: 1500 });
    resumeAfterReload(s, { playing: true, tick: 960, at: 1000 }, { now: 1000 + 60_000 });
    resumeAfterReload(s, undefined);
    await flush();
    expect(play).not.toHaveBeenCalled();
  });

  it('asks for a click when the browser won’t start audio, and carries on after it', async () => {
    vi.useFakeTimers();
    const s = createTestServices();
    const fake = s.fakeEngine;
    fake.state = 'suspended';
    const play = vi.spyOn(s.engine, 'play');
    resumeAfterReload(s, { playing: true, tick: 3840 * 4, at: 1000 }, { now: 1200, askAfterMs: 500 });
    await flush();
    expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/click anywhere to carry on/);
    // The click resumes audio (the audio unlock does that); the engine says it's running now.
    fake.state = 'running';
    fake.stop();
    await flush();
    expect(play).toHaveBeenCalledWith(3840 * 4);
    expect(s.session.getState().toasts.at(-1)?.text).toBe('Carrying on from bar 5');
  });

  it('gives way when you press play yourself first', async () => {
    vi.useFakeTimers();
    const s = createTestServices();
    s.fakeEngine.state = 'suspended';
    resumeAfterReload(s, { playing: true, tick: 960, at: 1000 }, { now: 1100 });
    s.engine.play(0);
    const play = vi.spyOn(s.engine, 'play');
    s.fakeEngine.state = 'running';
    s.fakeEngine.stop();
    await flush();
    expect(play).not.toHaveBeenCalled();
  });
});
