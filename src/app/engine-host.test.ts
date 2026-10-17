import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps the old engine playing while the new one loads, then hands the song over', async () => {
    let release: () => void = () => {};
    const made: FakeEngine[] = [];
    const disposed: FakeEngine[] = [];
    const host = new EngineHost(() => {
      const e = new FakeEngine();
      if (made.length > 0) e.ready = () => new Promise<void>((r) => (release = r));
      const dispose = e.dispose.bind(e);
      e.dispose = () => (disposed.push(e), dispose());
      made.push(e);
      return e;
    });
    const project = createEmptyProject();
    host.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    host.play();
    const done = host.reboot();
    await new Promise((r) => setTimeout(r, 5));
    // Loading: the old engine still plays (no gap), and an edit made now reaches both.
    expect(made[0]?.playing).toBe(true);
    expect(made[1]?.playing).toBe(false);
    const edited = createEmptyProject();
    host.applyDocChange({ next: edited, prev: project, patches: null, origin: 'edit' });
    expect(made[0]?.changes.at(-1)?.next).toBe(edited);
    expect(made[1]?.changes.at(-1)?.next).toBe(edited);
    release();
    await done;
    expect(made[1]?.playing).toBe(true);
    // The old one fades out a moment later, when the new one is heard.
    await new Promise((r) => setTimeout(r, 120));
    expect(disposed).toEqual([made[0]]);
    // Calls go to the new engine.
    host.stop();
    expect(made[1]?.playing).toBe(false);
  });

  it('does not start the new engine when playback was stopped while it loaded', async () => {
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
    await new Promise((r) => setTimeout(r, 5));
    host.stop();
    release();
    await done;
    expect(made[1]?.playing).toBe(false);
    expect(host.playing).toBe(false);
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

describe('EngineHost, deferred', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake engine that records live notes and whose sounds load when `loaded()` is called. */
  function rig() {
    const made: FakeEngine[] = [];
    const log: string[] = [];
    const waves: unknown[] = [];
    let loaded: () => void = () => {};
    const host = new EngineHost(
      () => {
        const e = new FakeEngine();
        e.ready = () => new Promise<void>((r) => (loaded = r));
        e.previewNoteOn = ((_c: string, key?: number) => (log.push(`on ${key}`), 100 + log.length)) as never;
        e.previewNoteOff = ((_c: string, id?: number) => void log.push(`off ${id}`)) as never;
        const play = e.play.bind(e);
        e.play = (from) => (log.push('play'), play(from));
        e.waveform = ((r: unknown) => (waves.push(r), null)) as never;
        made.push(e);
        return e;
      },
      { deferred: true },
    );
    return { host, made, log, waves, loaded: () => loaded() };
  }

  it('makes no engine until something needs sound, and answers calmly meanwhile', () => {
    const { host, made } = rig();
    expect(made).toHaveLength(0);
    expect(host.started).toBe(false);
    expect(host.state).toBe('suspended');
    expect(host.playing).toBe(false);
    expect(host.playhead()).toBe(0);
    expect(host.stats().state).toBe('suspended');
    expect(host.waveform({ source: { kind: 'builtin', id: 'x' } as never })).toBeNull();
    const peaks = new Float32Array(4).fill(1);
    host.readMeters(['a' as never, 'b' as never], peaks);
    expect([...peaks]).toEqual([0, 0, 0, 0]);
    const out = new Float64Array(2);
    host.readAutomation(['k1', 'k2'], out);
    expect(Number.isNaN(out[0])).toBe(true);
    host.stop();
    host.panic();
    expect(made).toHaveLength(0);
  });

  it('makes the engine on its own a moment later and hands it the project, view, session and output device', async () => {
    vi.useFakeTimers();
    const { host, made } = rig();
    const project = createEmptyProject();
    host.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    host.setTransportView({ mode: 'song', patternId: null, loop: null });
    host.setSession({ metronome: true, countInBars: 1 });
    host.setSongOpenEnded(true);
    const device = host.setOutputDevice('headphones');
    let notified = 0;
    host.subscribe(() => notified++);
    expect(made).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(made).toHaveLength(1);
    const e = made[0] as FakeEngine;
    expect(e.changes[0]).toMatchObject({ origin: 'load', next: project });
    expect(e.view).toEqual({ mode: 'song', patternId: null, loop: null });
    expect(e.session).toEqual({ metronome: true, countInBars: 1 });
    expect(e.openEnded).toBe(true);
    expect(e.outputDevice).toBe('headphones');
    await expect(device).resolves.toBe(true);
    expect(notified).toBeGreaterThan(0);
    expect(host.started).toBe(true);
  });

  it('a resume before the engine exists waits for it and resumes it, without making it inside the call', async () => {
    const { host, made } = rig();
    let done = false;
    void host.resume().then(() => (done = true));
    await Promise.resolve();
    expect(made).toHaveLength(0);
    expect(done).toBe(false);
    host.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(made).toHaveLength(1);
    expect(done).toBe(true);
  });

  it('a live note makes the engine and is played once its sounds have loaded; a tap is not lost', () => {
    vi.useFakeTimers();
    const { host, made, log, loaded } = rig();
    const held = host.previewNoteOn('c' as never, 60, 0.8);
    expect(made).toHaveLength(1);
    // The instruments are loading: nothing reached the engine yet.
    expect(log).toEqual([]);
    const tapped = host.previewNoteOn('c' as never, 64, 0.8);
    host.previewNoteOff('c' as never, tapped);
    loaded();
    return Promise.resolve().then(() => {
      expect(log).toEqual(['on 60', 'on 64']);
      // The held key is still down: its release reaches the engine under the id the engine gave.
      host.previewNoteOff('c' as never, held);
      expect(log.at(-1)).toBe('off 101');
      // The tap sounds a short while, then ends by itself.
      vi.advanceTimersByTime(100);
      expect(log.at(-1)).toBe('off 102');
      // Notes after the load go straight through.
      const id = host.previewNoteOn('c' as never, 67, 0.8);
      expect(log.at(-1)).toBe('on 67');
      host.previewNoteOff('c' as never, id);
      expect(log.at(-1)).toBe(`off ${id}`);
    });
  });

  it('play waits for the sounds, shows as playing meanwhile, and stop cancels it', async () => {
    vi.useFakeTimers();
    const { host, made, log, loaded } = rig();
    host.play(480);
    expect(made).toHaveLength(1);
    expect(host.playing).toBe(true);
    expect(log).toEqual([]);
    loaded();
    await Promise.resolve();
    expect(log).toEqual(['play']);
    expect((made[0] as FakeEngine).lastPlayFrom).toBe(480);

    const second = rig();
    second.host.play();
    second.host.stop();
    expect(second.host.playing).toBe(false);
    second.loaded();
    await Promise.resolve();
    expect(second.log).toEqual([]);
  });

  it('plays anyway when the sounds take too long to load', () => {
    vi.useFakeTimers();
    const { host, log } = rig();
    host.play();
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1600);
    expect(log).toEqual(['play']);
  });

  it('a reboot before the engine exists just makes it', async () => {
    const { host, made } = rig();
    await host.reboot();
    expect(made).toHaveLength(1);
  });

  it('decodes the overviews asked for before the engine existed once it does', () => {
    const { host, waves } = rig();
    const ref = { source: { kind: 'embedded', hash: 'abc', ext: 'wav' } } as never;
    expect(host.waveform(ref)).toBeNull();
    host.waveform(ref);
    expect(waves).toHaveLength(0);
    host.start();
    // Once, however often it was asked.
    expect(waves).toHaveLength(1);
    host.waveform(ref);
    expect(waves).toHaveLength(2);
  });
});
