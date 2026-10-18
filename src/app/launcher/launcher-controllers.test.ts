/**
 * Pad controllers for the clip launcher: the Launchpad presets, pads pressing slots, scene and stop buttons, and the
 * lights (empty, loaded, queued, playing) through the same controller manager the DJ decks use.
 */
import { describe, expect, it } from 'vitest';
import { ensureCapacity, patchSlot, patternContent, setSlotContent } from '@core/ops/launcher';
import { launcherFixture } from '@core/launcher/test-project';
import { CONTROLLER_PRESETS, presetById, presetForDevice } from '@core/midi-map/presets';
import { isLaunchTarget, launcherTargets, parseLaunchTarget, targetInfo } from '@core/midi-map/targets';
import { DEFAULT_PAD_PALETTE, mappingFromJson, mappingToJson } from '@core/midi-map/types';
import { FakeMidiAccess, msg } from '../../../test/helpers/fake-midi';
import { learnMismatch } from '../dj/controllers/learn-rules';
import { DjControllers } from '../dj/controllers/manager';
import type { LauncherControl } from '../dj/controllers/types';
import { memoryControllerStorage } from '../dj/controllers/storage';
import { createTestServices } from '../testing';
import { launcherLeds, LauncherLeds } from './leds';
import type { PadState } from './session';

const classic = () => presetById('novation-launchpad-classic')!.mapping();
const programmer = () => presetById('novation-launchpad-mk2-mk3')!.mapping();
const addressOf = (m: ReturnType<typeof classic>, target: string) => m.bindings.filter((b) => b.target === target).map((b) => b.input);

describe('launcher targets', () => {
  it('names the pads, scene buttons, stop buttons and page buttons of an 8 × 8 page of tracks and scenes', () => {
    expect(launcherTargets()).toHaveLength(8 + 9 + 4 + 64);
    expect(parseLaunchTarget('launch.page:left')).toEqual({ kind: 'page', dir: 'left' });
    expect(parseLaunchTarget('launch.page:down')).toEqual({ kind: 'page', dir: 'down' });
    expect(parseLaunchTarget('launch.page:home')).toBeNull();
    expect(targetInfo('launch.page:up')).toMatchObject({ kind: 'button', group: 'Page buttons' });
    expect(parseLaunchTarget('launch.slot:3:7')).toEqual({ kind: 'slot', track: 3, scene: 7 });
    expect(parseLaunchTarget('launch.scene:8')).toEqual({ kind: 'scene', scene: 8 });
    expect(parseLaunchTarget('launch.stop:1')).toEqual({ kind: 'stop', track: 1 });
    expect(parseLaunchTarget('launch.stopAll')).toEqual({ kind: 'stopAll' });
    expect(parseLaunchTarget('launch.slot:9:1')).toBeNull();
    expect(parseLaunchTarget('A.play')).toBeNull();
    expect(isLaunchTarget('launch.slot:1:1')).toBe(true);
    expect(targetInfo('launch.slot:2:2')).toMatchObject({ kind: 'button', led: true, group: 'Pads: track 2' });
    expect(targetInfo('launch.stop:2')?.led).toBeUndefined();
  });
});

