import { newId } from '@core/model/ids';
import { kitPiece } from '@core/model/kit';
import type { ChannelId, InstrumentChannel } from '@core/model/types';
import { addChannel, addSample, moveChannel, removeChannel } from '@core/ops/channels';
import type { Services } from '../services';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../default-project';

// User-level channel actions: each is one undoable edit, used by the rack, menus and browser.

function insertIndex(s: Services): number {
  const { channelOrder } = s.doc.getState().project;
  const sel = s.session.getState().selectedChannelId;
  const i = sel ? channelOrder.indexOf(sel) : -1;
  return i >= 0 ? i + 1 : channelOrder.length;
}

/** Adds a sampler channel playing a kit sound, after the selected channel. */
export function addKitChannel(s: Services, generator: string): ChannelId | null {
  const sampler = s.plugins.get(SAMPLER_ID);
  if (!sampler) return null;
  const project = s.doc.getState().project;
  const sample = kitSampleRef(generator);
  const channel = instrumentChannelFor(sampler, kitPiece(generator)?.short ?? generator, project.channelOrder.length, {
    main: sample.id,
  });
  s.history.transact(`Add ${channel.name}`, (d) => {
    addSample(d, sample);
    addChannel(d, channel, insertIndex(s));
  });
  s.session.getState().selectChannel(channel.id);
  return channel.id;
}

/** Adds a channel with an instrument plugin (default params). */
export function addInstrumentChannel(s: Services, pluginId: string): ChannelId | null {
  const def = s.plugins.get(pluginId);
  if (!def || def.kind !== 'instrument') return null;
  const project = s.doc.getState().project;
  const channel = instrumentChannelFor(def, def.name, project.channelOrder.length);
  s.history.transact(`Add ${def.name}`, (d) => addChannel(d, channel, insertIndex(s)));
  s.session.getState().selectChannel(channel.id);
  return channel.id;
}

export function deleteChannel(s: Services, id: ChannelId): void {
  const ch = s.doc.getState().project.channels[id];
  if (!ch) return;
  s.history.transact(`Delete ${ch.name}`, (d) => removeChannel(d, id));
}

/** Duplicates a channel (instrument settings and its notes in every pattern). */
export function cloneChannel(s: Services, id: ChannelId): ChannelId | null {
  const project = s.doc.getState().project;
  const ch = project.channels[id];
  if (!ch || ch.kind !== 'instrument') return null;
  const copy: InstrumentChannel = { ...structuredClone(ch), id: newId.channel(), name: `${ch.name} #2`, solo: false };
  s.history.transact(`Clone ${ch.name}`, (d) => {
    addChannel(d, copy, project.channelOrder.indexOf(id) + 1);
    for (const pid of project.patternOrder) {
      const notes = project.patterns[pid]?.notes[id];
      const pattern = d.patterns[pid];
      if (!notes || !pattern) continue;
      const cloned: typeof notes = {};
      for (const n of Object.values(notes)) {
        const nid = newId.note();
        cloned[nid] = { ...n, id: nid };
      }
      pattern.notes[copy.id] = cloned;
    }
  });
  s.session.getState().selectChannel(copy.id);
  return copy.id;
}

export function moveChannelBy(s: Services, id: ChannelId, delta: number): void {
  const order = s.doc.getState().project.channelOrder;
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  s.history.transact('Move channel', (d) => moveChannel(d, id, j));
}
