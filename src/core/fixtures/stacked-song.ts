/**
 * A song shaped like one an earlier AI arranged for a musician (150 BPM, F minor, 113 bars, 11
 * markers): monolithic 2-bar loops repeated up to 8 times on Track 1, layers on Tracks 2–10, a tom
 * fill played on top of the beat, automation clips scattered over the lanes, 13 automation channels
 * with repeated names, and bars 81–112 stacked three times (two copies on Track 1, one on Track 11).
 * Tests (context, cleanup, arranging, parts of the song) and the `?perf=stacked-song` fixture use it.
 */
import type { Draft } from 'immer';
import { makeInsert, makeInstrumentChannel, makeLane, makePattern, makePluginInstance, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import { KIT_VERSION } from '../model/kit';
import {
  MASTER,
  type AutoPoint,
  type ChannelId,
  type ClipId,
  type InsertId,
  type LaneId,
  type Note,
  type ParamTarget,
  type PatternId,
  type Project,
  type SampleId,
  type SlotId,
} from '../model/types';

const BAR = 3840;
const STEP = 240;

export interface StackedSong {
  channels: Record<string, ChannelId>;
  patterns: Record<string, PatternId>;
  lanes: LaneId[];
  inserts: Record<string, InsertId>;
}

const notes = (list: [step: number, key: number, len?: number, vel?: number][]): Record<string, Note> =>
  Object.fromEntries(
    list.map(([step, key, len = 1, vel = 0.8]) => {
      const id = newId.note();
      return [id, { id, tick: Math.round(step * STEP), length: Math.round(len * STEP), key, velocity: vel }];
    }),
  );

const hits = (steps: number[], vel = 0.9, key = 60) => notes(steps.map((s) => [s, key, 1, vel] as [number, number, number, number]));

/** Fills an empty project (from `createEmptyProject`) with the song. */
export function buildStackedSong(d: Draft<Project>): StackedSong {
  d.transport.bpm = 150;
  d.transport.key = { root: 5, scale: 'minor' };
  d.patterns = {} as never;
  d.patternOrder = [];
  d.playlist.clips = {} as never;
  d.playlist.lanes = {} as never;
  d.playlist.laneOrder = [];

  // Mixer: the AI added its tracks after the 16 empty ones.
  const inserts: Record<string, InsertId> = {};
  const slot = (insert: InsertId, pluginId: string, sidechain: InsertId | null = null): SlotId => {
    const id = newId.slot();
    d.mixer.inserts[insert]!.fx.push({ id, plugin: makePluginInstance(pluginId, 1, {}), enabled: true, mix: 1, sidechain });
    return id;
  };
  for (const name of ['Kick', 'Melody', 'Pad', 'Strings & Choir', 'FX', 'Bells', 'Perc']) {
    const id = newId.insert();
    d.mixer.inserts[id] = makeInsert(id, name);
    d.mixer.order.push(id);
    inserts[name] = id;
  }
  slot(MASTER, 'agstudio.saturator');
  slot(MASTER, 'agstudio.limiter');
  const filterSlot = slot(inserts.Melody!, 'agstudio.filter');
  slot(inserts.Melody!, 'agstudio.delay');
  slot(inserts.Melody!, 'agstudio.reverb');
  for (const bus of ['Pad', 'Strings & Choir']) {
    slot(inserts[bus]!, 'agstudio.eq-pro');
    slot(inserts[bus]!, 'agstudio.reverb');
    slot(inserts[bus]!, 'agstudio.ducker', inserts.Kick!);
  }
  slot(inserts.FX!, 'agstudio.eq-pro');
  slot(inserts.FX!, 'agstudio.reverb');
  slot(inserts.Bells!, 'agstudio.delay');
  slot(inserts.Bells!, 'agstudio.reverb');
  slot(inserts.Perc!, 'agstudio.reverb');

  // Channels.
  const channels: Record<string, ChannelId> = {};
  const add = (name: string, pluginId: string, opts: { sample?: string; output?: InsertId; volume?: number; pan?: number } = {}) => {
    const plugin = makePluginInstance(pluginId, 1, {});
    if (opts.sample) {
      const sid = newId.sample() as SampleId;
      d.samples[sid] = { id: sid, name, source: { kind: 'builtin', generator: opts.sample, version: KIT_VERSION } };
      plugin.samples = { main: sid };
    }
    const ch = makeInstrumentChannel(name, plugin, { color: paletteColor(d.channelOrder.length), output: opts.output ?? MASTER });
    if (opts.volume !== undefined) ch.volume = opts.volume;
    if (opts.pan !== undefined) ch.pan = opts.pan;
    d.channels[ch.id] = ch;
    d.channelOrder.push(ch.id);
    channels[name] = ch.id;
  };
  // The default project's kit channels go first (the AI reused them).
  for (const id of [...d.channelOrder]) {
    delete d.channels[id];
  }
  d.channelOrder = [];
  add('Kick', 'agstudio.sampler', { sample: 'kit/kick', output: inserts.Kick! });
  add('Clap', 'agstudio.sampler', { sample: 'kit/clap' });
  add('Hat', 'agstudio.sampler', { sample: 'kit/hat-closed' });
  add('Snare', 'agstudio.sampler', { sample: 'kit/snare' });
  add('Crash', 'agstudio.sampler', { sample: 'kit/crash', volume: 0.4 });
  add('808', 'agstudio.bass808', { volume: 0.85 });
  add('Pluck', 'agstudio.pluck', { output: inserts.Melody!, volume: 0.4, pan: 0.15 });
  add('Dark Pad', 'agstudio.wavetable', { output: inserts.Pad!, volume: 0.32 });
  add('Saw Layer', 'user.example-supersaw', { output: inserts.Melody!, volume: 0.22, pan: -0.1 });
  add('Choir', 'agstudio.wavetable', { output: inserts['Strings & Choir']!, volume: 0.25 });
  add('Strings', 'agstudio.wavetable', { output: inserts['Strings & Choir']!, volume: 0.22 });
  add('Organ', 'user.example-faust-organ', { output: inserts['Strings & Choir']!, volume: 0.18 });
  add('Riser', 'agstudio.wavetable', { output: inserts.FX!, volume: 0.2 });
  add('Reverse Crash', 'agstudio.sampler', { sample: 'kit/crash', output: inserts.FX!, volume: 0.4 });
  add('Sub Drop', 'agstudio.bass808', { volume: 0.63 });
  add('Bell Arp', 'agstudio.fm', { output: inserts.Bells!, volume: 0.16, pan: -0.2 });
  add('Perc', 'agstudio.drum-pads', { output: inserts.Perc!, volume: 0.32, pan: 0.15 });
  add('Downlifter', 'agstudio.wavetable', { output: inserts.FX!, volume: 0.2 });
  const c = channels;

  // Patterns (2 bars unless noted), each holding several channels like the AI's did.
  const patterns: Record<string, PatternId> = {};
  const pattern = (name: string, parts: Record<string, Record<string, Note>>, bars = 2) => {
    const p = makePattern(name, paletteColor(d.patternOrder.length));
    p.length = bars * BAR;
    p.stepCount = bars * 16;
    for (const [ch, ns] of Object.entries(parts)) p.notes[c[ch]!] = ns as never;
    d.patterns[p.id] = p;
    d.patternOrder.push(p.id);
    patterns[name] = p.id;
  };
  const pad = () => notes([[0, 53, 16], [0, 56, 16], [0, 60, 16], [16, 49, 16], [16, 53, 16], [16, 56, 16], [16, 61, 16], [0, 65, 8], [16, 63, 8]]);
  const pluck = () => notes([[0, 72], [3, 75], [6, 77], [8, 80], [11, 77], [14, 75], [16, 72], [19, 75], [22, 77], [24, 79], [28, 77]]);
  const saw = () => notes([[0, 65, 4], [4, 68, 4], [8, 72, 4], [12, 70, 4], [16, 65, 4], [20, 68, 4], [24, 72, 2], [26, 73, 2], [28, 72, 2], [30, 70, 2], [31, 68, 1]]);
  const hats = (rolls: boolean) =>
    notes([
      ...Array.from({ length: 16 }, (_, i) => [i * 2, 60, 1, i % 2 ? 0.5 : 0.9] as [number, number, number, number]),
      ...(rolls ? ([[12.67, 60, 1, 0.55], [13.33, 60, 1, 0.65], [30.25, 60, 1, 0.5], [30.5, 60, 1, 0.6], [30.75, 60, 1, 0.7]] as [number, number, number, number][]) : []),
    ]);
  const drop808 = () => notes([[0, 29, 10, 1], [10, 29, 4.5, 0.95], [14, 36, 2, 0.9], [16, 29, 6, 1], [22, 32, 4.5, 0.9], [26, 41, 3, 0.95], [29, 36, 3, 0.9]]);
  pattern('Pattern 1', {});
  pattern('ISOxo 808 slam', {
    Snare: hits([8, 24], 1),
    Clap: hits([8, 24], 0.95),
    Hat: hats(true),
    Crash: hits([0], 0.75),
    Kick: hits([0, 10, 16, 26]),
    '808': notes([[0, 29, 10, 1], [10, 29, 6], [16, 29, 10, 1], [26, 32, 6]]),
    Pluck: pluck(),
    'Dark Pad': pad(),
    'Saw Layer': saw(),
  });
  pattern('Build', {
    Snare: hits(Array.from({ length: 18 }, (_, i) => (i < 8 ? i * 2 : 16 + (i - 8) * 1.6)), 0.7),
    Hat: hats(false),
    'Dark Pad': pad(),
    Pluck: pluck(),
  });
  pattern('Drop', {
    Kick: hits([0, 10, 14, 16, 22, 26, 29]),
    '808': drop808(),
    Snare: hits([8, 24, 30, 31], 0.9),
    Clap: hits([8, 24], 0.95),
    Crash: hits([0], 0.8),
    Hat: hats(true),
    'Dark Pad': pad(),
    Pluck: pluck(),
    'Saw Layer': saw(),
  });
  pattern('Drop 2', {
    Kick: hits([0, 10, 14, 16, 22, 26, 29]),
    '808': drop808(),
    Snare: hits([8, 24, 27, 30, 31, 31.5], 0.9),
    Clap: hits([8, 24], 0.95),
    Crash: hits([0], 0.8),
    Hat: hats(true),
    'Dark Pad': pad(),
    Pluck: pluck(),
    'Saw Layer': saw(),
  });
  pattern('Break', { 'Dark Pad': pad(), Pluck: pluck(), Hat: hits([0, 8, 16, 24], 0.35) });
  pattern('Intro', { 'Dark Pad': pad(), Pluck: pluck() });
  pattern('Choir layer', { Choir: pad() });
  pattern('Strings layer', { Strings: pad() });
  pattern('Organ layer', { Organ: notes([[0, 53, 8], [0, 56, 8], [0, 60, 8], [8, 51, 8], [8, 55, 8], [8, 58, 8], [16, 49, 8], [16, 53, 8], [16, 56, 8], [24, 51, 8], [24, 55, 8], [24, 58, 8]]) });
  pattern('Riser', { Riser: notes([[0, 53, 32], [0, 60, 32]]), 'Reverse Crash': hits([16], 0.9) });
  pattern('Impact', { 'Sub Drop': notes([[0, 29, 8, 1]]), Crash: hits([0], 1) });
  pattern('Bell layer', { 'Bell Arp': notes(Array.from({ length: 16 }, (_, i) => [i * 2, [77, 80, 84, 87][i % 4]!, 1, 0.6])) });
  pattern('Perc layer', { Perc: notes(Array.from({ length: 27 }, (_, i) => [i * 1.18, [37, 39, 42, 46][i % 4]!, 1, 0.45])) });
  pattern('Tom fill', { Perc: notes([[8, 50, 1, 0.6], [9, 50, 1, 0.7], [10, 47, 1, 0.75], [11, 47, 1, 0.8], [12, 45, 1, 0.85], [13, 45, 1, 0.9], [14, 41, 1, 0.95], [15, 41, 1, 1]]) }, 1);
  pattern('Downlifter', { Downlifter: notes([[0, 72, 32], [0, 79, 32]]) });

  // Automation channels: repeated names, scattered lanes.
  const automation = (name: string, target: ParamTarget, points: AutoPoint[]): ChannelId => {
    const id = newId.channel();
    d.channels[id] = { kind: 'automation', id, name, color: paletteColor(d.channelOrder.length), muted: false, solo: false, target, points } as never;
    d.channelOrder.push(id);
    return id;
  };
  const filterTarget: ParamTarget = { kind: 'plugin', owner: { kind: 'fx', insertId: inserts.Melody!, slotId: filterSlot }, paramId: 'cutoff' };
  const padTarget: ParamTarget = { kind: 'plugin', owner: { kind: 'channel', channelId: c['Dark Pad']! }, paramId: 'cutoff' };
  const riserPitch: ParamTarget = { kind: 'channel', channelId: c.Riser!, param: 'pitch' };
  const downPitch: ParamTarget = { kind: 'channel', channelId: c.Downlifter!, param: 'pitch' };
  const filterIn = automation('Cutoff · Filter (Insert 18)', filterTarget, [{ tick: 0, value: 0.39, tension: -0.4 }, { tick: 8 * BAR, value: 0.98 }]);
  const filterOut = automation('Cutoff · Filter (Insert 18)', filterTarget, [{ tick: 0, value: 0.98 }, { tick: 12 * BAR, value: 0.3 }]);
  const padSweeps = [0, 1, 2].map(() => automation('Cutoff · Dark Pad', padTarget, [{ tick: 0, value: 0.3 }, { tick: 4 * BAR, value: 0.9 }]));
  const risers = [0, 1, 2, 3].map(() => automation('Pitch · Riser', riserPitch, [{ tick: 0, value: 0.5 }, { tick: 2 * BAR, value: 0.75 }]));
  const downs = [0, 1, 2].map(() => automation('Pitch · Downlifter', downPitch, [{ tick: 0, value: 0.5 }, { tick: 2 * BAR, value: 0.25 }]));
  const fade = automation('Volume · Master', { kind: 'insert', insertId: MASTER, param: 'volume' }, [{ tick: 0, value: 0.8 }, { tick: 8 * BAR, value: 0 }]);

  // Lanes and clips.
  const lanes: LaneId[] = [];
  for (let i = 1; i <= 18; i++) {
    const lane = makeLane(`Track ${i}`);
    d.playlist.lanes[lane.id] = lane;
    d.playlist.laneOrder.push(lane.id);
    lanes.push(lane.id);
  }
  const clip = (track: number, bar: number, bars: number, what: { pattern: string } | { automation: ChannelId }) => {
    const id = newId.clip() as ClipId;
    const base = { id, laneId: lanes[track - 1]!, start: (bar - 1) * BAR, length: bars * BAR };
    d.playlist.clips[id] =
      'pattern' in what
        ? { kind: 'pattern', ...base, patternId: patterns[what.pattern]!, offset: 0 }
        : { kind: 'automation', ...base, channelId: what.automation, offset: 0 };
  };
  /** `count` 2-bar clips of a pattern from `bar` on. */
  const run = (track: number, name: string, bar: number, count: number, size = 2) => {
    for (let i = 0; i < count; i++) clip(track, bar + i * size, size, { pattern: name });
  };
  run(1, 'Intro', 1, 4);
  run(1, 'Break', 9, 4);
  run(1, 'ISOxo 808 slam', 17, 8);
  run(1, 'Build', 33, 2);
  run(1, 'Drop', 37, 8);
  run(1, 'Break', 53, 6);
  run(1, 'Build', 65, 2);
  run(1, 'Drop 2', 69, 6);
  // The tail the AI couldn't see, placed again: twice on Track 1, once on Track 11.
  for (const track of [1, 1, 11]) {
    run(track, 'Drop 2', 81, 2);
    run(track, 'Break', 85, 2);
    run(track, 'Drop', 89, 6);
    run(track, 'Intro', 101, 6);
  }
  run(2, 'Choir layer', 5, 6);
  clip(2, 33, 4, { automation: padSweeps[0]! });
  run(2, 'Choir layer', 37, 8);
  clip(2, 53, 2, { automation: downs[0]! });
  run(2, 'Choir layer', 61, 2);
  clip(2, 65, 4, { automation: padSweeps[1]! });
  run(2, 'Choir layer', 69, 8);
  clip(2, 85, 4, { automation: padSweeps[2]! });
  run(2, 'Choir layer', 89, 10);
  clip(3, 1, 8, { automation: filterIn });
  clip(3, 15, 2, { automation: risers[0]! });
  run(3, 'Strings layer', 25, 4);
  clip(3, 35, 2, { automation: risers[1]! });
  run(3, 'Strings layer', 45, 4);
  run(3, 'Strings layer', 57, 4);
  clip(3, 67, 2, { automation: risers[2]! });
  run(3, 'Strings layer', 69, 8);
  clip(3, 85, 2, { automation: downs[1]! });
  clip(3, 87, 2, { automation: risers[3]! });
  run(3, 'Strings layer', 89, 6);
  clip(3, 101, 12, { automation: filterOut });
  run(4, 'Organ layer', 53, 6);
  run(4, 'Organ layer', 77, 4);
  run(4, 'Organ layer', 93, 4);
  clip(4, 101, 2, { automation: downs[2]! });
  clip(4, 105, 8, { automation: fade });
  for (const bar of [15, 35, 67, 87]) clip(5, bar, 2, { pattern: 'Riser' });
  for (const bar of [17, 37, 69, 89]) clip(6, bar, 2, { pattern: 'Impact' });
  run(7, 'Bell layer', 25, 4);
  run(7, 'Bell layer', 41, 6);
  run(7, 'Bell layer', 57, 4);
  run(7, 'Bell layer', 69, 8);
  run(7, 'Bell layer', 89, 8);
  run(8, 'Perc layer', 17, 8);
  run(8, 'Perc layer', 37, 8);
  run(8, 'Perc layer', 69, 8);
  run(8, 'Perc layer', 89, 6);
  for (const bar of [16, 32, 48, 64, 80, 96]) clip(9, bar, 1, { pattern: 'Tom fill' });
  for (const bar of [53, 85, 101]) clip(10, bar, 2, { pattern: 'Downlifter' });

  // Markers.
  for (const [name, bar] of [
    ['Intro', 1],
    ['Pre-verse', 9],
    ['Verse', 17],
    ['Build', 33],
    ['Drop', 37],
    ['Bridge', 53],
    ['Build 2', 65],
    ['Drop 2', 69],
    ['Breather', 85],
    ['Final Drop', 89],
    ['Outro', 101],
  ] as [string, number][]) {
    const id = newId.marker();
    d.playlist.markers[id] = { id, tick: (bar - 1) * BAR, name };
  }
  return { channels, patterns, lanes, inserts };
}
