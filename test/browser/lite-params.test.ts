/**
 * Worklet plugins nothing automates run as the kernel's lite processor (no AudioParams: every param
 * is an event), which costs the audio thread far less; the first automation of one of their params
 * swaps in the full processor. Sound must not depend on which one runs.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makeInstrumentChannel, makePluginInstance, createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type ChannelId, type Project } from '@core/model/types';
import { addChannel, setPluginParam } from '@core/ops/channels';
import { addFxSlot } from '@core/ops/mixer';
import { addNotes } from '@core/ops/notes';
import { Engine } from '@engine/engine';
import { renderOffline } from '@engine/render-offline';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import fm from '../../src/plugins/builtin/fm';
import saturator from '../../src/plugins/builtin/saturator';
import { automate, pt } from '../helpers/automation';
import { peak, resolver } from '../helpers/fixtures';

const SR = 48000;

function song(): { project: Project; channelId: ChannelId; patternId: string } {
  let channelId = '' as ChannelId;
  const base = createEmptyProject();
  const patternId = base.patternOrder[0] as string;
  const project = produce(base, (d) => {
    const ch = makeInstrumentChannel('FM', makePluginInstance(fm.id, fm.version, defaultValues((fm as PluginDef).params)));
    channelId = ch.id;
    addChannel(d, ch);
    addNotes(d, patternId as never, ch.id, [
      { id: newId.note(), tick: 0, length: 480, key: 60, velocity: 0.9 },
      { id: newId.note(), tick: 960, length: 480, key: 67, velocity: 0.8 },
    ]);
    addFxSlot(d, MASTER, makePluginInstance(saturator.id, saturator.version, defaultValues((saturator as PluginDef).params)));
  });
  return { project, channelId, patternId };
}

/** How many AudioParams each live worklet node has (instruments carry one for the channel pitch). */
function paramCounts(engine: Engine): number[] {
  return [...engine.ports].map((p) => p.node.parameters.size).sort((a, b) => a - b);
}

const load = (engine: Engine, project: Project) =>
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });

describe('lite worklet params', () => {
  it('runs plugins nothing automates without AudioParams, and gives them back when automation arrives', async () => {
    const { project, channelId } = song();
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
    const engine = new Engine(ctx, { plugins: resolver(fm as PluginDef, saturator as PluginDef) }, false);
    load(engine, project);
    await engine.ready();
    // The effect has none, the instrument only its pitch.
    expect(paramCounts(engine)).toEqual([0, 1]);

    // Automating one of the FM synth's params: it is replaced by a full instance with its AudioParams.
    const { project: automated } = automate(
      project,
      { kind: 'plugin', owner: { kind: 'channel', channelId }, paramId: 'vibratoRate' },
      [pt(0, 0.5), pt(3840, 0.5)],
      [{ start: 0, length: 3840 }],
    );
    engine.applyDocChange({ next: automated, prev: project, patches: [], origin: 'edit' });
    await engine.ready();
    const after = paramCounts(engine);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(0); // the saturator stays lite
    expect(after[1]).toBeGreaterThan(30);
    await engine.dispose();
  }, 30_000);

  it('sounds the same as the full processor', async () => {
    const { project, channelId, patternId } = song();
    const render = (p: Project) =>
      renderOffline(p, {
        plugins: resolver(fm as PluginDef, saturator as PluginDef),
        view: { mode: 'pattern', patternId: patternId as never, loop: null },
        bars: 1,
        sampleRate: SR,
        tail: 0.5,
      });
    const lite = await render(project);
    // Vibrato depth is 0, so automating the rate changes how the instrument is built, not what it plays.
    const { project: full } = automate(
      project,
      { kind: 'plugin', owner: { kind: 'channel', channelId }, paramId: 'vibratoRate' },
      [pt(0, 0.5), pt(3840, 0.5)],
      [{ start: 0, length: 3840 }],
    );
    const fullRender = await render(full);
    expect(peak(lite.buffer)).toBeGreaterThan(0.05);
    expect(lite.buffer.length).toBe(fullRender.buffer.length);
    let worst = 0;
    for (let c = 0; c < 2; c++) {
      const a = lite.buffer.getChannelData(c);
      const b = fullRender.buffer.getChannelData(c);
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)));
    }
    expect(worst).toBeLessThan(1e-5);
  }, 60_000);

  it('a live knob move reaches the lite processor as an event and glides to its value', async () => {
    const { project, channelId, patternId } = song();
    const quiet = produce(project, (d) => setPluginParam(d, { kind: 'channel', channelId }, 'level', -30));
    const render = async (live: boolean) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
      // Not an `offline` engine: edits after the first load take the live path (events to the processor).
      const engine = new Engine(ctx, { plugins: resolver(fm as PluginDef, saturator as PluginDef) }, false);
      load(engine, live ? project : quiet);
      engine.setTransportView({ mode: 'pattern', patternId: patternId as never, loop: null });
      await engine.ready();
      if (live) engine.applyDocChange({ next: quiet, prev: project, patches: [], origin: 'edit' });
      engine.startOffline(0, 0.01);
      engine.pumpOffline(0.9);
      await engine.syncWorklets();
      const buffer = await ctx.startRendering();
      await engine.dispose();
      return buffer;
    };
    const start = await render(false);
    const edited = await render(true);
    const level = (b: AudioBuffer) => peak(b);
    expect(level(start)).toBeGreaterThan(0.001);
    expect(level(edited) / level(start)).toBeGreaterThan(0.97);
    expect(level(edited) / level(start)).toBeLessThan(1.03);
    // And quieter than the default (-8 dB) by about 22 dB, so the edit did arrive.
    const loud = await renderOffline(project, {
      plugins: resolver(fm as PluginDef, saturator as PluginDef),
      view: { mode: 'pattern', patternId: patternId as never, loop: null },
      bars: 1,
      sampleRate: SR,
      tail: 0,
    });
    expect(level(edited)).toBeLessThan(peak(loud.buffer) * 0.2);
  }, 60_000);
});
