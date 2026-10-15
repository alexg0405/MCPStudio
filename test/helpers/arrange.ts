/**
 * Builders for the arranger's tests: a project with a full kit (samplers, toms, a Drum Pads kit), an
 * 808, a pad and a lead, and grooves written into patterns. Core only (no app services), so the
 * Node unit tests of `src/core/arrange` and the browser tests both use it.
 */
import { produce, type Draft } from 'immer';
import type { Role } from '@core/arrange/roles';
import { createEmptyProject, makeInstrumentChannel, makePattern, makePluginInstance, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { KIT_VERSION } from '@core/model/kit';
import type { ChannelId, Note, NoteId, PatternId, Project, SampleId } from '@core/model/types';

export const BAR = 3840;
export const BEAT = 960;
export const STEP = 240;

/** Roles the app's plugins imply (the app's env does the same). */
export const HINT = (pluginId: string): Role | undefined =>
  pluginId === 'agstudio.bass808'
    ? '808'
    : pluginId === 'agstudio.drum-pads' || pluginId === 'agstudio.drum-synth'
      ? 'kit'
      : undefined;

export interface KitIds {
  kick: ChannelId;
  snare: ChannelId;
  clap: ChannelId;
  hat: ChannelId;
  openHat: ChannelId;
  crash: ChannelId;
  toms: ChannelId[];
  s808: ChannelId;
  pad: ChannelId;
  lead: ChannelId;
  kit: ChannelId;
}

/** Adds the kit's channels to a draft. */
export function addKit(d: Draft<Project>): KitIds {
  const sampler = (name: string, generator: string): ChannelId => {
    const sid = newId.sample() as SampleId;
    d.samples[sid] = { id: sid, name, source: { kind: 'builtin', generator, version: KIT_VERSION } };
    const ch = makeInstrumentChannel(name, makePluginInstance('agstudio.sampler', 1, {}, { samples: { main: sid } }), {
      color: paletteColor(d.channelOrder.length),
    });
    d.channels[ch.id] = ch;
    d.channelOrder.push(ch.id);
    return ch.id;
  };
  const synth = (name: string, pluginId: string): ChannelId => {
    const ch = makeInstrumentChannel(name, makePluginInstance(pluginId, 1, {}), { color: paletteColor(d.channelOrder.length) });
    d.channels[ch.id] = ch;
    d.channelOrder.push(ch.id);
    return ch.id;
  };
  return {
    kick: sampler('Kick', 'kit/kick'),
    snare: sampler('Snare', 'kit/snare'),
    clap: sampler('Clap', 'kit/clap'),
    hat: sampler('Hat', 'kit/hat-closed'),
    openHat: sampler('Open hat', 'kit/hat-open'),
    crash: sampler('Crash', 'kit/crash'),
    toms: [sampler('Tom high', 'kit/tom-high'), sampler('Tom mid', 'kit/tom-mid'), sampler('Tom low', 'kit/tom-low')],
    s808: synth('808', 'agstudio.bass808'),
    pad: synth('Pad', 'agstudio.wavetable'),
    lead: synth('Lead', 'agstudio.3xosc'),
    kit: synth('Kit', 'agstudio.drum-pads'),
  };
}

/** A note list → a pattern's notes for one channel (steps in 1/16s). */
export function notes(list: [step: number, key: number, len?: number, vel?: number][]): Record<NoteId, Note> {
  const out: Record<NoteId, Note> = {};
  for (const [step, key, len = 1, vel = 0.8] of list) {
    const id = newId.note();
    out[id] = { id, tick: Math.round(step * STEP), length: Math.max(1, Math.round(len * STEP)), key, velocity: vel };
  }
  return out;
}

/** A 2-bar trap groove: kick, snare on 3, 16th hats, a crash on 1, an 808 that holds, pad chords. */
export function trapGroove(k: KitIds, bars = 2): Record<ChannelId, Record<NoteId, Note>> {
  const each = (f: (bar: number) => [number, number, number?, number?][]) =>
    Array.from({ length: bars }, (_, b) => f(b)).flat();
  return {
    [k.kick]: notes(each((b) => [[b * 16, 60], [b * 16 + 6, 60, 1, 0.85], [b * 16 + 10, 60, 1, 0.85]])),
    [k.snare]: notes(each((b) => [[b * 16 + 8, 60, 1, 1]])),
    [k.hat]: notes(each((b) => Array.from({ length: 16 }, (_, i) => [b * 16 + i, 60, 1, i % 4 === 0 ? 0.9 : 0.5] as [number, number, number, number]))),
    [k.crash]: notes([[0, 60, 1, 0.8]]),
    [k.s808]: notes(each((b) => [[b * 16, 29 + (b % 2) * 3, 10, 1], [b * 16 + 10, 29, 6, 0.9]])),
    [k.pad]: notes(each((b) => [[b * 16, 53, 16, 0.6], [b * 16, 56, 16, 0.6], [b * 16, 60, 16, 0.6]])),
  } as Record<ChannelId, Record<NoteId, Note>>;
}

/** A project with the kit and one pattern per entry (name → notes, length in bars). */
export function kitProject(
  patterns: (k: KitIds) => Record<string, { notes: Record<ChannelId, Record<NoteId, Note>>; bars?: number }>,
  bpm = 140,
): { project: Project; kit: KitIds; patterns: Record<string, PatternId> } {
  let kit!: KitIds;
  const ids: Record<string, PatternId> = {};
  const project = produce(createEmptyProject(), (d) => {
    d.transport.bpm = bpm;
    d.transport.key = { root: 5, scale: 'minor' };
    d.patterns = {} as never;
    d.patternOrder = [];
    kit = addKit(d);
    for (const [name, def] of Object.entries(patterns(kit))) {
      const pat = makePattern(name, paletteColor(d.patternOrder.length));
      pat.length = (def.bars ?? 2) * BAR;
      pat.stepCount = (def.bars ?? 2) * 16;
      pat.notes = def.notes as never;
      d.patterns[pat.id] = pat;
      d.patternOrder.push(pat.id);
      ids[name] = pat.id;
    }
  });
  return { project, kit, patterns: ids };
}
