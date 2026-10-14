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
});
