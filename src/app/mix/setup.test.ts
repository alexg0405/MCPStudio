import { describe, expect, it } from 'vitest';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { MASTER, type ChannelId, type InsertId, type InstrumentChannel, type Project } from '@core/model/types';
import { addFxSlot, addInsert } from '@core/ops/mixer';
import { applyBeatSpec } from '../assistant/apply';
import { createTestServices } from '../testing';
import { BUS_NAMES, findMixLayout, mixRoles } from './layout';
import { BUS_ORDER, busRecipe, MASTER_CHAIN } from './recipes';
import { setupMix, type SetupMixOptions } from './setup';
import { STYLES } from '@core/beat/style';

type S = ReturnType<typeof createTestServices>;

/** The default project (Kick, Clap, Hat, Snare) plus a trap beat with an 808, a pad and a lead. */
function song(): S {
  const s = createTestServices();
  applyBeatSpec(s, {
    title: 'Trap',
    bars: 1,
    style: 'trap',
    tracks: [
      { name: 'Kick', sound: 'kick', notes: [{ step: 0 }] },
      { name: 'Hat', sound: 'hat', notes: [{ step: 2 }] },
      { name: '808', sound: '808', notes: [{ step: 0, len: 8, key: 29 }] },
      { name: 'Pad', sound: 'pad', notes: [{ step: 0, len: 16, key: 60 }] },
      { name: 'Lead', sound: 'lead', notes: [{ step: 4, key: 72 }] },
    ],
  });
  return s;
}

const run = (s: S, opts: Partial<SetupMixOptions> = {}) => {
  let res!: ReturnType<typeof setupMix>;
  s.history.transact('mix', (d) => {
    res = setupMix(d, s, { style: 'trap', mode: 'rebuild', roles: mixRoles(d as unknown as Project), ...opts });
  });
  return res;
};
const project = (s: S) => s.doc.getState().project;
const channel = (s: S, name: string) => Object.values(project(s).channels).find((c) => c.name === name) as InstrumentChannel;
const db = (gain: number) => Math.round(20 * Math.log10(gain) * 10) / 10;

