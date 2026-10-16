import { describe, expect, it } from 'vitest';
import { CONTROLLER_PRESETS, presetForDevice } from '@core/midi-map/presets';
import { allTargets, targetInfo } from '@core/midi-map/targets';
import { fakeSampleRef, FakeDecks } from '../../../../test/helpers/fake-decks';
import { FakeMidiAccess, msg } from '../../../../test/helpers/fake-midi';
import { eqDbFromKnob, eqKnobFromDb, faderFromPitch, filterFromKnob, pitchFromFader } from './abs';
import type { BrowseSong } from './browse';
import { JOG_TICKS_PER_TURN } from './dispatch';
import { DjControllers, learnMismatch } from './manager';
import { memoryControllerStorage } from './storage';
import { ledStates } from './leds';
import { fakeDecksState } from './fake-decks';

const SONGS: BrowseSong[] = ['One', 'Two', 'Three'].map((t) => ({ key: t, ref: fakeSampleRef(t), title: t, label: t, artist: 'Band' }));

async function setup(opts: { devices?: string[]; saved?: Record<string, unknown> } = {}) {
  const access = new FakeMidiAccess();
  const decks = new FakeDecks();
  const storage = memoryControllerStorage({ mappings: opts.saved });
  const commands: string[] = [];
  const toasts: string[] = [];
  const devices = Object.fromEntries((opts.devices ?? []).map((d) => [d, access.plug(d)]));
  const c = new DjControllers({
    requestAccess: async () => access.asAccess(),
    getDecks: async () => ({ decks, fake: false }),
    storage,
    runCommand: (id) => commands.push(id),
    songs: () => SONGS,
    toast: (m) => toasts.push(m),
  });
  await c.restore();
  await c.enable();
  return { access, decks, storage, commands, toasts, c, devices };
}

describe('hardware ↔ deck value conversions', () => {
  it('EQ: kill at the left, 0 dB at the centre, +6 dB at the right, and back', () => {
    expect(eqDbFromKnob(0)).toBe(-26);
    expect(eqDbFromKnob(0.5)).toBe(0);
    expect(eqDbFromKnob(1)).toBe(6);
    for (const v of [0, 0.2, 0.5, 0.8, 1]) expect(eqKnobFromDb(eqDbFromKnob(v))).toBeCloseTo(v, 6);
  });
  it('filter has a dead zone in the middle', () => {
    expect(filterFromKnob(0.5)).toBe(0);
    expect(filterFromKnob(0.51)).toBe(0);
    expect(filterFromKnob(0)).toBe(-1);
    expect(filterFromKnob(1)).toBe(1);
  });
  it('pitch fader spans ± the range, higher = faster', () => {
    expect(pitchFromFader(0.5, 0.08)).toBe(0);
    expect(pitchFromFader(1, 0.08)).toBeCloseTo(0.08);
    expect(pitchFromFader(0, 0.16)).toBeCloseTo(-0.16);
    expect(faderFromPitch(0.04, 0.08)).toBeCloseTo(0.75);
  });
});

