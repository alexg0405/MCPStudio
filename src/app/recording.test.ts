import { describe, expect, it } from 'vitest';
import { FakeEngine } from '@engine/fake-engine';
import { RecordController } from './recording';

describe('RecordController', () => {
  it('starts recorders when playback starts while armed, and stops them with playback', () => {
    const engine = new FakeEngine();
    const rec = new RecordController(engine);
    const log: string[] = [];
    rec.register({ id: 'notes', start: ({ tick }) => log.push(`start ${tick}`), stop: () => log.push('stop') });
    engine.play();
    engine.stop();
    expect(log).toEqual([]); // not armed
    rec.toggle();
    expect(rec.armed).toBe(true);
    engine.play();
    expect(rec.recording).toBe(true);
    engine.stop();
    expect(rec.recording).toBe(false);
    expect(log).toEqual(['start 0', 'stop']);
    // Disarming while recording stops the recorders.
    engine.play();
    rec.setArmed(false);
    expect(log).toEqual(['start 0', 'stop', 'start 0', 'stop']);
  });
});