describe('mix setup', () => {
  it('builds the role buses on the empty Insert tracks, with their effects, sends and the master chain', () => {
    const s = song();
    const before = project(s).mixer.order.slice();
    const res = run(s);
    const p = project(s);
    const { buses } = res.layout;
    // Inserts 1–7 became the buses, in order; no new tracks.
    expect(p.mixer.order).toEqual(before);
    expect(['kick', 'drums', 'bass', 'chords', 'lead', 'reverb', 'delay'].map((r) => p.mixer.order.indexOf(buses[r as keyof typeof buses]!))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(buses.fx).toBeUndefined();
    // Channels by role.
    expect(channel(s, 'Kick').output).toBe(buses.kick);
    for (const name of ['Hat', 'Clap', 'Snare']) expect(channel(s, name).output).toBe(buses.drums);
    expect(channel(s, '808').output).toBe(buses.bass);
    expect(channel(s, 'Pad').output).toBe(buses.chords);
    expect(channel(s, 'Lead').output).toBe(buses.lead);
    // Faders and sends.
    const ins = (id: InsertId | undefined) => p.mixer.inserts[id!]!;
    expect([buses.kick, buses.drums, buses.bass, buses.chords, buses.lead].map((id) => db(ins(id).volume))).toEqual([0, -2, -2, -6, -3]);
    const send = (from: InsertId | undefined, to: InsertId | undefined) => db(ins(from).routes.find((r) => r.to === to)!.level);
    expect(send(buses.chords, buses.reverb)).toBe(-12);
    expect(send(buses.lead, buses.reverb)).toBe(-14);
    expect(send(buses.lead, buses.delay)).toBe(-18);
    // The ducks listen to the Kick bus.
    const duckers = Object.values(p.mixer.inserts).flatMap((i) => i.fx.filter((f) => f.plugin.pluginId === 'agstudio.ducker').map((f) => [i.id, f.sidechain]));
    expect(duckers).toEqual([
      [buses.bass, buses.kick],
      [buses.chords, buses.kick],
    ]);
    // Master: EQ Pro, Saturator, and the Limiter last at −1 dB with true peak.
    const master = p.mixer.inserts[MASTER]!.fx;
    expect(master.map((f) => f.plugin.pluginId)).toEqual(['agstudio.eq-pro', 'agstudio.saturator', 'agstudio.limiter']);
    expect(master[2]!.plugin.params).toMatchObject({ ceiling: -1, truePeak: true });
    expect(master[1]!.plugin.params).toMatchObject({ mode: 'tape', drive: 2, mix: 0.5 });
    // The sweep targets on the Chords EQ: band 1 a 150 Hz high-pass, band 8 a low-pass at 20 kHz.
    const eq = ins(buses.chords).fx[0]!.plugin.params;
    expect(eq).toMatchObject({ b1On: true, b1Type: 'lowCut24', b1Freq: 150, b8On: true, b8Type: 'highCut24', b8Freq: 20000 });
    expect(res.layout.eq.chords).toBe(ins(buses.chords).fx[0]!.id);
    expect(res.layout.limiter).toBe(master[2]!.id);
    expect(res.changes[0]).toMatch(/^Set up the Trap mix: Kick, Drums, 808, Chords, Lead buses, Reverb \(plate reverb\) and Delay \(dotted ping-pong delay\) returns \(on Insert 1, .*Insert 7\)$/);
    expect(res.changes).toContain('Routed 7 channels to their buses');
  });

  it('changes nothing when run again', () => {
    const s = song();
    run(s);
    const once = project(s);
    const again = run(s);
    expect(project(s)).toBe(once);
    expect(again.changes).toEqual([]);
  });

  it('fill-gaps routes only channels still on the master and leaves set faders alone', () => {
    const s = song();
    const mine = 'ins_mine' as InsertId;
    s.history.transact('own track', (d) => {
      addInsert(d, { ...makeInsert(mine, 'My hats'), volume: 0.5 });
      (d.channels[channel(s, 'Hat').id as ChannelId] as InstrumentChannel).output = mine;
    });
    const res = run(s, { mode: 'fill-gaps' });
    expect(channel(s, 'Hat').output).toBe(mine);
    expect(project(s).mixer.inserts[mine]!.volume).toBe(0.5);
    expect(channel(s, 'Kick').output).toBe(res.layout.buses.kick);
  });

  it('leaves the faders the AI set alone, and channel levels it gave', () => {
    const s = song();
    const kickBus = project(s).mixer.order[1]!;
    const lead = channel(s, 'Lead');
    s.history.transact('levels', (d) => {
      d.mixer.inserts[kickBus]!.volume = 0.7;
      (d.channels[lead.id] as InstrumentChannel).volume = 0.78;
    });
    run(s, { pinned: new Set([kickBus]), pinnedChannels: new Set([lead.id]) });
    expect(project(s).mixer.inserts[kickBus]!.volume).toBe(0.7);
    expect(channel(s, 'Lead').volume).toBe(0.78);
    // Channels nobody set (the default project's Clap at 0.78) get their role's level.
    expect(channel(s, 'Clap').volume).toBeCloseTo(0.8);
  });

  it('reuses the master’s Limiter (moved last) and buses the arranger made', () => {
    const s = song();
    const chords = 'ins_chords' as InsertId;
    s.history.transact('arranger', (d) => {
      addFxSlot(d, MASTER, makePluginInstance('agstudio.limiter', 1, { input: 3, ceiling: -0.3, release: 80, truePeak: false }));
      addFxSlot(d, MASTER, makePluginInstance('agstudio.stereo', 1, {}));
      addInsert(d, makeInsert(chords, BUS_NAMES.chords));
      addFxSlot(d, chords, makePluginInstance('agstudio.eq-pro', 1, {}));
    });
    const res = run(s);
    const master = project(s).mixer.inserts[MASTER]!.fx;
    expect(master.filter((f) => f.plugin.pluginId === 'agstudio.limiter')).toHaveLength(1);
    expect(master.at(-1)!.plugin).toMatchObject({ pluginId: 'agstudio.limiter', params: { input: 3, ceiling: -1, truePeak: true } });
    expect(res.layout.buses.chords).toBe(chords);
    const eqs = project(s).mixer.inserts[chords]!.fx.filter((f) => f.plugin.pluginId === 'agstudio.eq-pro');
    expect(eqs).toHaveLength(1);
    expect(eqs[0]!.plugin.params).toMatchObject({ b1On: true, b1Freq: 150, b8On: true });
    expect(channel(s, 'Pad').output).toBe(chords);
    expect(findMixLayout(project(s)).buses.chords).toBe(chords);
  });

  it('routes voices to a Vocals bus with its own fader, the vocal chain and sends, and leaves the Lead bus to the lead', () => {
    const s = song();
    applyBeatSpec(s, { title: 'Vox', bars: 1, style: 'trap', tracks: [{ name: 'Vocal Chop', sound: 'lead', notes: [{ step: 0, key: 72 }] }] });
    const res = run(s);
    const p = project(s);
    const { buses } = res.layout;
    expect(buses.vocals).toBeDefined();
    expect(p.mixer.inserts[buses.vocals!]!.name).toBe('Vocals');
    expect(channel(s, 'Vocal Chop').output).toBe(buses.vocals);
    expect(channel(s, 'Lead').output).toBe(buses.lead);
    // The bus carries the pop vocal chain's EQ, compressor and de-esser.
    expect(p.mixer.inserts[buses.vocals!]!.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.eq-pro', 'agstudio.compressor', 'agstudio.de-esser']);
    expect(db(p.mixer.inserts[buses.vocals!]!.volume)).toBe(-2);
    const send = (to: InsertId | undefined) => db(p.mixer.inserts[buses.vocals!]!.routes.find((r) => r.to === to)!.level);
    expect(send(buses.reverb)).toBe(-14);
    expect(send(buses.delay)).toBe(-20);
    // Running it again changes nothing.
    const once = project(s);
    run(s);
    expect(project(s)).toBe(once);
    expect(findMixLayout(project(s)).buses.vocals).toBe(buses.vocals);
  });

  it('a song with only a voice still gets its Reverb and Delay returns; old projects with the voice on the Lead bus keep working', () => {
    const s = createTestServices();
    applyBeatSpec(s, { title: 'Voice', bars: 1, style: 'pop', tracks: [{ name: 'Vocals', sound: 'lead', notes: [{ step: 0, key: 72 }] }] });
    const res = run(s, { style: 'pop' });
    expect(res.layout.buses.vocals && res.layout.buses.reverb && res.layout.buses.delay).toBeTruthy();
    expect(res.layout.buses.lead).toBeUndefined();
    // A project made before the Vocals bus: the voice is on the Lead bus, found by name, and fill-gaps leaves it there.
    const old = song();
    const before = run(old);
    old.history.transact('the lead is a voice', (d) => {
      d.channels[channel(old, 'Lead').id as ChannelId]!.name = 'Vocal';
    });
    const again = run(old, { mode: 'fill-gaps' });
    expect(channel(old, 'Vocal').output).toBe(before.layout.buses.lead);
    expect(again.layout.buses.lead).toBe(before.layout.buses.lead);
    expect(again.layout.buses.vocals).toBeDefined();
  });

  it('uses only presets and params the plugins have', () => {
    const s = createTestServices();
    for (const style of STYLES)
      for (const fx of [...BUS_ORDER.flatMap((r) => busRecipe(r, style).fx), ...MASTER_CHAIN]) {
        const def = s.plugins.get(fx.pluginId);
        expect(def, fx.pluginId).toBeDefined();
        if (fx.preset) expect(def!.presets?.map((x) => x.name), `${style} ${fx.label}`).toContain(fx.preset);
        for (const k of Object.keys(fx.params ?? {})) expect(def!.params[k], `${fx.pluginId}.${k}`).toBeDefined();
      }
  });
});
