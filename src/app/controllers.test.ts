import { describe, expect, it } from 'vitest';
import type { ChannelId, ParamTarget } from '@core/model/types';
import { createTestServices } from './testing';

describe('MIDI controller links', () => {
  it('learns the next controller and drives the target with it, merging the undo steps', async () => {
    const s = createTestServices();
    const ch = s.doc.getState().project.channelOrder[0] as ChannelId;
    const target: ParamTarget = { kind: 'channel', channelId: ch, param: 'pan' };
    const learned = s.controllers.learn(target);
    s.live.controlChange(64, 1, { source: 'midi', device: 'Pad', midiChannel: 0 }); // sustain: ignored
    s.live.controlChange(74, 0.5, { source: 'midi', device: 'Pad', midiChannel: 0 });
    const link = await learned;
    expect(link).toMatchObject({ cc: 74, channel: 0, device: 'Pad', target });
    s.live.controlChange(74, 0, { source: 'midi', device: 'Pad', midiChannel: 0 });
    const cursor = s.history.status().cursor;
    for (const v of [0.25, 1]) s.live.controlChange(74, v, { source: 'midi', device: 'Pad', midiChannel: 0 });
    const pan = () => {
      const c = s.doc.getState().project.channels[ch]!;
      return c.kind === 'instrument' ? c.pan : NaN;
    };
    expect(pan()).toBeCloseTo(1);
    expect(s.fakeEngine.touched.has(`ch:${ch}:pan`)).toBe(true);
    // The moves merge into one undo step.
    expect(s.history.status().cursor).toBe(cursor);
    // Another channel's controller doesn't move it; unlinking stops it.
    s.live.controlChange(74, 0, { source: 'midi', device: 'Pad', midiChannel: 3 });
    expect(pan()).toBeCloseTo(1);
    s.controllers.unlink(target);
    s.live.controlChange(74, 0, { source: 'midi', device: 'Pad', midiChannel: 0 });
    expect(pan()).toBeCloseTo(1);
  });
});