describe('presets', () => {
  it('are picked by the device name', () => {
    expect(presetForDevice('DDJ-400')?.id).toBe('pioneer-ddj-400');
    expect(presetForDevice('DDJ-FLX4')?.id).toBe('pioneer-ddj-flx4');
    expect(presetForDevice('DDJ-200')?.id).toBe('pioneer-ddj-200');
    expect(presetForDevice('DJControl Inpulse 300')?.id).toBe('hercules-inpulse-300');
    expect(presetForDevice('Hercules DJControl Inpulse 200 MIDI 1')?.id).toBe('hercules-inpulse-200');
    expect(presetForDevice('MIXTRACK PRO FX')?.id).toBe('numark-mixtrack-pro-fx');
    expect(presetForDevice('Launchpad Mini')).toBeNull();
  });
  it('only use real targets, with controls of the right kind, and name their source', () => {
    for (const p of CONTROLLER_PRESETS) {
      const m = p.mapping();
      expect(m.preset).toBe(p.id);
      expect(p.source).toMatch(/Mixxx/);
      expect(m.bindings.length).toBeGreaterThan(20);
      const ids = new Set(allTargets().map((t) => t.id));
      for (const b of m.bindings) {
        expect(ids.has(b.target), `${p.id}: ${b.target}`).toBe(true);
        expect(learnMismatch(targetInfo(b.target)!.kind, b.input, 'x'), `${p.id}: ${b.target} ${JSON.stringify(b.input)}`).toBeNull();
      }
      for (const l of m.leds) expect(targetInfo(l.state)?.led, `${p.id}: LED ${l.state}`).toBe(true);
      // One physical control drives one target per layer.
      const seen = new Set<string>();
      for (const b of m.bindings) {
        const k = `${JSON.stringify(b.input)}|${b.layer ?? ''}`;
        expect(seen.has(k), `${p.id}: duplicate ${k}`).toBe(false);
        seen.add(k);
      }
    }
  });
  it('the DDJ-400 map has the documented addresses', () => {
    const m = presetForDevice('DDJ-400')!.mapping();
    const find = (target: string) => m.bindings.filter((b) => b.target === target).map((b) => b.input);
    expect(find('A.play')).toEqual([{ type: 'note', channel: 0, note: 0x0b }]);
    expect(find('B.sync')).toEqual([{ type: 'note', channel: 1, note: 0x58 }]);
    expect(find('A.pitch')).toEqual([{ type: 'cc14', channel: 0, cc: 0x00 }]);
    expect(find('crossfader')).toEqual([{ type: 'cc14', channel: 6, cc: 0x1f }]);
    expect(find('browse')).toEqual([{ type: 'rel', channel: 6, cc: 0x40, encoding: 'twos' }]);
    expect(find('B.hotcue:8')).toEqual([{ type: 'note', channel: 9, note: 7 }]);
    expect(find('A.hotcueClear:1')).toEqual([{ type: 'note', channel: 8, note: 0 }]);
    expect(find('B.load')).toEqual([{ type: 'note', channel: 6, note: 0x47 }]);
  });
});

