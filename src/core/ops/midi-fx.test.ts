import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { targetKey } from '../model/targets';
import type { ChannelId, MidiFxSlotId, Project } from '../model/types';
import { MAX_MIDI_FX } from '../midi-fx/registry';
import { hasActiveMidiFx, midiFxOf, midiFxSummary } from '../query/midi-fx';
import { resolveTarget } from '../automation/targets';
import { setTargetValue } from './targets';
import { addChannel } from './channels';
import { addMidiFx, clearMidiFx, moveMidiFx, removeMidiFx, resetMidiFx, setMidiFxChain, setMidiFxEnabled, setMidiFxParam, setMidiFxParams } from './midi-fx';

beforeEach(() => setIdSource(seededBytes(5)));

function projectWithChannel(): { project: Project; channelId: ChannelId } {
  const channel = makeInstrumentChannel('Keys', makePluginInstance('agstudio.test', 1, {}));
  const project = produce(createEmptyProject(), (draft) => void addChannel(draft, channel));
  return { project, channelId: channel.id };
}

describe('MIDI effect edits', () => {
  it('adds effects in order with their default settings', () => {
    const { project, channelId } = projectWithChannel();
    let first = null as MidiFxSlotId | null;
    const next = produce(project, (draft) => {
      first = addMidiFx(draft, channelId, 'arp');
      addMidiFx(draft, channelId, 'chord', { index: 0, params: { shape: 'min' } });
    });
    const chain = midiFxOf(next.channels[channelId]);
    expect(chain.map((slot) => slot.effect)).toEqual(['chord', 'arp']);
    expect(chain[1]).toMatchObject({ id: first, enabled: true, params: { pattern: 'up', rate: '1/16', octaves: 1 } });
    expect(chain[0]!.params.shape).toBe('min');
    expect(midiFxSummary(next.channels[channelId])).toBe('Chord → Arpeggiator');
  });

  it('refuses unknown effects, other kinds of channel and a chain that is too long', () => {
    const { project, channelId } = projectWithChannel();
    const next = produce(project, (draft) => {
      expect(addMidiFx(draft, channelId, 'nothing')).toBeNull();
      expect(addMidiFx(draft, 'ch_missing' as ChannelId, 'arp')).toBeNull();
      for (let i = 0; i < MAX_MIDI_FX; i++) expect(addMidiFx(draft, channelId, 'transpose')).not.toBeNull();
      expect(addMidiFx(draft, channelId, 'transpose')).toBeNull();
    });
    expect(midiFxOf(next.channels[channelId])).toHaveLength(MAX_MIDI_FX);
  });

  it('checks every setting against its param', () => {
    const { project, channelId } = projectWithChannel();
    let slot = null as MidiFxSlotId | null;
    const next = produce(project, (draft) => {
      slot = addMidiFx(draft, channelId, 'arp');
      setMidiFxParam(draft, channelId, slot!, 'octaves', 9);
      setMidiFxParam(draft, channelId, slot!, 'gate', 0);
      setMidiFxParam(draft, channelId, slot!, 'pattern', 'sideways');
      setMidiFxParam(draft, channelId, slot!, 'nonsense', 3);
      setMidiFxParams(draft, channelId, slot!, { rate: '1/32', latch: true });
    });
    const params = midiFxOf(next.channels[channelId])[0]!.params;
    expect(params).toMatchObject({ octaves: 4, gate: 0.05, pattern: 'up', rate: '1/32', latch: true });
    expect(params.nonsense).toBeUndefined();
    const reset = produce(next, (draft) => void resetMidiFx(draft, channelId, slot!));
    expect(midiFxOf(reset.channels[channelId])[0]!.params).toMatchObject({ octaves: 1, rate: '1/16', latch: false });
  });

  it('bypasses, moves and removes effects; an empty chain leaves no field behind', () => {
    const { project, channelId } = projectWithChannel();
    const ids: MidiFxSlotId[] = [];
    let next = produce(project, (draft) => {
      for (const effect of ['arp', 'chord', 'echo']) ids.push(addMidiFx(draft, channelId, effect)!);
    });
    next = produce(next, (draft) => {
      moveMidiFx(draft, channelId, ids[2]!, 0);
      setMidiFxEnabled(draft, channelId, ids[0]!, false);
    });
    expect(midiFxOf(next.channels[channelId]).map((slot) => slot.effect)).toEqual(['echo', 'arp', 'chord']);
    expect(midiFxSummary(next.channels[channelId])).toBe('Echo → (Arpeggiator) → Chord'.replace('Echo', 'MIDI echo'));
    expect(hasActiveMidiFx(next.channels[channelId])).toBe(true);
    next = produce(next, (draft) => void removeMidiFx(draft, channelId, ids[1]!));
    expect(midiFxOf(next.channels[channelId]).map((slot) => slot.effect)).toEqual(['echo', 'arp']);
    next = produce(next, (draft) => {
      removeMidiFx(draft, channelId, ids[0]!);
      removeMidiFx(draft, channelId, ids[2]!);
    });
    expect((next.channels[channelId] as { midiFx?: unknown }).midiFx).toBeUndefined();
    expect(hasActiveMidiFx(next.channels[channelId])).toBe(false);
  });

  it('replaces the whole chain, giving the effects new ids', () => {
    const { project, channelId } = projectWithChannel();
    let oldId = null as MidiFxSlotId | null;
    const first = produce(project, (draft) => void (oldId = addMidiFx(draft, channelId, 'arp')));
    const next = produce(first, (draft) => {
      setMidiFxChain(draft, channelId, [{ effect: 'scale', params: { mode: 'filter' } }, { effect: 'unknown' }, { effect: 'humanize', enabled: false }]);
    });
    const chain = midiFxOf(next.channels[channelId]);
    expect(chain.map((slot) => [slot.effect, slot.enabled])).toEqual([['scale', true], ['humanize', false]]);
    expect(chain.some((slot) => slot.id === oldId)).toBe(false);
    expect(midiFxOf(produce(next, (draft) => void clearMidiFx(draft, channelId)).channels[channelId])).toEqual([]);
  });

  it('a knob is an automation target: it resolves, is set like any control, and its controller links go with the effect', () => {
    const { project, channelId } = projectWithChannel();
    let slot = null as MidiFxSlotId | null;
    let next = produce(project, (draft) => void (slot = addMidiFx(draft, channelId, 'echo')));
    const target = { kind: 'midiFx', channelId, slotId: slot!, paramId: 'feedback' } as const;
    expect(targetKey(target)).toBe(`mfx:${channelId}:${slot}:feedback`);
    const resolved = resolveTarget(next, target, () => undefined);
    expect(resolved?.spec.type).toBe('float');
    expect(resolved?.base).toBeCloseTo(0.65);
    next = produce(next, (draft) => {
      setTargetValue(draft, target, 0.3);
      draft.controllers['lnk_1' as never] = { id: 'lnk_1', cc: 1, channel: null, target, min: 0, max: 1 } as never;
    });
    expect(midiFxOf(next.channels[channelId])[0]!.params.feedback).toBe(0.3);
    next = produce(next, (draft) => void removeMidiFx(draft, channelId, slot!));
    expect(Object.keys(next.controllers)).toEqual([]);
    expect(resolveTarget(next, target, () => undefined)).toBeNull();
  });
});
