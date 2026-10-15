import { describe, expect, it } from 'vitest';
import type { BeatSpec } from '@core/beat/spec';
import type { ChannelId, InstrumentChannel, Project, SampleId } from '@core/model/types';
import { createTestServices } from '../testing';
import { applyBeatSpec, planBeat, writeBeat } from './apply';

const beat = (over: Partial<BeatSpec> = {}): BeatSpec => ({
  title: 'Night trap',
  bars: 2,
  bpm: 140,
  tracks: [
    { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 10, vel: 0.6 }] },
    { name: 'Hat', sound: 'hat', notes: [{ step: 0 }, { step: 6.5, len: 0.5 }] },
    { name: '808', sound: '808', notes: [{ step: 0, len: 10, key: 29 }], volume: 0.9, params: { decay: 99, nope: 1 } },
  ],
  ...over,
});

describe('applyBeatSpec', () => {
  it('writes a new pattern, reusing the project drums and adding the rest, as one undo step', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const applied = applyBeatSpec(s, beat());
    const p = s.doc.getState().project;

    expect(p.transport.bpm).toBe(140);
    const pattern = p.patterns[applied.patternId]!;
    expect(pattern).toMatchObject({ name: 'Night trap', stepCount: 32, length: 32 * 240 });
    expect(s.view.getState().currentPatternId).toBe(applied.patternId);

    // The default project's Kick and Hat samplers are reused; the 808 is a new channel.
    const kick = applied.channels.kick!;
    expect(before.channels[kick]?.name).toBe('Kick');
    expect(before.channels[applied.channels.hat!]?.name).toBe('Hat');
    expect(before.channels[applied.channels['808']!]).toBeUndefined();
    expect(applied.created).toEqual([applied.channels['808']]);

    const ticks = (id: string) =>
      Object.values(pattern.notes[id as never] ?? {})
        .map((n) => n.tick)
        .sort((a, b) => a - b);
    expect(ticks(kick)).toEqual([0, 2400]);
    expect(ticks(applied.channels.hat!)).toEqual([0, 1560]);
    const bass = Object.values(pattern.notes[applied.channels['808']!] ?? {})[0];
    expect(bass).toMatchObject({ tick: 0, length: 2400, key: 29 });

    // Mix settings only go to the channel the assistant made; params are clamped, unknown ones ignored.
    const ch808 = p.channels[applied.channels['808']!] as InstrumentChannel;
    expect(ch808.volume).toBe(0.9);
    expect(ch808.plugin.params.nope).toBeUndefined();
    expect((p.channels[kick] as InstrumentChannel).volume).toBe((before.channels[kick] as InstrumentChannel).volume);

    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('changes the same pattern in place for a follow-up', () => {
    const s = createTestServices();
    const first = applyBeatSpec(s, beat());
    const second = applyBeatSpec(
      s,
      beat({
        title: 'Night trap v2',
        bars: 1,
        bpm: undefined,
        tracks: [
          { name: 'Kick', sound: 'kick', notes: [{ step: 4 }] },
          { name: '808', sound: '808', notes: [{ step: 4, len: 4, key: 31 }] },
        ],
      }),
      first,
    );
    const p = s.doc.getState().project;
    expect(second.patternId).toBe(first.patternId);
    expect(second.channels['808']).toBe(first.channels['808']);
    const pattern = p.patterns[first.patternId]!;
    expect(pattern.name).toBe('Night trap v2');
    expect(pattern.stepCount).toBe(16);
    // The hat the first version wrote is gone; the rest is rewritten.
    expect(pattern.notes[first.channels.hat!]).toBeUndefined();
    expect(Object.values(pattern.notes[first.channels.kick!] ?? {}).map((n) => n.tick)).toEqual([960]);
    expect(p.patternOrder.filter((id) => id === first.patternId)).toHaveLength(1);
  });

  it('starts a new pattern when the previous one was deleted', () => {
    const s = createTestServices();
    const first = applyBeatSpec(s, beat());
    s.history.undo();
    const again = applyBeatSpec(s, beat(), first);
    expect(s.doc.getState().project.patterns[again.patternId]).toBeDefined();
  });
});

const inst = (p: Project, id: ChannelId | undefined) => p.channels[id!] as InstrumentChannel;
const sampleOf = (p: Project, ch: InstrumentChannel) => {
  const src = p.samples[ch.plugin.samples?.main as SampleId]?.source;
  return src?.kind === 'builtin' ? src.generator : undefined;
};

describe('the beat writer in a style', () => {
  const styled = (style: BeatSpec['style'], tracks: BeatSpec['tracks']): BeatSpec => ({ title: 'Styled', bars: 1, style, tracks });

  it('plays new tracks on the style’s sounds and its drum kit', () => {
    const s = createTestServices();
    const applied = applyBeatSpec(
      s,
      styled('trap', [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }] },
        { name: 'Open hat', sound: 'open-hat', notes: [{ step: 2 }] },
        { name: 'Hat', sound: 'hat', notes: [{ step: 4 }] },
        { name: 'Pad', sound: 'pad', notes: [{ step: 0, len: 16, key: 60 }] },
        { name: 'Keys', sound: 'keys', notes: [{ step: 0, key: 64 }] },
        { name: '808', sound: '808', notes: [{ step: 0, len: 9, key: 29 }, { step: 8, len: 8, key: 41 }] },
      ]),
    );
    const p = s.doc.getState().project;
    // The default project's Kick and Hat were untouched and unused: they switch to the trap kit.
    const kick = inst(p, applied.channels.kick);
    expect(sampleOf(p, kick)).toBe('kit/trap/kick');
    expect(kick.plugin.params.velTone).toBe(0.5);
    expect(sampleOf(p, inst(p, applied.channels.hat))).toBe('kit/trap/hat');
    expect(inst(p, applied.channels.hat).volume).toBeLessThan(0.78);
    // The stock samples they played are gone; nothing else used them.
    expect(Object.values(p.samples).some((x) => x.source.kind === 'builtin' && x.source.generator === 'kit/kick')).toBe(false);
    // A new open hat with a closed hat in the beat: its envelope is on, so the note end chokes it.
    const open = inst(p, applied.channels['open hat']);
    expect(sampleOf(p, open)).toBe('kit/trap/open-hat');
    expect(open.plugin.params).toMatchObject({ envelope: true, release: 0.05, velTone: 0.5 });
    const pad = inst(p, applied.channels.pad);
    expect(pad.plugin.pluginId).toBe('agstudio.wavetable');
    expect(pad.plugin.params).toMatchObject({ unison: 7, filterType: 'lp24' });
    expect(inst(p, applied.channels.keys).plugin.pluginId).toBe('agstudio.fm');
    const bass = inst(p, applied.channels['808']);
    expect(bass.plugin.params).toMatchObject({ drive: 0.35, glide: 0.1 });
    expect(bass.rootKey).toBe(36);
  });

  it('keeps a kit channel the musician tuned or uses elsewhere', () => {
    const s = createTestServices();
    const p0 = s.doc.getState().project;
    const kickId = p0.channelOrder.find((id) => p0.channels[id]!.name === 'Kick')!;
    const hatId = p0.channelOrder.find((id) => p0.channels[id]!.name === 'Hat')!;
    s.history.transact('tune', (d) => {
      (d.channels[kickId] as InstrumentChannel).plugin.params.gain = -3;
      d.patterns[d.patternOrder[0]!]!.notes[hatId] = { n1: { id: 'n1', tick: 0, length: 240, key: 60, velocity: 0.8 } } as never;
    });
    const applied = applyBeatSpec(
      s,
      styled('house', [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }] },
        { name: 'Hat', sound: 'hat', notes: [{ step: 2 }] },
      ]),
    );
    const p = s.doc.getState().project;
    expect(applied.channels.kick).toBe(kickId);
    expect(sampleOf(p, inst(p, kickId))).toBe('kit/kick');
    expect(sampleOf(p, inst(p, hatId))).toBe('kit/hat-closed');
    expect(inst(p, hatId).plugin.params.velTone ?? 0).toBe(0);
  });

  it('finds a named preset on whichever instrument has it, and says when none does', () => {
    const s = createTestServices();
    const plan = planBeat(
      s,
      s.doc.getState().project,
      styled('trap', [
        { name: 'Lead', sound: 'lead', preset: 'marimba', notes: [{ step: 0, key: 72 }] },
        { name: 'Pad', sound: 'pad', preset: 'No such sound', notes: [{ step: 0, key: 60 }] },
      ]),
    );
    expect(plan.tracks[0]!.make?.plugin.pluginId).toBe('agstudio.fm');
    expect(plan.tracks[1]!.make?.plugin.pluginId).toBe('agstudio.wavetable');
    expect(plan.warnings.join()).toContain('No such sound');
  });

  it('makes overlapping 808 notes glide at least 60 ms', () => {
    const s = createTestServices();
    const applied = applyBeatSpec(
      s,
      styled('trap', [
        { name: '808', sound: '808', params: { glide: 0.01 }, notes: [{ step: 0, len: 9, key: 29 }, { step: 8, len: 8, key: 41 }] },
      ]),
    );
    expect(inst(s.doc.getState().project, applied.channels['808']).plugin.params.glide).toBe(0.06);
  });

  it('sets the levels a beat gives on any channel, even one it reuses', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const plan = planBeat(s, before, styled('trap', [{ name: 'Kick', sound: 'kick', volume: 0.5, pan: -0.2, notes: [{ step: 0 }] }]));
    s.history.transact('beat', (d) => writeBeat(s, d, styled('trap', plan.tracks.map((t) => t.track)), plan));
    const kick = inst(s.doc.getState().project, plan.channels.kick);
    expect(before.channels[plan.channels.kick!]).toBeDefined();
    expect(kick).toMatchObject({ volume: 0.5, pan: -0.2 });
    expect([...plan.levels]).toEqual([plan.channels.kick]);
  });

  it('rewrites a pattern it names, replacing its notes, and reuses channels by name', () => {
    const s = createTestServices();
    const verse = applyBeatSpec(
      s,
      styled('trap', [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }] },
        { name: 'Lead', sound: 'lead', notes: [{ step: 0, key: 72 }] },
      ]),
    );
    // A second beat (no previous): its "Lead" plays the Verse's Lead channel.
    const drop = applyBeatSpec(s, styled('trap', [{ name: 'Lead', sound: 'lead', notes: [{ step: 4, key: 74 }] }]), null, {
      own: verse.created,
    });
    expect(drop.patternId).not.toBe(verse.patternId);
    expect(drop.channels.lead).toBe(verse.channels.lead);
    const again = applyBeatSpec(s, styled('trap', [{ name: 'Lead', sound: 'lead', notes: [{ step: 8, key: 76 }] }]), null, {
      patternId: verse.patternId,
    });
    const p = s.doc.getState().project;
    expect(again.patternId).toBe(verse.patternId);
    const notes = p.patterns[verse.patternId]!.notes;
    expect(notes[verse.channels.kick!]).toBeUndefined();
    expect(Object.values(notes[verse.channels.lead!] ?? {}).map((n) => n.key)).toEqual([76]);
  });
});
