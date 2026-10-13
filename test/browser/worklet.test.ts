import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { NoteId, PatternId } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import { renderOffline } from '@engine/render-offline';
import { defaultValues, defineWorkletInstrument, type PluginDef } from '@agstudio/sdk';
import processor from './impulse.worklet.ts?worker&url';
import { peak, resolver } from '../helpers/fixtures';
import { automate, firstDifference, pt } from '../helpers/automation';
import { heldNote, tone } from '../helpers/tone';

const SR = 48000;
const impulse = defineWorkletInstrument({ id: 'test.impulse', name: 'Impulse', version: 1, params: {}, processor });
const LIMITER_DELAY = Math.round(0.0013 * SR);

/** At 3000 BPM and 48 kHz one tick is exactly one frame, so notes can target any frame. */
function impulseProject(frames: number[], preRollFrames: number) {
  let project = createEmptyProject();
  const pid = project.patternOrder[0] as PatternId;
  const ch = makeInstrumentChannel('Impulse', makePluginInstance(impulse.id, 1, defaultValues(impulse.params)));
  const last = Math.max(...frames) - preRollFrames;
  project = produce(project, (d) => {
    d.transport.bpm = 3000;
    addChannel(d, ch);
    d.patterns[pid]!.length = Math.ceil((last + 10) / 3840) * 3840;
    frames.forEach((f, i) =>
      addNote(d, pid, ch.id, { id: `n${i}` as NoteId, tick: f - preRollFrames, length: 1, key: 60, velocity: 1 }),
    );
  });
  return { project, pid, bars: project.patterns[pid]!.length! / 3840 };
}

function spikes(buffer: AudioBuffer): number[] {
  const d = buffer.getChannelData(0);
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i] as number) > 0.2) out.push(i);
  return out;
}

describe('worklet instruments offline', () => {
  for (const chunk of [128 * 16, 128 * 37, 128 * 256]) {
    it(`lands notes on exact frames around chunk boundaries (chunk ${chunk})`, async () => {
      const pre = 2048;
      // Suspensions happen at 128 + k·chunk; test the frames either side of two boundaries.
      const b1 = 128 + chunk * Math.ceil((pre + 200) / chunk);
      const b2 = b1 + chunk;
      const frames = [b1 - 1, b1, b1 + 1, b2 - 1, b2, b2 + 1];
      const { project, pid, bars } = impulseProject(frames, pre);
      const { buffer, synced } = await renderOffline(project, {
        plugins: resolver(impulse as PluginDef),
        view: { mode: 'pattern', patternId: pid, loop: null },
        bars,
        sampleRate: SR,
        preRoll: pre / SR,
        tail: 0.05,
        chunk,
      });
      expect(synced).toBe(true);
      expect(spikes(buffer)).toEqual(frames.map((f) => f + LIMITER_DELAY));
    });
  }
});

describe('built-in instruments', () => {
  const ids = ['agstudio.sampler', 'agstudio.3xosc', 'agstudio.pluck'];
  const builtins = import.meta.glob<{ default: PluginDef }>('/src/plugins/builtin/*/index.ts', { eager: true });
  const defs = Object.values(builtins).map((m) => m.default);

  it('are all discovered', () => {
    for (const id of ids) expect(defs.map((d) => d.id)).toContain(id);
  });

  for (const id of ['agstudio.3xosc', 'agstudio.pluck']) {
    it(`${id} renders a finite, audible chord and is deterministic`, async () => {
      const def = defs.find((d) => d.id === id)!;
      let project = createEmptyProject();
      const pid = project.patternOrder[0] as PatternId;
      const ch = makeInstrumentChannel(def.name, makePluginInstance(def.id, def.version, defaultValues(def.params)));
      project = produce(project, (d) => {
        d.transport.bpm = 120;
        addChannel(d, ch);
        [60, 64, 67].forEach((key, i) =>
          addNote(d, pid, ch.id, { id: `c${i}` as NoteId, tick: 0, length: 1920, key, velocity: 0.8 }),
        );
      });
      const opts = {
        plugins: { get: (x: string) => defs.find((d) => d.id === x) },
        view: { mode: 'pattern' as const, patternId: pid, loop: null },
        bars: 1,
        sampleRate: SR,
      };
      const a = (await renderOffline(project, opts)).buffer;
      const b = (await renderOffline(project, opts)).buffer;
      const da = a.getChannelData(0);
      const db = b.getChannelData(0);
      let peak = 0;
      let diff = 0;
      for (let i = 0; i < da.length; i++) {
        const x = da[i] as number;
        expect(Number.isFinite(x)).toBe(true);
        peak = Math.max(peak, Math.abs(x));
        diff = Math.max(diff, Math.abs(x - (db[i] as number)));
      }
      expect(peak).toBeGreaterThan(0.02);
      expect(peak).toBeLessThanOrEqual(Math.pow(10, -0.3 / 20) + 1e-6);
      // Kernels are bit-exact; Chrome's native oscillators can differ by ~1e-8 between renders.
      expect(diff).toBeLessThan(1e-6);
    });
  }
});

describe('automation offline', () => {
  it('renders bit-exact at chunk sizes 128·16, 128·37 and 128·256', async () => {
    const BAR = 3840;
    const { project: base, pid, ch } = heldNote(tone, 4, 120, 960);
    const owner = { kind: 'channel' as const, channelId: ch };
    // A bent curve on the kernel's own a-rate param, a stairs volume over a clip boundary, pan holds.
    let project = automate(
      base,
      { kind: 'plugin', owner, paramId: 'level' },
      [pt(0, 0.2), pt(1920, 1, { tension: 0.5 }), pt(5760, 0.1, { shape: 'smooth' }), pt(7680, 0.6)],
      [{ start: 0, length: 2 * BAR, lane: 1 }],
    ).project;
    project = automate(
      project,
      { kind: 'channel', channelId: ch, param: 'volume' },
      [pt(0, 0.9, { shape: 'stairs' }), pt(3840, 0.3), pt(7680, 1)],
      [{ start: 1920, length: 3 * BAR, lane: 2 }],
    ).project;
    project = automate(
      project,
      { kind: 'channel', channelId: ch, param: 'pan' },
      [pt(0, 0, { shape: 'hold' }), pt(960, 1, { shape: 'hold' }), pt(1920, 0.5)],
      [{ start: 0, length: 4 * BAR, lane: 3 }],
    ).project;
    const render = async (chunk: number, pr = project) =>
      (
        await renderOffline(pr, {
          plugins: resolver(tone),
          // The loop wraps once inside the render.
          view: { mode: 'song', patternId: pid, loop: { start: 960, end: 3 * BAR + 480 } },
          bars: 5,
          sampleRate: SR,
          tail: 0.05,
          chunk,
        })
      ).buffer;
    const a = await render(128 * 16);
    expect(peak(a)).toBeGreaterThan(0.05);
    for (const chunk of [128 * 37, 128 * 256]) expect(firstDifference(a, await render(chunk))).toBe(-1);
    // (The automation is what's being compared: without it the render differs early on.)
    expect(firstDifference(a, await render(128 * 16, base))).toBeLessThan(SR);
  });
});
