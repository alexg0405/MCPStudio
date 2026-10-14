import { describe, expect, it } from 'vitest';
import type { AutomationChannel, AutomationClip, ChannelId, ClipId, LaneId } from '@core/model/types';
import { Viewport } from '../../timeline/viewport';
import { contentToTick, handleOf, hitAutomation, tickToContent, valueToY, yToValue } from './automation';
import { clipBox } from './clip-geometry';

const clip: AutomationClip = {
  kind: 'automation',
  id: 'clip_a' as ClipId,
  laneId: 'lane_a' as LaneId,
  channelId: 'ch_a' as ChannelId,
  start: 3840,
  length: 3840,
  offset: 960,
};
const ch: AutomationChannel = {
  kind: 'automation',
  id: 'ch_a' as ChannelId,
  name: 'Auto',
  color: '#80a0c0',
  muted: false,
  solo: false,
  target: { kind: 'tempo' },
  points: [
    { tick: 960, value: 0 },
    { tick: 2880, value: 1 },
    { tick: 4800, value: 0.5, shape: 'hold' },
  ],
};

function setup(rowHeight = 80) {
  const vp = new Viewport(4);
  vp.pxPerTick = 0.1;
  vp.rowHeight = rowHeight;
  vp.width = 1000;
  vp.height = 400;
  return { vp, box: clipBox(vp, 0, clip) };
}

describe('automation clips on the playlist', () => {
  it('maps values and content ticks to the clip body and back', () => {
    const { box } = setup();
    for (const v of [0, 0.25, 1]) expect(yToValue(valueToY(v, box), box)).toBeCloseTo(v, 9);
    expect(valueToY(1, box)).toBeLessThan(valueToY(0, box));
    expect(contentToTick(clip, 960)).toBe(3840);
    expect(tickToContent(clip, 3840 + 100)).toBe(1060);
  });

  it('finds points, curve handles and empty curve under the pointer', () => {
    const { vp, box } = setup();
    const at = (tick: number, v: number) => [vp.tickToX(contentToTick(clip, tick)), valueToY(v, box)] as const;
    expect(hitAutomation(vp, clip, ch, box, ...at(2880, 1))).toEqual({ part: 'point', index: 1 });
    const h = handleOf(ch.points, 0)!;
    expect(h.tick).toBe(1920);
    expect(hitAutomation(vp, clip, ch, box, ...at(h.tick, h.value))).toEqual({ part: 'handle', index: 0 });
    // A held segment has no handle; the title bar is the clip's, not the curve's.
    expect(handleOf(ch.points, 2)).toBeNull();
    expect(hitAutomation(vp, clip, ch, box, ...at(2000, 0.9))).toEqual({ part: 'curve' });
    expect(hitAutomation(vp, clip, ch, box, at(2000, 0)[0], box.y + 4)).toBeNull();
    const low = setup(22);
    expect(hitAutomation(low.vp, clip, ch, low.box, at(2000, 0)[0], low.box.bodyY + 2)).toEqual({ part: 'small' });
  });
});