describe('controllers drive the decks', () => {
  it('turns notes, jog and pads into deck calls (DDJ-400)', async () => {
    const { c, decks, devices } = await setup({ devices: ['DDJ-400'] });
    const pad = devices['DDJ-400']!.input;
    pad.emit(msg.noteOn(0, 0x0b));
    pad.emit(msg.noteOff(0, 0x0b));
    expect(decks.callsOf('togglePlay')).toEqual([['togglePlay', 'A']]);
    pad.emit(msg.noteOn(1, 0x0c));
    pad.emit(msg.noteOff(1, 0x0c));
    expect(decks.callsOf('cueDown')).toEqual([['cueDown', 'B']]);
    expect(decks.callsOf('cueUp')).toEqual([['cueUp', 'B']]);
    pad.emit(msg.noteOn(1, 0x58));
    expect(decks.callsOf('sync')).toEqual([['sync', 'B', true]]);
    // Hot cue pad 3 of deck A, and clearing it with Shift.
    pad.emit(msg.noteOn(7, 2));
    pad.emit(msg.noteOn(8, 2));
    expect(decks.callsOf('hotCue')).toEqual([['hotCue', 'A', 2]]);
    expect(decks.callsOf('clearHotCue')).toEqual([['clearHotCue', 'A', 2]]);
    // Beat loop pad (4 beats), pressed twice: starts it, then leaves it.
    decks.arrange('A', { baseBpm: 120 });
    pad.emit(msg.noteOn(7, 0x64));
    expect(decks.callsOf('autoLoop')).toEqual([['autoLoop', 'A', 4]]);
    pad.emit(msg.noteOn(7, 0x64));
    expect(decks.callsOf('exitLoop')).toEqual([['exitLoop', 'A']]);
    // Jog: nudges until the platter is touched, then scratches.
    pad.emit(msg.cc(0, 0x22, 65));
    pad.emit(msg.noteOn(0, 0x36));
    pad.emit(msg.cc(0, 0x22, 62));
    pad.emit(msg.noteOff(0, 0x36));
    expect(decks.callsOf('jog')).toEqual([
      ['jog', 'A', 1 / JOG_TICKS_PER_TURN, 'nudge'],
      ['jog', 'A', -2 / JOG_TICKS_PER_TURN, 'scratch'],
    ]);
    expect(decks.callsOf('jogTouch')).toEqual([
      ['jogTouch', 'A', true],
      ['jogTouch', 'A', false],
    ]);
    c.disable();
  });

  it('applies faders, EQ, filter and the crossfader (14-bit pairs) once the hardware meets the screen', async () => {
    const { decks, devices } = await setup({ devices: ['DDJ-400'] });
    const pad = devices['DDJ-400']!.input;
    // Deck A volume is 1: a fader parked low does nothing until it reaches the top.
    pad.emit(msg.cc(0, 0x13, 20));
    pad.emit(msg.cc(0, 0x33, 0));
    expect(decks.callsOf('setVolume')).toEqual([]);
    pad.emit(msg.cc(0, 0x13, 127));
    pad.emit(msg.cc(0, 0x33, 127));
    expect(decks.callsOf('setVolume')).toEqual([['setVolume', 'A', 1]]);
    // EQ low of deck B at the centre (0 dB): picks up at once, then kills.
    pad.emit(msg.cc(1, 0x0f, 64));
    pad.emit(msg.cc(1, 0x2f, 0));
    pad.emit(msg.cc(1, 0x0f, 0));
    pad.emit(msg.cc(1, 0x2f, 0));
    const eq = decks.callsOf('setEq').map((x) => x[3] as number);
    expect(eq.at(-1)).toBe(-26);
    expect(eq[0]).toBeCloseTo(0, 2);
    // A new pair writes once when its fine byte lands (the very first coarse byte also writes, before the pair is known).
    const before = decks.callsOf('setEq').length;
    pad.emit(msg.cc(1, 0x0f, 40));
    pad.emit(msg.cc(1, 0x2f, 0));
    expect(decks.callsOf('setEq')).toHaveLength(before + 1);
    // Pitch fader of deck A: centre then up.
    pad.emit(msg.cc(0, 0x00, 64));
    pad.emit(msg.cc(0, 0x20, 0));
    pad.emit(msg.cc(0, 0x00, 96));
    pad.emit(msg.cc(0, 0x20, 0));
    const pitches = decks.callsOf('setPitch').map((x) => x[2] as number);
    expect(pitches[0]).toBeCloseTo(0, 3);
    expect(pitches.at(-1)).toBeCloseTo(0.04, 3);
    // Crossfader at the centre: picks up (current 0), then full right.
    pad.emit(msg.cc(6, 0x1f, 64));
    pad.emit(msg.cc(6, 0x3f, 0));
    pad.emit(msg.cc(6, 0x1f, 127));
    pad.emit(msg.cc(6, 0x3f, 127));
    const xf = decks.callsOf('setCrossfader').map((x) => x[1] as number);
    expect(xf[0]).toBeCloseTo(0, 3);
    expect(xf.at(-1)).toBe(1);
  });

  it('picks up again after the mouse moved the value', async () => {
    const { decks, devices } = await setup({ devices: ['DDJ-400'] });
    const pad = devices['DDJ-400']!.input;
    const sendVol = (v: number) => {
      pad.emit(msg.cc(0, 0x13, v));
      pad.emit(msg.cc(0, 0x33, 0));
    };
    sendVol(127); // picked up (value 1)
    sendVol(100);
    expect(decks.callsOf('setVolume').length).toBeGreaterThanOrEqual(2);
    decks.setVolume('A', 0.2); // the mouse
    decks.calls.length = 0;
    sendVol(110); // far from 0.2: ignored
    expect(decks.callsOf('setVolume')).toEqual([]);
    sendVol(25); // reaches it
    expect(decks.callsOf('setVolume')).toHaveLength(1);
  });

  it('browse encoder moves the highlight; a load button loads it on its deck', async () => {
    const { c, decks, devices } = await setup({ devices: ['DDJ-400'] });
    const pad = devices['DDJ-400']!.input;
    pad.emit(msg.cc(6, 0x40, 1));
    pad.emit(msg.cc(6, 0x40, 1));
    expect(c.browse.current()?.title).toBe('Three');
    pad.emit(msg.cc(6, 0x40, 127));
    expect(c.browse.current()?.title).toBe('Two');
    pad.emit(msg.noteOn(6, 0x47));
    expect(decks.callsOf('load')).toEqual([['load', 'B', 'Two', 'Two', 'Band']]);
    pad.emit(msg.cc(6, 0x40, 127));
    pad.emit(msg.cc(6, 0x40, 127));
    pad.emit(msg.cc(6, 0x40, 127));
    expect(c.browse.current()?.title).toBe('One');
  });

  it('runs app commands (project play)', async () => {
    const { c, commands, devices } = await setup({ devices: ['Pad'] });
    c.setMapping('Pad', { ...c.mappingFor('Pad'), bindings: [{ input: { type: 'note', channel: 0, note: 1 }, target: 'app.playPause' }] });
    devices['Pad']!.input.emit(msg.noteOn(0, 1));
    expect(commands).toEqual(['transport.playPause']);
  });

  it('toggles recording with the record button', async () => {
    const { c, decks, devices } = await setup({ devices: ['Pad'] });
    c.setMapping('Pad', { ...c.mappingFor('Pad'), bindings: [{ input: { type: 'note', channel: 0, note: 1 }, target: 'record' }] });
    devices['Pad']!.input.emit(msg.noteOn(0, 1));
    expect(decks.callsOf('startRecording')).toHaveLength(1);
    expect(decks.store.getState().recording).not.toBeNull();
    devices['Pad']!.input.emit(msg.noteOn(0, 1));
    expect(decks.callsOf('stopRecording')).toHaveLength(1);
  });

  it('a device in a shift layer does different things with Shift held', async () => {
    const { c, decks, devices } = await setup({ devices: ['Pad'] });
    c.setMapping('Pad', {
      ...c.mappingFor('Pad'),
      shifts: [{ id: 'shift', input: { type: 'note', channel: 0, note: 60 } }],
      bindings: [
        { input: { type: 'note', channel: 0, note: 1 }, target: 'A.play' },
        { input: { type: 'note', channel: 0, note: 1 }, target: 'A.sync', layer: 'shift' },
      ],
    });
    const pad = devices['Pad']!.input;
    pad.emit(msg.noteOn(0, 1));
    pad.emit(msg.noteOn(0, 60));
    pad.emit(msg.noteOn(0, 1));
    expect(decks.calls.map((x) => x[0])).toEqual(['togglePlay', 'sync']);
  });
});

