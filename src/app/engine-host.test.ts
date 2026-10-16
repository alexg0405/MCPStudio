import { describe, expect, it } from 'vitest';
import { FakeEngine } from '@engine/fake-engine';
import { createEmptyProject } from '@core/model/defaults';
import { EngineHost } from './engine-host';

describe('EngineHost', () => {
  it('reboots into a fresh engine with the same project, view and transport state', async () => {
    const made: FakeEngine[] = [];
    const host = new EngineHost(() => {
      const e = new FakeEngine();
      made.push(e);
      return e;
    });
    const project = createEmptyProject();
    host.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    host.setTransportView({ mode: 'pattern', patternId: null, loop: null });
    host.play();
    let notified = 0;
    host.subscribe(() => notified++);

    await host.reboot();

    expect(made).toHaveLength(2);
    const [, next] = made as [FakeEngine, FakeEngine];
    expect(next.changes[0]).toMatchObject({ origin: 'load', next: project });
    expect(next.view).toEqual({ mode: 'pattern', patternId: null, loop: null });
    expect(next.playing).toBe(true);
    expect(host.playing).toBe(true);
    expect(notified).toBeGreaterThan(0);

    // Calls go to the new engine; events from the old one no longer reach subscribers.
    host.stop();
    expect(next.playing).toBe(false);
    const before = notified;
    made[0]!.play();
    expect(notified).toBe(before);
  });

  it('keeps playing through the chosen output device after a reboot', async () => {
    const made: FakeEngine[] = [];
    const host = new EngineHost(() => {
      const e = new FakeEngine();
      made.push(e);
      return e;
    });
    expect(await host.setOutputDevice('headphones')).toBe(true);
    await host.reboot();
    expect(made[1]?.outputDevice).toBe('headphones');
  });

  it('reboots again when asked during a reboot (the newest settings win)', async () => {
    const made: FakeEngine[] = [];
    const host = new EngineHost(() => {
      const e = new FakeEngine();
      made.push(e);
      return e;
    });
    const first = host.reboot();
    const second = host.reboot();
    await Promise.all([first, second]);
    // One for the first request, and one more because a request came in while it ran.
    expect(made).toHaveLength(3);
    // Nothing queued: asking once more is one more engine, not two.
    await host.reboot();
    expect(made).toHaveLength(4);
  });

  it('starts playing again only once the new engine has loaded its sounds', async () => {
    let release: () => void = () => {};
    const made: FakeEngine[] = [];
    const host = new EngineHost(() => {
      const e = new FakeEngine();
      if (made.length > 0) e.ready = () => new Promise<void>((r) => (release = r));
      made.push(e);
      return e;
    });
    host.play();
    const done = host.reboot();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    // Loading: notes sent now would be dropped by instruments that don't exist yet.
    expect(made[1]?.playing).toBe(false);
    release();
    await done;
    expect(made[1]?.playing).toBe(true);
  });

  it('does not count in again when playback resumes after a reboot', async () => {
    const seen: number[] = [];
    const made: FakeEngine[] = [];
    const host = new EngineHost(() => {
      const e = new FakeEngine();
      const play = e.play.bind(e);
      e.play = (from) => {
        seen.push(e.session.countInBars);
        play(from);
      };
      made.push(e);
      return e;
    });
    host.setSession({ metronome: true, countInBars: 2 });
    host.play();
    await host.reboot();
    expect(seen).toEqual([2, 0]);
    // The session setting is still the user's.
    expect(made[1]?.session.countInBars).toBe(2);
  });

  it('keeps the running engine when a new one cannot be made', async () => {
    let fail = false;
    const made: FakeEngine[] = [];
    const host = new EngineHost(() => {
      if (fail) throw new Error('no audio device');
      const e = new FakeEngine();
      made.push(e);
      return e;
    });
    let notified = 0;
    host.subscribe(() => notified++);
    fail = true;
    await expect(host.reboot()).rejects.toThrow('no audio device');
    host.play();
    expect(made[0]?.playing).toBe(true);
    expect(notified).toBeGreaterThan(0);
  });
});