describe('the pad presets', () => {
  it('are picked by the device name, the newer Launchpads before the original', () => {
    expect(presetForDevice('Launchpad Mini MK3')?.id).toBe('novation-launchpad-mk2-mk3');
    expect(presetForDevice('LPX MIDI')?.id).toBe('novation-launchpad-mk2-mk3');
    expect(presetForDevice('Launchpad MK2 MIDI 1')?.id).toBe('novation-launchpad-mk2-mk3');
    expect(presetForDevice('Launchpad S')?.id).toBe('novation-launchpad-classic');
    expect(presetForDevice('Launchpad Mini')?.id).toBe('novation-launchpad-classic');
    expect(presetForDevice('Launchpad')?.id).toBe('novation-launchpad-classic');
    // The generic grid is picked by hand.
    expect(presetById('generic-pad-grid-8x8')).not.toBeNull();
    expect(CONTROLLER_PRESETS.find((p) => p.id === 'generic-pad-grid-8x8')?.match).toEqual([]);
  });

  it('map 64 pads and 8 scene buttons to real targets, each control once, with a palette and a named source', () => {
    for (const id of ['novation-launchpad-classic', 'novation-launchpad-mk2-mk3', 'generic-pad-grid-8x8']) {
      const p = presetById(id)!;
      const m = p.mapping();
      expect(p.source.length, id).toBeGreaterThan(20);
      // 64 pads + 8 scene buttons, and the arrow buttons the preset has (one set per controller family).
      expect(m.bindings.filter((b) => !b.target.startsWith('launch.page:'))).toHaveLength(72);
      expect(m.bindings.filter((b) => b.target.startsWith('launch.page:')).length).toBe(id === 'generic-pad-grid-8x8' ? 0 : id === 'novation-launchpad-classic' ? 4 : 8);
      expect(m.preset).toBe(id);
      const seen = new Set<string>();
      for (const b of m.bindings) {
        expect(targetInfo(b.target), `${id}: ${b.target}`).toBeDefined();
        expect(learnMismatch(targetInfo(b.target)!.kind, b.input, 'x')).toBeNull();
        const k = JSON.stringify(b.input);
        expect(seen.has(k), `${id}: duplicate ${k}`).toBe(false);
        seen.add(k);
      }
      for (const v of Object.values(m.pads!)) expect(v).toBeGreaterThanOrEqual(0);
      expect(new Set(Object.values(m.pads!)).size, `${id}: four different values`).toBe(4);
    }
  });

  it('the original Launchpad: note = 16 × row + column, scene buttons in column 8, top row = scene 1', () => {
    const m = classic();
    expect(addressOf(m, 'launch.slot:1:1')).toEqual([{ type: 'note', channel: 0, note: 0 }]);
    expect(addressOf(m, 'launch.slot:8:1')).toEqual([{ type: 'note', channel: 0, note: 7 }]);
    expect(addressOf(m, 'launch.slot:1:2')).toEqual([{ type: 'note', channel: 0, note: 16 }]);
    expect(addressOf(m, 'launch.slot:8:8')).toEqual([{ type: 'note', channel: 0, note: 119 }]);
    expect(addressOf(m, 'launch.scene:1')).toEqual([{ type: 'note', channel: 0, note: 8 }]);
    expect(addressOf(m, 'launch.scene:8')).toEqual([{ type: 'note', channel: 0, note: 120 }]);
    // Off, dim amber, yellow, green: the documented LED values.
    expect(m.pads).toEqual({ empty: 12, loaded: 29, queued: 62, playing: 60 });
  });

  it('the Launchpads’ arrow buttons are the page buttons: control changes 104–107 (original, S, Mini, MK2), 91–94 (Mini MK3, X)', () => {
    const c = classic();
    expect(addressOf(c, 'launch.page:up')).toEqual([{ type: 'cc', channel: 0, cc: 104 }]);
    expect(addressOf(c, 'launch.page:down')).toEqual([{ type: 'cc', channel: 0, cc: 105 }]);
    expect(addressOf(c, 'launch.page:left')).toEqual([{ type: 'cc', channel: 0, cc: 106 }]);
    expect(addressOf(c, 'launch.page:right')).toEqual([{ type: 'cc', channel: 0, cc: 107 }]);
    const p = programmer();
    expect(addressOf(p, 'launch.page:up')).toEqual([{ type: 'cc', channel: 0, cc: 104 }, { type: 'cc', channel: 0, cc: 91 }]);
    expect(addressOf(p, 'launch.page:right')).toEqual([{ type: 'cc', channel: 0, cc: 107 }, { type: 'cc', channel: 0, cc: 94 }]);
  });

  it('Launchpad MK2 / MK3: notes 11–88 from the bottom left, scene buttons 89 … 19', () => {
    const m = programmer();
    expect(addressOf(m, 'launch.slot:1:1')).toEqual([{ type: 'note', channel: 0, note: 81 }]);
    expect(addressOf(m, 'launch.slot:8:1')).toEqual([{ type: 'note', channel: 0, note: 88 }]);
    expect(addressOf(m, 'launch.slot:1:8')).toEqual([{ type: 'note', channel: 0, note: 11 }]);
    expect(addressOf(m, 'launch.slot:8:8')).toEqual([{ type: 'note', channel: 0, note: 18 }]);
    expect(addressOf(m, 'launch.scene:1')).toEqual([{ type: 'note', channel: 0, note: 89 }]);
    expect(addressOf(m, 'launch.scene:8')).toEqual([{ type: 'note', channel: 0, note: 19 }]);
    expect(m.pads).toEqual({ empty: 0, loaded: 1, queued: 13, playing: 21 });
  });

  it('keep their palette through a mapping file', () => {
    const m = classic();
    const back = mappingFromJson(mappingToJson(m))!;
    expect(back.dropped).toBe(0);
    expect(back.mapping.pads).toEqual(m.pads);
    const bad = mappingFromJson(JSON.stringify({ name: 'x', bindings: [], pads: { empty: 0, loaded: 999, queued: 1, playing: 2 } }))!;
    expect(bad.mapping.pads).toBeUndefined();
  });
});

