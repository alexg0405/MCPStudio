import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { makePluginInstance } from '@core/model/defaults';
import type { InsertId, Project } from '@core/model/types';
import { addFxSlot, setFxSlotEnabled } from '@core/ops/mixer';
import { renderOffline } from '@engine/render-offline';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import { defineFaustEffect, defineFaustInstrument } from '@agstudio/sdk/faust';
import gainDsp from './faust/gain.dsp';
import voiceDsp from '../../templates/instrument-faust/voice.dsp';
import { firstDifference } from '../helpers/automation';
import { onsets, resolver } from '../helpers/fixtures';
import { channelsProject, sine, SR } from '../helpers/routing';

const gain = defineFaustEffect({ id: 'test.faust-gain', name: 'Faust gain', version: 1, dsp: gainDsp }) as PluginDef;
const synth = defineFaustInstrument({
  id: 'test.faust-voice',
  name: 'Faust voice',
  version: 1,
  dsp: voiceDsp,
}) as PluginDef;
const plugins = () => resolver(gain, synth, sine);

const render = async (project: Project, patternId: string, opts: { chunk?: number; bars?: number } = {}) =>
  (
    await renderOffline(project, {
      plugins: plugins(),
      view: { mode: 'pattern', patternId: patternId as never, loop: null },
      bars: opts.bars ?? 1,
      sampleRate: SR,
      tail: 0.5,
      ...(opts.chunk ? { chunk: opts.chunk } : {}),
    })
  ).buffer;

const rms = (b: AudioBuffer, from: number, to: number) => {
  const d = b.getChannelData(0);
  let s = 0;
  for (let i = from; i < to; i++) s += (d[i] as number) ** 2;
  return Math.sqrt(s / (to - from));
};

describe('Faust plugins', () => {
  it('runs a Faust effect on a mixer track, following its params', async () => {
    const base = channelsProject([{ def: sine, notes: [[0, 3840, 69]], insert: 1 }]);
    const ins = base.ins[1] as InsertId;
    const withGain = (level?: number, enabled = true) =>
      produce(base.project, (d) => {
        const slot = addFxSlot(d, ins, makePluginInstance(gain.id, gain.version, { ...defaultValues(gain.params), ...(level === undefined ? {} : { level }) }));
        if (!enabled && slot) setFxSlotEnabled(d, ins, slot, false);
      });
    const window = (b: AudioBuffer) => rms(b, Math.round(0.5 * SR), Math.round(1.5 * SR));
    const dry = window(await render(withGain(undefined, false), base.patternId));
    expect(dry).toBeGreaterThan(0.01);
    // Default Level 0.5 = −6 dB; 0.25 = −12 dB.
    expect(window(await render(withGain(), base.patternId)) / dry).toBeCloseTo(0.5, 2);
    expect(window(await render(withGain(0.25), base.patternId)) / dry).toBeCloseTo(0.25, 2);
  });

  it('plays a Faust instrument polyphonically, on the exact frame, and goes quiet after release', async () => {
    // A note on each beat of a bar at 120 BPM (0.5 s apart), the last one a chord.
    const notes: [number, number, number][] = [
      [0, 480, 57],
      [960, 480, 60],
      [1920, 480, 64],
      [2880, 480, 60],
      [2880, 480, 64],
      [2880, 480, 67],
    ];
    const made = channelsProject([{ def: synth, notes, insert: 1 }]);
    const { patternId } = made;
    // A short release, so each note is silent again before the next (onsets need the gap).
    const project = produce(made.project, (d) => {
      const ch = d.channels[made.channels[0]!];
      if (ch?.kind === 'instrument') Object.assign(ch.plugin.params, { attack: 0.001, release: 0.02 });
    });
    const a = await render(project, patternId);
    const pre = Math.round((2048 / SR) * SR);
    const found = onsets(a, 0.01, 0.2).map((f) => f - pre);
    expect(found.length).toBe(4);
    // Each note starts on its frame (within the envelope's first few samples).
    found.forEach((f, i) => expect(Math.abs(f - i * 0.5 * SR)).toBeLessThan(0.006 * SR));
    // The chord is louder than a single note.
    const one = rms(a, pre + Math.round(1.0 * SR), pre + Math.round(1.2 * SR));
    const chord = rms(a, pre + Math.round(1.5 * SR), pre + Math.round(1.7 * SR));
    expect(chord).toBeGreaterThan(one * 1.3);
    // Released and silent by the end of the tail.
    expect(rms(a, a.length - Math.round(0.05 * SR), a.length)).toBeLessThan(1e-4);
    // Deterministic, at any render chunk size.
    expect(firstDifference(a, await render(project, patternId, { chunk: 128 * 37 }))).toBe(-1);
  });
});
