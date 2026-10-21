/**
 * An effect slot at mix 1 that nothing automates has no dry/wet stage (no constant source, no dry path): it must sound
 * exactly like the slot with the stage, which is what a slot has once its mix has moved. Each case renders the same song
 * two ways, one that never leaves mix 1 (no stage) and one that goes through the stage (the mix starts elsewhere and is
 * edited, or automation drives it), and the two renders must match to the last bit. The effects are a feedback delay
 * and the limiter, which reports latency, so the latency-aligned dry path is covered too.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { ParamTarget, Project, SlotId } from '@core/model/types';
import { setFxSlotMix } from '@core/ops/mixer';
import { renderOffline } from '@engine/render-offline';
import delay from '../../src/plugins/builtin/delay';
import limiter from '../../src/plugins/builtin/limiter';
import type { PluginDef } from '@agstudio/sdk';
import { automate, pt } from '../helpers/automation';
import { resolver, withInsert } from '../helpers/fixtures';
import { heldNote, noise } from '../helpers/tone';

const SR = 48000;
const BAR = 3840;

interface Rig {
  project: Project;
  patternId: ReturnType<typeof heldNote>['pid'];
  slot: SlotId;
  insertId: ReturnType<typeof withInsert>['insertId'];
}

function rig(effect: PluginDef): Rig {
  const one = heldNote(noise, 2);
  const routed = withInsert(one.project, [one.ch], { fx: [{ def: effect }] });
  return { project: routed.project, patternId: one.pid, slot: routed.slots[0] as SlotId, insertId: routed.insertId };
}

const render = (project: Project, patternId: Rig['patternId']) =>
  renderOffline(project, {
    plugins: resolver(noise),
    view: { mode: 'song', patternId, loop: null },
    bars: 2,
    sampleRate: SR,
    tail: 0.3,
  });

/** True when the two renders are the same samples. */
function identical(a: AudioBuffer, b: AudioBuffer): boolean {
  if (a.length !== b.length) return false;
  for (let channel = 0; channel < a.numberOfChannels; channel++) {
    const left = a.getChannelData(channel);
    const right = b.getChannelData(channel);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

const withMix = (rigged: Rig, mix: number): Project =>
  produce(rigged.project, (draft) => setFxSlotMix(draft, rigged.insertId, rigged.slot, mix));

describe.each([
  ['a delay', delay as PluginDef],
  ['the limiter (reports latency)', limiter as PluginDef],
])('slot mix stage, %s', (_name, effect) => {
  it('a slot at mix 1 sounds the same as one whose mix was moved and set back (the stage exists)', async () => {
    const rigged = rig(effect);
    const lean = await renderStaged(rigged, 1, 1);
    // Mix 0.5 in the first version the engine loads, then 1 in the next (before any sound): the stage exists.
    const staged = await renderStaged(rigged, 0.5, 1);
    expect(identical(lean.buffer, staged.buffer)).toBe(true);
  });

  it('a slot below mix 1 is built with the stage from the start and sounds like the same mix reached by an edit', async () => {
    const rigged = rig(effect);
    const direct = await renderStaged(rigged, 0.4, 0.4);
    const edited = await renderStaged(rigged, 1, 0.4);
    expect(identical(direct.buffer, edited.buffer)).toBe(true);
  });

  it('automation of the mix drives the slot the same whatever mix the document starts at', async () => {
    const rigged = rig(effect);
    const target: ParamTarget = { kind: 'slot', insertId: rigged.insertId, slotId: rigged.slot, param: 'mix' };
    const curve = [pt(0, 1), pt(BAR, 0.3)];
    const clips = [{ start: 0, length: 2 * BAR, lane: 1 }];
    const fromOne = automate(withMix(rigged, 1), target, curve, clips).project;
    const fromHalf = automate(withMix(rigged, 0.5), target, curve, clips).project;
    const a = await render(fromOne, rigged.patternId);
    const b = await render(fromHalf, rigged.patternId);
    expect(identical(a.buffer, b.buffer)).toBe(true);
    // And it really moves the sound: the same song with the mix held at 1 is different.
    const held = await render(withMix(rigged, 1), rigged.patternId);
    expect(identical(a.buffer, held.buffer)).toBe(false);
  });
});

/** Renders the project through one offline engine that loads it at mix `from` and then takes an edit to mix `to` (before any sound). */
async function renderStaged(rigged: Rig, from: number, to: number): Promise<{ buffer: AudioBuffer }> {
  const { Engine } = await import('@engine/engine');
  const first = withMix(rigged, from);
  const second = withMix(rigged, to);
  const length = SR * 6;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: SR });
  const engine = new Engine(ctx, { plugins: resolver(noise) }, true);
  engine.applyDocChange({ next: first, prev: first, patches: null, origin: 'load' });
  engine.applyDocChange({ next: second, prev: first, patches: [], origin: 'edit' });
  engine.setTransportView({ mode: 'song', patternId: rigged.patternId, loop: null });
  await engine.ready();
  const preRoll = 2048 / SR;
  engine.startOffline(0, preRoll);
  engine.pumpOffline(preRoll + 2 * engine.barSeconds() + 0.3);
  await engine.syncWorklets();
  const buffer = await ctx.startRendering();
  await engine.dispose();
  return { buffer };
}