describe('the pad lights', () => {
  const sources = (states: Record<string, PadState>, scenes: Record<number, PadState> = {}) => ({
    padState: (t: number, s: number): PadState => states[`${t}:${s}`] ?? 'empty',
    sceneState: (s: number): PadState => scenes[s] ?? 'empty',
  });

  it('light each linked pad at its own note, by the slot’s state, and send only what changed', () => {
    const sent: number[][] = [];
    const leds = new LauncherLeds((b) => sent.push(b));
    leds.setMapping(classic());
    expect(leds.active).toBe(true);
    const n = leds.update(sources({ '0:0': 'loaded', '1:0': 'playing', '0:1': 'queued' }, { 0: 'playing' }));
    expect(n).toBe(72);
    expect(sent).toContainEqual([0x90, 0, 29]); // loaded
    expect(sent).toContainEqual([0x90, 1, 60]); // playing
    expect(sent).toContainEqual([0x90, 16, 62]); // queued
    expect(sent).toContainEqual([0x90, 119, 12]); // empty
    expect(sent).toContainEqual([0x90, 8, 60]); // scene 1 button
    sent.length = 0;
    expect(leds.update(sources({ '0:0': 'loaded', '1:0': 'playing', '0:1': 'queued' }, { 0: 'playing' }))).toBe(0);
    expect(leds.update(sources({ '0:0': 'playing', '1:0': 'playing', '0:1': 'queued' }, { 0: 'playing' }))).toBe(1);
    expect(sent).toEqual([[0x90, 0, 60]]);
    leds.clear();
    expect(sent.at(-1)).toEqual([0x90, expect.any(Number), 12]);
  });

  it('use brightness steps for a learned controller, and the explicit lights a mapping lists', () => {
    const m = {
      ...classic(),
      pads: undefined,
      bindings: [{ input: { type: 'note' as const, channel: 2, note: 40 }, target: 'launch.slot:1:1' }],
      leds: [{ state: 'launch.slot:2:2', out: { type: 'cc' as const, channel: 0, number: 9 } }],
    };
    delete (m as { pads?: unknown }).pads;
    const lights = launcherLeds(m);
    expect(lights.map((l) => [l.target.kind, l.out.type, l.out.channel, l.out.number])).toEqual([
      ['slot', 'cc', 0, 9],
      ['slot', 'note', 2, 40],
    ]);
    const sent: number[][] = [];
    const leds = new LauncherLeds((b) => sent.push(b));
    leds.setMapping(m);
    leds.update(sources({ '0:0': 'playing', '1:1': 'loaded' }));
    expect(sent).toContainEqual([0x92, 40, DEFAULT_PAD_PALETTE.playing]);
    expect(sent).toContainEqual([0xb0, 9, DEFAULT_PAD_PALETTE.loaded]);
    // "Lights at button notes" off: only the explicit ones.
    expect(launcherLeds({ ...m, ledFromButtons: false })).toHaveLength(1);
  });
});