describe('LED feedback', () => {
  it('sends every LED when a controller connects, then only what changes', async () => {
    const { decks, devices } = await setup({ devices: ['DDJ-400'] });
    const out = devices['DDJ-400']!.output!;
    // The connect sync: everything off, nothing twice.
    expect(out.sent).toContainEqual([0x90, 0x0b, 0]);
    expect(out.sent).toContainEqual([0x90, 0x0c, 0]);
    expect(out.sent).toContainEqual([0x91, 0x58, 0]);
    expect(out.sent).toContainEqual([0x97, 0x00, 0]);
    const unique = new Set(out.sent.map((m) => m.join(',')));
    expect(unique.size).toBe(out.sent.length);
    out.clear();
    decks.play('A');
    expect(out.sent).toEqual([[0x90, 0x0b, 127]]);
    out.clear();
    decks.play('A'); // no change
    expect(out.sent).toEqual([]);
    decks.sync('B', true);
    decks.arrange('A', { hotCues: [12, null, null, null, null, null, null, 30] });
    expect(out.sent).toContainEqual([0x91, 0x58, 127]);
    expect(out.sent).toContainEqual([0x97, 0x00, 127]);
    expect(out.sent).toContainEqual([0x97, 0x07, 127]);
    out.clear();
    decks.pause('A');
    expect(out.sent).toEqual([[0x90, 0x0b, 0]]);
    // A 4-beat loop lights its pad.
    out.clear();
    decks.arrange('B', { baseBpm: 120 });
    decks.autoLoop('B', 4);
    expect(out.sent).toContainEqual([0x99, 0x64, 127]);
  });

  it('lights the cue LED while paused on the cue point, and the loop pad only for its own length', () => {
    const s = fakeDecksState();
    s.decks.A.song = { ref: fakeSampleRef('x'), title: 'x', durationSec: 100 };
    expect(ledStates(s).get('A.cue')).toBe(true);
    s.decks.A.positionSec = 3;
    expect(ledStates(s).get('A.cue')).toBe(false);
    s.decks.A.baseBpm = 120;
    s.decks.A.loop = { startSec: 0, endSec: 2, active: true }; // 4 beats at 120 bpm
    const st = ledStates(s);
    expect(st.get('A.autoLoop:4')).toBe(true);
    expect(st.get('A.autoLoop:8')).toBe(false);
    expect(st.get('A.loopExit')).toBe(true);
  });

  it('uses the brightness values of the mapping (Mixtrack: 127 on, 1 off) and clears when let go', async () => {
    const { c, decks, devices } = await setup({ devices: ['Mixtrack Pro FX'] });
    const out = devices['Mixtrack Pro FX']!.output!;
    expect(out.sent).toContainEqual([0x90, 0x00, 1]);
    out.clear();
    decks.play('A');
    expect(out.sent).toEqual([[0x90, 0x00, 127]]);
    out.clear();
    c.disable();
    expect(out.sent).toContainEqual([0x90, 0x00, 1]);
  });

  it('lights the LED at a learned button’s own note', async () => {
    const { c, decks, devices } = await setup({ devices: ['Mystery pad'] });
    c.setMapping('Mystery pad', { ...c.mappingFor('Mystery pad'), bindings: [{ input: { type: 'note', channel: 2, note: 40 }, target: 'A.play' }] });
    const out = devices['Mystery pad']!.output!;
    out.clear();
    decks.play('A');
    expect(out.sent).toEqual([[0x92, 40, 127]]);
    c.setOptions('Mystery pad', { ledFromButtons: false });
    out.clear();
    decks.pause('A');
    decks.play('A');
    expect(out.sent).toEqual([]);
  });

  it('works without an output port', async () => {
    const access = new FakeMidiAccess();
    const { input } = access.plug('DDJ-400', { output: false });
    const decks = new FakeDecks();
    const c = new DjControllers({ requestAccess: async () => access.asAccess(), getDecks: async () => ({ decks, fake: false }), storage: memoryControllerStorage(), runCommand: () => {} });
    await c.enable();
    expect(c.store.getState().devices[0]).toMatchObject({ name: 'DDJ-400', hasOutput: false });
    decks.play('A');
    input.emit(msg.noteOn(0, 0x0b));
    expect(decks.callsOf('togglePlay')).toHaveLength(1);
  });
});

