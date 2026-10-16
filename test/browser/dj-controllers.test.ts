/**
 * DJ controllers in the real app (headless Chrome, real React tree): a fake `MIDIAccess` with a DDJ-400
 * and an unknown pad is plugged in; messages go through the same listeners Web MIDI uses and the live
 * decks are the recording stand-in. Checks the calls the decks receive, the LED messages the controller
 * gets back, MIDI learn (through the command the Studio uses and the window) and that a controller
 * with a mapping is not played as a keyboard.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { djControllers, setDecksProvider } from '@app/dj/controllers';
import { createServices, type Services } from '@app/services';
import { registerFeatures } from '@ui/features';
import { ControllersWindow } from '@ui/features/dj-controllers/ControllersWindow';
import { ServicesProvider } from '@ui/services-context';
import { FakeDecks } from '../helpers/fake-decks';
import { FakeMidiAccess, msg } from '../helpers/fake-midi';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 8000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('DJ controllers (browser)', () => {
  let s: Services;
  let decks: FakeDecks;
  let access: FakeMidiAccess;
  let ddj: ReturnType<FakeMidiAccess['plug']>;
  let pad: ReturnType<FakeMidiAccess['plug']>;
  let requestMidi: unknown;
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    decks = new FakeDecks();
    setDecksProvider(() => decks);
    access = new FakeMidiAccess();
    ddj = access.plug('DDJ-400');
    pad = access.plug('Some Pad');
    requestMidi = (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access.asAccess() });
    s = createServices();
    registerFeatures(s);
    await s.commands.run('dj.controllers.connect');
    await until(() => djControllers(s).store.getState().decks === 'ready');
  });

  afterAll(async () => {
    root?.unmount();
    host?.remove();
    djControllers(s).disable();
    setDecksProvider(null);
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: requestMidi });
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  it('finds the devices, picks the DDJ-400 map by its name and lights its LEDs', () => {
    const st = djControllers(s).store.getState();
    expect(st.access).toBe('ready');
    expect(st.devices.map((d) => [d.name, d.preset])).toEqual([
      ['DDJ-400', 'pioneer-ddj-400'],
      ['Some Pad', null],
    ]);
    expect(ddj.output!.sent).toContainEqual([0x90, 0x0b, 0]);
  });

  it('messages from the controller reach the decks, and the LEDs answer', () => {
    ddj.output!.clear();
    ddj.input.emit(msg.noteOn(0, 0x0b));
    expect(decks.callsOf('togglePlay')).toEqual([['togglePlay', 'A']]);
    expect(ddj.output!.sent).toEqual([[0x90, 0x0b, 127]]);
    ddj.input.emit(msg.noteOn(9, 3));
    expect(decks.callsOf('hotCue')).toEqual([['hotCue', 'B', 3]]);
    expect(ddj.output!.sent).toContainEqual([0x99, 0x03, 127]);
    // A jog turn nudges; a fader far from the screen value waits to be picked up.
    ddj.input.emit(msg.cc(0, 0x22, 70));
    expect(decks.callsOf('jog')[0]?.slice(0, 2)).toEqual(['jog', 'A']);
    ddj.input.emit(msg.cc(0, 0x13, 10));
    ddj.input.emit(msg.cc(0, 0x33, 0));
    expect(decks.callsOf('setVolume')).toEqual([]);
  });

  it('a controller with a map is not played as a keyboard', () => {
    const noteOn = vi.spyOn(s.live, 'noteOn');
    s.midi.handle('DDJ-400', new Uint8Array(msg.noteOn(0, 0x0b)));
    expect(noteOn).not.toHaveBeenCalled();
    s.midi.handle('Keyboard', new Uint8Array(msg.noteOn(0, 60)));
    expect(noteOn).toHaveBeenCalledTimes(1);
    noteOn.mockRestore();
  });

  it('MIDI learn through the Studio command: the control is detected and mapped', async () => {
    const dj = djControllers(s);
    dj.select('Some Pad');
    await s.commands.run('dj.controllers.learn', { target: 'B.eq.mid' });
    expect(dj.store.getState().learn).toMatchObject({ target: 'B.eq.mid' });
    for (const v of [4, 20, 41, 70, 99]) pad.input.emit(msg.cc(2, 21, v));
    expect(dj.store.getState().learn).toBeNull();
    expect(dj.bindingsFor('Some Pad', 'B.eq.mid')).toEqual([{ index: 0, binding: { input: { type: 'cc', channel: 2, cc: 21 }, target: 'B.eq.mid' } }]);
    // The new control works at once (the knob picks up when it reaches 0 dB).
    pad.input.emit(msg.cc(2, 21, 64));
    expect(decks.callsOf('setEq').some((c) => c[1] === 'B' && c[2] === 'mid')).toBe(true);
    // The map is the musician's own now.
    expect(dj.store.getState().customized['Some Pad']).toBe(true);
  });

  it('the window shows the device, its links and learns from a click', async () => {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:900px;height:700px';
    document.body.append(host);
    djControllers(s).select('DDJ-400');
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(ControllersWindow) }));
    await until(() => !!host!.querySelector('[data-dj-target="A.play"]'));
    await frame();
    expect(host.textContent).toContain('Ch 1 note 11');
    expect(host.textContent).toContain('Ready-made map for Pioneer DDJ-400');
    const dj = djControllers(s);
    // Learn mode: clicking a row picks the control, the next press links it.
    dj.startLearn();
    await frame();
    (host.querySelector('[data-dj-target="A.keylock"]') as HTMLElement).click();
    await frame();
    expect(dj.store.getState().learn?.target).toBe('A.keylock');
    ddj.input.emit(msg.noteOn(2, 99));
    await frame();
    expect(dj.bindingsFor('DDJ-400', 'A.keylock')).toHaveLength(1);
    expect(host.querySelector('[data-dj-target="A.keylock"]')?.textContent).toContain('Ch 3 note 99');
    dj.cancelLearn();
  });
});