describe('pads drive the clip launcher', () => {
  /** A Launchpad Mini on the controller manager, with a recording stand-in for the launcher. */
  async function rig() {
    const access = new FakeMidiAccess();
    const dev = access.plug('Launchpad Mini');
    const calls: string[] = [];
    const states: Record<string, PadState> = {};
    let notify = () => {};
    const launcher: LauncherControl = {
      padPress: (t, s, down) => calls.push(`${down === false ? 'release' : 'press'} ${t},${s}`),
      padScene: (s) => calls.push(`scene ${s}`),
      padStop: (t) => calls.push(`stop ${t}`),
      stopAll: () => calls.push('stopAll'),
      movePage: (dir) => calls.push(`page ${dir}`),
      padState: (t, s) => states[`${t}:${s}`] ?? 'empty',
      sceneState: () => 'empty',
      subscribe: (fn) => {
        notify = fn;
        return () => {};
      },
    };
    const c = new DjControllers({
      requestAccess: async () => access.asAccess(),
      getDecks: async () => null,
      storage: memoryControllerStorage({}),
      runCommand: () => {},
      launcher: () => launcher,
    });
    await c.restore();
    await c.enable();
    return { c, dev, calls, states, notify: () => notify() };
  }

  it('a pad press and release, a scene button and a stop button reach the launcher, with no decks around', async () => {
    const { c, dev, calls } = await rig();
    expect(c.mappingFor('Launchpad Mini').preset).toBe('novation-launchpad-classic');
    dev.input.emit(msg.noteOn(0, 16 * 2 + 3)); // column 4, row 3: track 4, scene 3
    dev.input.emit(msg.noteOff(0, 16 * 2 + 3));
    dev.input.emit(msg.noteOn(0, 16 * 4 + 8)); // scene button of row 5
    dev.input.emit(msg.noteOff(0, 16 * 4 + 8));
    expect(calls).toEqual(['press 3,2', 'release 3,2', 'scene 4']);
    // The arrow buttons (control changes 104–107 on the original Launchpad).
    dev.input.emit(msg.cc(0, 106, 127));
    dev.input.emit(msg.cc(0, 106, 0));
    dev.input.emit(msg.cc(0, 105, 127));
    expect(calls.slice(3)).toEqual(['page left', 'page down']);
    calls.length = 0;
    c.setMapping('Launchpad Mini', {
      ...c.mappingFor('Launchpad Mini'),
      bindings: [
        { input: { type: 'note', channel: 0, note: 1 }, target: 'launch.stop:2' },
        { input: { type: 'note', channel: 0, note: 2 }, target: 'launch.stopAll' },
      ],
    });
    dev.input.emit(msg.noteOn(0, 1));
    dev.input.emit(msg.noteOn(0, 2));
    expect(calls).toEqual(['stop 1', 'stopAll']);
    c.disable();
  });

  it('lights every pad when the controller connects, and again when a slot changes state', async () => {
    const { c, dev, states, notify } = await rig();
    const out = dev.output!;
    // Connected: all 72 lights sent ("empty").
    expect(out.sent.filter((m) => m[0] === 0x90)).toHaveLength(72);
    expect(out.sent.every((m) => m[2] === 12)).toBe(true);
    out.clear();
    states['0:0'] = 'queued';
    notify();
    expect(out.sent).toEqual([[0x90, 0, 62]]);
    states['0:0'] = 'playing';
    notify();
    expect(out.sent.at(-1)).toEqual([0x90, 0, 60]);
    c.disable();
    // Let go: every light off.
    expect(out.sent.filter((m) => m[2] === 12).length).toBeGreaterThanOrEqual(72);
  });
});

describe('pads through the real launcher', () => {
  it('a pad press queues the slot under it, and its light shows the state', async () => {
    const f = launcherFixture();
    const s = createTestServices({ project: f.project });
    // A gate slot in track 2, scene 2.
    s.history.transact('gate', (d) => void patchSlot(d, f.tracks[1]!, f.scenes[1]!, { mode: 'gate' }));
    const access = new FakeMidiAccess();
    const dev = access.plug('Launchpad Mini');
    const c = new DjControllers({
      requestAccess: async () => access.asAccess(),
      getDecks: async () => null,
      storage: memoryControllerStorage({}),
      runCommand: () => {},
      launcher: () => s.launcher,
    });
    await c.restore();
    await c.enable();
    const light = (note: number) => dev.output!.sent.filter((m) => m[1] === note).at(-1)?.[2];
    // Filled slots are lit "loaded", the rest "empty".
    expect(light(0)).toBe(29);
    expect(light(16 * 3 + 5)).toBe(12);
    dev.input.emit(msg.noteOn(0, 0)); // track 1, scene 1
    expect(s.launcher.runs.map((r) => [r.trackId, r.sceneId])).toEqual([[f.tracks[0], f.scenes[0]]]);
    expect(light(0)).toBe(60);
    // A gate slot plays while its pad is held.
    dev.input.emit(msg.noteOn(0, 16 + 1));
    expect(s.launcher.runs.filter((r) => r.trackId === f.tracks[1])).toHaveLength(1);
    dev.input.emit(msg.noteOff(0, 16 + 1));
    expect(s.launcher.runs.find((r) => r.trackId === f.tracks[1])!.endU).not.toBeNull();
    // The scene button launches the row.
    dev.input.emit(msg.noteOn(0, 8));
    expect(s.launcher.runs.filter((r) => r.sceneId === f.scenes[0])).toHaveLength(2);
    c.disable();
  });
});