describe('MIDI learn', () => {
  it('learns a button from a press and uses it at once', async () => {
    const { c, decks, devices, storage } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.learnTarget('A.play');
    expect(c.store.getState().learn?.message).toMatch(/press the button/);
    pad.emit(msg.noteOn(3, 36));
    expect(c.store.getState().learn).toBeNull();
    expect(c.mappingFor('Mystery pad').bindings).toEqual([{ input: { type: 'note', channel: 3, note: 36 }, target: 'A.play' }]);
    pad.emit(msg.noteOn(3, 36));
    expect(decks.callsOf('togglePlay')).toEqual([['togglePlay', 'A']]);
    // Saved per device name.
    await Promise.resolve();
    expect(Object.keys(storage.data.mappings)).toEqual(['Mystery pad']);
  });

  it('learns a fader, a 14-bit fader and an endless dial from their messages', async () => {
    const { c, devices } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.learnTarget('B.volume');
    for (const v of [0, 5, 12, 30, 55, 90]) pad.emit(msg.cc(1, 7, v));
    c.learnTarget('A.pitch');
    for (const [msb, lsb] of [[60, 2], [61, 90], [62, 5]]) {
      pad.emit(msg.cc(0, 1, msb!));
      pad.emit(msg.cc(0, 33, lsb!));
    }
    c.learnTarget('A.jog');
    for (const v of [1, 1, 2, 1, 127, 126, 127, 127]) pad.emit(msg.cc(0, 20, v));
    const inputs = Object.fromEntries(c.mappingFor('Mystery pad').bindings.map((b) => [b.target, b.input]));
    expect(inputs['B.volume']).toEqual({ type: 'cc', channel: 1, cc: 7 });
    expect(inputs['A.pitch']).toEqual({ type: 'cc14', channel: 0, cc: 1 });
    expect(inputs['A.jog']).toEqual({ type: 'rel', channel: 0, cc: 20, encoding: 'twos' });
  });

  it('keeps waiting when the control does not fit the target, and says why', async () => {
    const { c, devices } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.learnTarget('A.volume');
    pad.emit(msg.noteOn(0, 10));
    expect(c.store.getState().learn?.target).toBe('A.volume');
    expect(c.store.getState().learn?.message).toMatch(/needs a fader or knob/);
    expect(c.mappingFor('Mystery pad').bindings).toEqual([]);
    for (const v of [3, 20, 44, 80]) pad.emit(msg.cc(0, 11, v));
    expect(c.mappingFor('Mystery pad').bindings).toHaveLength(1);
  });

  it('learn mode: pick a target, touch the control, pick the next; Done leaves it', async () => {
    const { c, devices } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.startLearn();
    expect(c.store.getState().learn).toMatchObject({ target: null, session: 'mode' });
    pad.emit(msg.noteOn(0, 1)); // nothing picked: ignored (and runs the old mapping, which is empty)
    expect(c.mappingFor('Mystery pad').bindings).toEqual([]);
    c.learnTarget('A.cue');
    pad.emit(msg.noteOn(0, 2));
    expect(c.store.getState().learn).toMatchObject({ target: null, session: 'mode' });
    c.learnTarget('B.cue');
    pad.emit(msg.noteOn(0, 3));
    expect(c.mappingFor('Mystery pad').bindings.map((b) => b.target)).toEqual(['A.cue', 'B.cue']);
    c.cancelLearn();
    expect(c.store.getState().learn).toBeNull();
  });

  it('relearning a target replaces its control, and a control drives one target per layer', async () => {
    const { c, devices } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.learnTarget('A.play');
    pad.emit(msg.noteOn(0, 1));
    c.learnTarget('A.play');
    pad.emit(msg.noteOn(0, 2));
    expect(c.mappingFor('Mystery pad').bindings.map((b) => b.input)).toEqual([{ type: 'note', channel: 0, note: 2 }]);
    c.learnTarget('B.play');
    pad.emit(msg.noteOn(0, 2));
    expect(c.mappingFor('Mystery pad').bindings.map((b) => b.target)).toEqual(['B.play']);
  });

  it('learns a Shift key and then shifted functions', async () => {
    const { c, decks, devices } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.learnTarget('A.sync', true);
    pad.emit(msg.noteOn(0, 5));
    expect(c.store.getState().learn?.message).toMatch(/Link the Shift key first/);
    c.learnTarget('shift');
    pad.emit(msg.noteOn(0, 50));
    expect(c.mappingFor('Mystery pad').shifts).toEqual([{ id: 'shift', input: { type: 'note', channel: 0, note: 50 } }]);
    c.learnTarget('A.play');
    pad.emit(msg.noteOn(0, 5));
    c.learnTarget('A.sync', true);
    // The held Shift key is not mistaken for the control.
    pad.emit(msg.noteOn(0, 50));
    expect(c.store.getState().learn?.target).toBe('A.sync');
    pad.emit(msg.noteOn(0, 5));
    expect(c.mappingFor('Mystery pad').bindings).toEqual([
      { input: { type: 'note', channel: 0, note: 5 }, target: 'A.play' },
      { input: { type: 'note', channel: 0, note: 5 }, target: 'A.sync', layer: 'shift' },
    ]);
    pad.emit(msg.noteOn(0, 5));
    pad.emit(msg.noteOn(0, 50));
    pad.emit(msg.noteOn(0, 5));
    expect(decks.calls.map((x) => x[0])).toEqual(['togglePlay', 'sync']);
  });

  it('finishLearn uses the best guess for a dial turned one way only', async () => {
    const { c, devices } = await setup({ devices: ['Mystery pad'] });
    const pad = devices['Mystery pad']!.input;
    c.learnTarget('browse');
    for (const v of [1, 1, 1, 2, 1]) pad.emit(msg.cc(0, 9, v));
    expect(c.store.getState().learn?.target).toBe('browse');
    c.finishLearn();
    expect(c.mappingFor('Mystery pad').bindings[0]?.input).toEqual({ type: 'rel', channel: 0, cc: 9, encoding: 'twos' });
  });
});

