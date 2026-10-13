import { describe, expect, it } from 'vitest';
import { gridTicks, snapFloor, snapRound } from './snap';

const ts = { num: 4, den: 4 };

describe('snap grids', () => {
  it('maps FL grid names to ticks, including triplets', () => {
    expect(gridTicks('bar', ts)).toBe(3840);
    expect(gridTicks('beat', ts)).toBe(960);
    expect(gridTicks('beat/3', ts)).toBe(320);
    expect(gridTicks('beat/6', ts)).toBe(160);
    expect(gridTicks('step', ts)).toBe(240);
    expect(gridTicks('step/3', ts)).toBe(80);
    expect(gridTicks('step/4', ts)).toBe(60);
    expect(gridTicks('none', ts)).toBe(1);
    expect(gridTicks('beat', { num: 6, den: 8 })).toBe(480);
  });

  it('auto follows the zoom level', () => {
    expect(gridTicks('auto', ts, 0.2)).toBe(60); // 60 ticks = 12 px
    expect(gridTicks('auto', ts, 0.05)).toBe(240); // 240 ticks = 12 px
    expect(gridTicks('auto', ts, 0.005)).toBe(3840);
  });

  it('rounds and floors to the grid', () => {
    expect(snapRound(130, 240)).toBe(240);
    expect(snapRound(110, 240)).toBe(0);
    expect(snapFloor(479, 240)).toBe(240);
    expect(snapRound(12.6, 1)).toBe(13);
  });
});
