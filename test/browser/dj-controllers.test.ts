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
import { addSongFiles, library } from '@app/dj/library';
import { createServices, type Services } from '@app/services';
import { encodeWav } from '@core/io/wav';
import { registerFeatures } from '@ui/features';
import { ControllersWindow } from '@ui/features/dj-controllers/ControllersWindow';
import { DecksWindow } from '@ui/features/dj-decks/DecksWindow';
import { ServicesProvider } from '@ui/services-context';
import { FakeDecks } from '../helpers/fake-decks';
import { FakeMidiAccess, msg } from '../helpers/fake-midi';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';
import '@ui/theme/base.css';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const until = async (ok: () => boolean, ms = 30_000) => {
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

describe('MIDI learn on the Decks window (real decks)', () => {
  let s: Services;
  let access: FakeMidiAccess;
  let pad: ReturnType<FakeMidiAccess['plug']>;
  let requestMidi: unknown;
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // No stand-in: `services.decks()` is the real decks, with the real audio graph.
    setDecksProvider(null);
    access = new FakeMidiAccess();
    pad = access.plug('Some Pad');
    requestMidi = (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access.asAccess() });
    s = createServices();
    registerFeatures(s);
    await s.commands.run('dj.controllers.connect');
    await until(() => djControllers(s).store.getState().decks === 'ready');
    // The deck controls are disabled until a song is on the deck: put a one-second tone on deck A.
    const x = new Float32Array(48000);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000);
    const wav = encodeWav([x, x.slice()], 48000, { bitDepth: 16 });
    const file = { name: 'Tone.wav', arrayBuffer: async () => wav.slice().buffer as ArrayBuffer };
    expect(await addSongFiles(s, [file])).toBe(1);
    const song = library.getState().songs.find((item) => item.fileName === 'Tone.wav');
    expect(song).toBeDefined();
    await (await s.decks()).load('A', song!.ref, song!.title);
  });

  afterAll(async () => {
    root?.unmount();
    host?.remove();
    djControllers(s).disable();
    setDecksProvider(null);
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: requestMidi });
    (await s.decks()).dispose();
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  it('a click on deck A’s play picks it; the next press of that note plays and pauses deck A', async () => {
    const dj = djControllers(s);
    const decks = await s.decks();
    dj.select('Some Pad');
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1200px;height:800px';
    document.body.append(host);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(DecksWindow) }));
    const play = () => host!.querySelector('[data-dj-target="A.play"]') as HTMLButtonElement | null;
    await until(() => !!play() && !play()!.disabled);
    await frame();
    expect(decks.store.getState().decks.A.playing).toBe(false);

    // Learn mode: the click picks deck A's play (it does not also play the deck), then the pad's note links it.
    dj.startLearn();
    await frame();
    // A press on CUE in learn mode only picks it: its pointer-down must not start a cue on the deck.
    const cueDown = vi.spyOn(decks, 'cueDown');
    host!.querySelector('[data-dj-target="A.cue"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(cueDown).not.toHaveBeenCalled();
    cueDown.mockRestore();
    play()!.click();
    await frame();
    expect(dj.store.getState().learn?.target).toBe('A.play');
    expect(decks.store.getState().decks.A.playing).toBe(false);
    pad.input.emit(msg.noteOn(4, 40));
    await frame();
    // The link is made; learn mode stays on for the next control, so leave it.
    expect(dj.store.getState().learn?.target).toBeNull();
    dj.cancelLearn();
    expect(dj.store.getState().learn).toBeNull();
    // (The pad's map is kept in the browser, so the new link can come after the earlier test's link: match by content.)
    expect(dj.bindingsFor('Some Pad', 'A.play').map((b) => b.binding)).toEqual([{ input: { type: 'note', channel: 4, note: 40 }, target: 'A.play' }]);

    // The next press of that note toggles deck A on the real decks, and the next one toggles it back.
    pad.input.emit(msg.noteOn(4, 40));
    expect(decks.store.getState().decks.A.playing).toBe(true);
    pad.input.emit(msg.noteOn(4, 40));
    expect(decks.store.getState().decks.A.playing).toBe(false);
  });
});

describe('MIDI learn on an empty deck (real decks, no song loaded)', () => {
  let s: Services;
  let access: FakeMidiAccess;
  let pad: ReturnType<FakeMidiAccess['plug']>;
  let requestMidi: unknown;
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setDecksProvider(null);
    access = new FakeMidiAccess();
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
    (await s.decks()).dispose();
    await s.engine.dispose();
    vi.restoreAllMocks();
  });

  it('a deck with no song can still be linked in learn mode; its controls are disabled again when learn ends', async () => {
    const dj = djControllers(s);
    dj.select('Some Pad');
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:1200px;height:800px';
    document.body.append(host);
    root = createRoot(host);
    root.render(createElement(ServicesProvider, { services: s, children: createElement(DecksWindow) }));
    const play = () => host!.querySelector('[data-dj-target="A.play"]') as HTMLButtonElement | null;
    await until(() => !!play());
    await frame();
    // Deck A is empty, so its play is disabled while learn is off.
    expect(play()!.disabled).toBe(true);
    expect(host.textContent).not.toContain('Click any control to link it');

    // Learn mode on, no song loaded.
    dj.startLearn();
    await frame();
    expect(host.textContent).toContain('Click any control to link it, even on an empty deck');
    // Clicking the empty deck's play picks it: it is pickable now, and looks off (aria-disabled).
    expect(play()!.disabled).toBe(false);
    expect(play()!.getAttribute('aria-disabled')).toBe('true');
    play()!.click();
    await frame();
    expect(dj.store.getState().learn?.target).toBe('A.play');
    // A fake MIDI note links it: an A.play mapping is created.
    pad.input.emit(msg.noteOn(5, 41));
    await frame();
    expect(dj.store.getState().learn?.target).toBeNull();
    expect(dj.bindingsFor('Some Pad', 'A.play').map((b) => b.binding)).toContainEqual({
      input: { type: 'note', channel: 5, note: 41 },
      target: 'A.play',
    });
    // Leave learn mode: the empty deck's play is disabled again, and the hint goes.
    dj.cancelLearn();
    await frame();
    expect(play()!.disabled).toBe(true);
    expect(play()!.hasAttribute('aria-disabled')).toBe(false);
    expect(host.textContent).not.toContain('Click any control to link it');
  });
});