describe('mappings: saved, exported, imported, reset', () => {
  it('keeps the musician’s mapping per device name and brings it back', async () => {
    const first = await setup({ devices: ['Mystery pad'] });
    first.c.learnTarget('A.play');
    first.devices['Mystery pad']!.input.emit(msg.noteOn(0, 9));
    await Promise.resolve();
    const second = await setup({ devices: ['Mystery pad'], saved: first.storage.data.mappings });
    expect(second.c.mappingFor('Mystery pad').bindings).toHaveLength(1);
    expect(second.c.store.getState().customized['Mystery pad']).toBe(true);
    second.devices['Mystery pad']!.input.emit(msg.noteOn(0, 9));
    expect(second.decks.callsOf('togglePlay')).toHaveLength(1);
  });

  it('does not save an untouched preset, but does once it is changed; reset goes back to the preset', async () => {
    const { c, storage } = await setup({ devices: ['DDJ-400'] });
    await Promise.resolve();
    expect(storage.data.mappings).toEqual({});
    c.clearTarget('DDJ-400', 'A.play');
    await Promise.resolve();
    expect(Object.keys(storage.data.mappings)).toEqual(['DDJ-400']);
    expect(c.bindingsFor('DDJ-400', 'A.play')).toEqual([]);
    c.resetMapping('DDJ-400');
    await Promise.resolve();
    expect(c.bindingsFor('DDJ-400', 'A.play')).toHaveLength(1);
    expect(storage.data.mappings).toEqual({});
  });

  it('exports and imports a mapping as JSON, and rejects what is not one', async () => {
    const { c, devices } = await setup({ devices: ['DDJ-400', 'Mystery pad'] });
    const json = c.exportJson('DDJ-400');
    const imported = c.importJson('Mystery pad', json);
    expect(imported).toEqual({ dropped: 0, bindings: c.mappingFor('DDJ-400').bindings.length });
    expect(c.mappingFor('Mystery pad').bindings).toEqual(c.mappingFor('DDJ-400').bindings);
    expect(c.importJson('Mystery pad', 'nope')).toBeNull();
    devices['Mystery pad']!.input.emit(msg.noteOn(0, 0x0b));
  });

  it('edits a binding (invert, jog speed) and clears one', async () => {
    const { c } = await setup({ devices: ['DDJ-400'] });
    const index = c.bindingsFor('DDJ-400', 'A.pitch')[0]!.index;
    c.updateBinding('DDJ-400', index!, { invert: true });
    expect(c.mappingFor('DDJ-400').bindings[index!]!.invert).toBe(true);
    c.updateBinding('DDJ-400', index!, { invert: false });
    expect(c.mappingFor('DDJ-400').bindings[index!]).not.toHaveProperty('invert');
    c.removeBinding('DDJ-400', index!);
    expect(c.bindingsFor('DDJ-400', 'A.pitch')).toEqual([]);
  });
});

