import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { collectNotes, patternModeSource, type NoteEvent } from '@engine/sched/events';
import { midiFxDef } from '@core/midi-fx/registry';
import type { ChannelId, PatternId, Project } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { addNotes, setSwing } from '@core/ops/notes';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import { notesSorted } from '@core/query/queries';
import { note } from '../../../test/helpers/notes';
import {
  addMidiEffect,
  applyMidiFxPreset,
  bakeMidiEffects,
  clearMidiEffects,
  FACTORY_CHAINS,
  findMidiFxChain,
  loadMidiFxChain,
  moveMidiEffectBy,
  removeMidiEffect,
  saveMidiFxChain,
  saveMidiFxPreset,
  savedMidiFxChains,
  toggleMidiEffect,
} from './midi-fx';

function setup() {
  const s = createTestServices();
  const project = s.doc.getState().project;
  const channelId = project.channelOrder.find((id) => project.channels[id]?.kind === 'instrument') as ChannelId;
  const patternId = project.patternOrder[0] as PatternId;
  s.session.getState().selectChannel(channelId);
  // A held C major chord (one bar) and a short note after it.
  s.history.transact('seed', (d) => {
    d.patterns[patternId]!.notes[channelId] = {} as never;
    addNotes(d, patternId, channelId, [note('c', 0, 60, 3840), note('e', 0, 64, 3840), note('g', 0, 67, 3840)]);
  });
  const chain = () => midiFxOf(s.doc.getState().project.channels[channelId]);
  return { s, channelId, patternId, chain };
}

const eventsOf = (project: Project, patternId: PatternId, channelId: ChannelId): NoteEvent[] => {
  const out: NoteEvent[] = [];
  collectNotes(patternModeSource(project, patternId).source, 0, 3840, out);
  return out.filter((event) => event.channelId === channelId);
};

/** What the transport would send for each event, with nothing that differs between a chain's note and a plain one. */
const heard = (events: NoteEvent[]) => events.map((e) => [Math.round(e.start * 1000) / 1000, Math.round(e.end * 1000) / 1000, e.pitch, +e.velocity.toFixed(6), e.pan, e.fine, e.release]).sort((a, b) => (a[0] as number) - (b[0] as number) || (a[2] as number) - (b[2] as number));

describe('MIDI effect actions', () => {
  it('add, bypass, move and remove are each one undo step', () => {
    const { s, channelId, chain } = setup();
    const arp = addMidiEffect(s, channelId, 'arp')!;
    const chord = addMidiEffect(s, channelId, 'chord')!;
    expect(chain().map((slot) => slot.effect)).toEqual(['arp', 'chord']);
    moveMidiEffectBy(s, channelId, chord, -1);
    expect(chain().map((slot) => slot.effect)).toEqual(['chord', 'arp']);
    toggleMidiEffect(s, channelId, arp);
    expect(chain().find((slot) => slot.id === arp)!.enabled).toBe(false);
    removeMidiEffect(s, channelId, chord);
    expect(chain().map((slot) => slot.effect)).toEqual(['arp']);
    for (const expected of [['chord', 'arp'], ['chord', 'arp'], ['arp', 'chord'], ['arp']]) {
      s.history.undo();
      expect(chain().map((slot) => slot.effect)).toEqual(expected);
    }
    s.history.undo();
    expect(chain()).toEqual([]);
    s.history.redo();
    expect(chain().map((slot) => slot.effect)).toEqual(['arp']);
  });

  it('refuses an unknown effect and audio channels, and says why when the chain is full', () => {
    const { s, channelId, chain } = setup();
    expect(addMidiEffect(s, channelId, 'nothing')).toBeNull();
    for (let i = 0; i < 8; i++) expect(addMidiEffect(s, channelId, 'transpose')).not.toBeNull();
    expect(addMidiEffect(s, channelId, 'transpose')).toBeNull();
    expect(chain()).toHaveLength(8);
    clearMidiEffects(s, channelId);
    expect(chain()).toEqual([]);
  });

  it('a preset sets every setting: the ones it does not name go back to their defaults', () => {
    const { s, channelId, chain } = setup();
    const slot = addMidiEffect(s, channelId, 'arp', { params: { octaves: 3, latch: true } })!;
    const trance = midiFxDef('arp')!.presets.find((preset) => preset.name === 'Trance gate')!;
    applyMidiFxPreset(s, channelId, slot, trance);
    expect(chain()[0]!.params).toMatchObject({ octaves: 3, gate: 0.5, velocity: 'accent', latch: false });
    applyMidiFxPreset(s, channelId, slot, midiFxDef('arp')!.presets[0]!);
    expect(chain()[0]!.params).toMatchObject({ octaves: 1, gate: 0.8, velocity: 'played' });
  });

  it('keeps your presets and chains, and loads a chain onto a channel in one undo step', () => {
    const { s, channelId, chain } = setup();
    const slot = addMidiEffect(s, channelId, 'arp', { params: { rate: '1/8', octaves: 2 } })!;
    addMidiEffect(s, channelId, 'humanize', { params: { timing: 4 } });
    expect(saveMidiFxPreset(s, channelId, slot, 'My arp').ok).toBe(true);
    expect(s.presets.forPlugin('midifx:arp').map((preset) => [preset.name, preset.params.rate])).toEqual([['My arp', '1/8']]);
    expect(saveMidiFxChain(s, channelId, 'Pluck and loosen').ok).toBe(true);
    const saved = savedMidiFxChains(s);
    expect(saved.map((chainOf) => [chainOf.name, chainOf.slots.map((x) => x.effect)])).toEqual([['Pluck and loosen', ['arp', 'humanize']]]);
    clearMidiEffects(s, channelId);
    const found = findMidiFxChain(s, 'pluck AND loosen')!;
    expect(loadMidiFxChain(s, channelId, found.name, found.slots).ok).toBe(true);
    expect(chain().map((x) => [x.effect, x.params.timing ?? x.params.rate])).toEqual([['arp', '1/8'], ['humanize', 4]]);
    s.history.undo();
    expect(chain()).toEqual([]);
    expect(findMidiFxChain(s, FACTORY_CHAINS[0]!.name)).not.toBeNull();
    expect(findMidiFxChain(s, 'no such chain')).toBeNull();
  });
});