describe('paging the pads over a bigger grid', () => {
  async function rig() {
    const f = launcherFixture();
    const s = createTestServices({ project: f.project });
    // 12 tracks × 10 scenes, with a pattern in track 9, scene 9 (the first pad of the page right and down) and in track 12, scene 10.
    s.history.transact('grow', (d) => {
      const l = ensureCapacity(d, 12, 10);
      setSlotContent(d, l.trackOrder[8]!, l.sceneOrder[8]!, patternContent(f.patterns[0]!));
      setSlotContent(d, l.trackOrder[11]!, l.sceneOrder[9]!, patternContent(f.patterns[1]!));
    });
    const access = new FakeMidiAccess();
    const dev = access.plug('Launchpad Mini');
    const c = new DjControllers({
      requestAccess: async () => access.asAccess(),
      getDecks: async () => null,
      storage: memoryControllerStorage({}),
      runCommand: () => {},
      launcher: () => s.launcher,
    });
    await c.restore();
    await c.enable();
    const light = (note: number) => dev.output!.sent.filter((m) => m[1] === note).at(-1)?.[2];
    return { f, s, c, dev, light };
  }
  const UP = 104;
  const DOWN = 105;
  const LEFT = 106;
  const RIGHT = 107;

  it('the arrow buttons move the pads one page of 8 tracks or scenes; at the edge of the grid nothing moves', async () => {
    const { s, dev, c } = await rig();
    expect(s.launcher.padPages()).toEqual({ tracks: 2, scenes: 2 });
    expect(s.launcher.padPage()).toEqual({ track: 0, scene: 0 });
    dev.input.emit(msg.cc(0, RIGHT, 127));
    dev.input.emit(msg.cc(0, RIGHT, 0));
    expect(s.launcher.padPage()).toEqual({ track: 1, scene: 0 });
    dev.input.emit(msg.cc(0, RIGHT, 127)); // no third page of tracks
    expect(s.launcher.padPage()).toEqual({ track: 1, scene: 0 });
    dev.input.emit(msg.cc(0, DOWN, 127));
    expect(s.launcher.padPage()).toEqual({ track: 1, scene: 1 });
    dev.input.emit(msg.cc(0, DOWN, 127));
    expect(s.launcher.padPage()).toEqual({ track: 1, scene: 1 });
    dev.input.emit(msg.cc(0, LEFT, 127));
    dev.input.emit(msg.cc(0, UP, 127));
    expect(s.launcher.padPage()).toEqual({ track: 0, scene: 0 });
    dev.input.emit(msg.cc(0, UP, 127));
    dev.input.emit(msg.cc(0, LEFT, 127));
    expect(s.launcher.padPage()).toEqual({ track: 0, scene: 0 });
    c.disable();
  });

  it('a pad presses the slot of its page, and the lights show that page', async () => {
    const { f, s, dev, light, c } = await rig();
    // First page: the fixture's slot at track 1, scene 1 is lit "loaded"; the slots further out are not on this page.
    expect(light(0)).toBe(29);
    dev.input.emit(msg.cc(0, RIGHT, 127));
    dev.input.emit(msg.cc(0, DOWN, 127));
    // Page (1, 1): pad (1,1) is track 9, scene 9; pad (4,2) is track 12, scene 10. Everything else on it is empty.
    expect(light(0)).toBe(29);
    expect(light(16 + 3)).toBe(29);
    expect(light(16 * 3 + 5)).toBe(12);
    dev.input.emit(msg.noteOn(0, 0));
    expect(s.launcher.runs.map((r) => [r.trackId, r.sceneId])).toEqual([[s.doc.getState().project.launcher!.trackOrder[8], s.doc.getState().project.launcher!.sceneOrder[8]]]);
    expect(light(0)).toBe(60);
    // The scene button of the first row of this page is scene 9; the stop button of the first column is track 9.
    dev.input.emit(msg.noteOn(0, 16 + 3)); // pad track 4, scene 2 of the page = track 12, scene 10
    expect(s.launcher.runs.at(-1)!.sceneId).toBe(s.doc.getState().project.launcher!.sceneOrder[9]);
    // Back to the first page: its lights again, and its pads press its slots.
    dev.input.emit(msg.cc(0, LEFT, 127));
    dev.input.emit(msg.cc(0, UP, 127));
    expect(light(0)).toBe(29);
    dev.input.emit(msg.noteOn(0, 8)); // scene button of row 1 = scene 1
    expect(s.launcher.runs.some((r) => r.sceneId === f.scenes[0] && r.trackId === f.tracks[0])).toBe(true);
    c.disable();
  });

  it('a grid that shrank under the pads counts as its last page', async () => {
    const { s, dev, c } = await rig();
    dev.input.emit(msg.cc(0, RIGHT, 127));
    expect(s.launcher.padPage().track).toBe(1);
    s.history.transact('shrink', (d) => {
      const l = d.launcher!;
      for (const id of l.trackOrder.slice(8)) {
        delete l.tracks[id];
      }
      l.trackOrder = l.trackOrder.slice(0, 8);
    });
    expect(s.launcher.padPage().track).toBe(0);
    c.disable();
  });
});