describe('access and devices', () => {
  it('handles a denied permission gracefully', async () => {
    const decks = new FakeDecks();
    const toasts: string[] = [];
    const c = new DjControllers({
      requestAccess: async () => {
        throw new Error('denied');
      },
      getDecks: async () => ({ decks, fake: false }),
      storage: memoryControllerStorage(),
      runCommand: () => {},
      toast: (m) => toasts.push(m),
    });
    await c.enable();
    expect(c.store.getState().access).toBe('denied');
    expect(toasts[0]).toMatch(/not allowed/);
    expect(c.enabled).toBe(false);
  });

  it('follows devices being plugged and unplugged, and claims mapped devices from the keyboard input', async () => {
    const { c, access } = await setup();
    expect(c.store.getState().devices).toEqual([]);
    access.plug('DDJ-FLX4');
    expect(c.store.getState().devices).toEqual([{ name: 'DDJ-FLX4', hasOutput: true, preset: 'pioneer-ddj-flx4' }]);
    expect(c.store.getState().selected).toBe('DDJ-FLX4');
    access.unplug('DDJ-FLX4');
    expect(c.store.getState().devices).toEqual([]);
  });

  it('says so when the decks are not available (no messages are lost, nothing crashes)', async () => {
    const access = new FakeMidiAccess();
    const { input } = access.plug('DDJ-400');
    const c = new DjControllers({ requestAccess: async () => access.asAccess(), getDecks: async () => null, storage: memoryControllerStorage(), runCommand: () => {} });
    await c.enable();
    expect(c.store.getState().decks).toBe('missing');
    input.emit(msg.noteOn(0, 0x0b));
  });

  it('shows incoming messages and what they did while a view watches', async () => {
    const { c, devices } = await setup({ devices: ['DDJ-400'] });
    const stop = c.watch();
    devices['DDJ-400']!.input.emit(msg.noteOn(0, 0x0b));
    devices['DDJ-400']!.input.emit(msg.noteOn(5, 99));
    await new Promise((r) => setTimeout(r, 80));
    const log = c.monitor.getState().log;
    expect(log.map((l) => l.text)).toEqual(['Ch 1  note 11 on (127)', 'Ch 6  note 99 on (127)']);
    expect(log[0]!.did).toBe('Deck A: Play / pause');
    expect(log[1]!.did).toBe('Not mapped');
    stop();
    expect(c.monitor.getState().log).toEqual([]);
  });
});
