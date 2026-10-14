import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, makePluginInstance } from '@core/model/defaults';
import { MASTER, type PatternId } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { renderOffline } from '@engine/render-offline';
import { defineWorkletEffect, type PluginDef } from '@agstudio/sdk';
import processor from './transport.worklet.ts?worker&url';
import { firstDifference } from '../helpers/automation';
import { resolver } from '../helpers/fixtures';

const SR = 48000;

const beatOut = defineWorkletEffect({
  id: 'test.beat-out',
  name: 'Beat out',
  version: 1,
  params: {},
  processor,
}) as PluginDef;

/** A one-bar pattern at 120 BPM (a beat is 0.5 s; the pattern loops every 2 s) with BeatOut on the master. */
function project() {
  const base = createEmptyProject();
  const patternId = base.patternOrder[0] as PatternId;
  const p = produce(base, (d) => {
    d.transport.bpm = 120;
    d.patterns[patternId]!.stepCount = 16;
    addFxSlot(d, MASTER, makePluginInstance(beatOut.id, beatOut.version, {}));
  });
  return { project: p, patternId };
}

describe('kernel transport', () => {
  const render = async (chunk: number) => {
    const { project: p, patternId } = project();
    return (
      await renderOffline(p, {
        plugins: resolver(beatOut),
        view: { mode: 'pattern', patternId, loop: null },
        bars: 2,
        sampleRate: SR,
        tail: 0,
        chunk,
      })
    ).buffer;
  };

  it('gives worklet kernels the song position, tempo and play state, loop wraps included', async () => {
    const out = await render(128 * 16);
    const l = out.getChannelData(0);
    const r = out.getChannelData(1);
    // Stopped through the pre-roll, playing from the first beat on.
    const start = r.findIndex((v) => v > 0.4);
    expect(start).toBeGreaterThan(0);
    expect(r[start - 1]).toBeCloseTo(0.25, 6);
    const beatAt = (seconds: number) => ((l[start + Math.round(seconds * SR)] as number) / (r[start] as number)) * 4;
    expect(beatAt(0)).toBeCloseTo(0, 4);
    expect(beatAt(0.5)).toBeCloseTo(1, 4);
    expect(beatAt(1.75)).toBeCloseTo(3.5, 4);
    // The one-bar pattern loops: two and a half seconds in is beat 1 again, not beat 5.
    expect(beatAt(2.5)).toBeCloseTo(1, 4);
  });

  it('is bit-exact at any render chunk size', async () => {
    const a = await render(128 * 16);
    for (const chunk of [128 * 37, 128 * 256]) expect(firstDifference(a, await render(chunk))).toBe(-1);
  });
});