describe('render MIDI effects to notes', () => {
  it('writes exactly what plays: the same notes, to the tick, even with swing', () => {
    const { s, channelId, patternId } = setup();
    addMidiEffect(s, channelId, 'arp', { params: { pattern: 'upDown', octaves: 2, rate: '1/16', swing: 0.2, gate: 0.6 } });
    addMidiEffect(s, channelId, 'echo', { params: { delay: '1/8', repeats: 2 } });
    addMidiEffect(s, channelId, 'velocity', { params: { curve: -0.5 } });
    s.history.transact('swing', (d) => setSwing(d, 0.4));
    const before = s.doc.getState().project;
    const played = heard(eventsOf(before, patternId, channelId));
    expect(played.length).toBeGreaterThan(30);
    const result = bakeMidiEffects(s, channelId);
    expect(result.ok, result.message).toBe(true);
    const after = s.doc.getState().project;
    expect(hasActiveMidiFx(after.channels[channelId])).toBe(false);
    expect(midiFxOf(after.channels[channelId])).toEqual([]);
    expect(heard(eventsOf(after, patternId, channelId))).toEqual(played);
    // The notes of the pattern are the notes that play now: ordinary notes with whole-tick starts.
    const notes = notesSorted(after.patterns[patternId]!.notes[channelId]);
    expect(notes).toHaveLength(played.length);
    expect(notes.every((n) => Number.isInteger(n.tick) && Number.isInteger(n.length))).toBe(true);
  });

  it('is one undo step that brings the chain and the old notes back', () => {
    const { s, channelId, patternId, chain } = setup();
    addMidiEffect(s, channelId, 'arp');
    const before = s.doc.getState().project;
    bakeMidiEffects(s, channelId);
    expect(Object.keys(s.doc.getState().project.patterns[patternId]!.notes[channelId]!)).toHaveLength(16);
    s.history.undo();
    expect(s.doc.getState().project.patterns[patternId]).toEqual(before.patterns[patternId]);
    expect(chain().map((slot) => slot.effect)).toEqual(['arp']);
    s.history.redo();
    expect(chain()).toEqual([]);
  });

  it('can keep the effects, bypassed, and renders a muted channel too', () => {
    const { s, channelId, patternId, chain } = setup();
    addMidiEffect(s, channelId, 'arp');
    s.history.transact('mute', (d) => setChannelProp(d, channelId, 'muted', true));
    expect(bakeMidiEffects(s, channelId, { keepEffects: true }).ok).toBe(true);
    expect(chain().map((slot) => [slot.effect, slot.enabled])).toEqual([['arp', false]]);
    expect(Object.keys(s.doc.getState().project.patterns[patternId]!.notes[channelId]!)).toHaveLength(16);
  });

  it('says why when there is nothing to render', () => {
    const { s, channelId } = setup();
    expect(bakeMidiEffects(s, channelId).message).toMatch(/no MIDI effects/);
    const slot = addMidiEffect(s, channelId, 'arp')!;
    toggleMidiEffect(s, channelId, slot);
    expect(bakeMidiEffects(s, channelId).message).toMatch(/bypassed ones do nothing/);
    toggleMidiEffect(s, channelId, slot);
    s.history.transact('empty', (d) => {
      d.patterns[Object.keys(d.patterns)[0] as PatternId]!.notes[channelId] = {} as never;
    });
    expect(bakeMidiEffects(s, channelId).message).toMatch(/no notes/);
  });

  it('gives the same notes every time it is run on the same part (ids aside)', () => {
    const a = setup();
    const b = setup();
    for (const t of [a, b]) {
      addMidiEffect(t.s, t.channelId, 'arp', { params: { pattern: 'random', seed: 12 } });
      addMidiEffect(t.s, t.channelId, 'humanize', { params: { seed: 5 } });
      bakeMidiEffects(t.s, t.channelId);
    }
    const shape = (t: ReturnType<typeof setup>) => notesSorted(t.s.doc.getState().project.patterns[t.patternId]!.notes[t.channelId]).map(({ id: _id, ...rest }) => rest);
    expect(shape(a)).toEqual(shape(b));
  });
});
