/**
 * DJ controllers: connects Web MIDI devices to the live decks. Live control is performance, not an
 * edit of the project, so nothing here goes through History.
 *
 * - Devices: every MIDI input is listened to (with its own `midimessage` listener, so the keyboard
 *   input of the app keeps working); a device with a mapping is "claimed" and not played as a keyboard.
 * - Mappings: per device name; a preset chosen by the name, or what the musician learned or imported.
 * - Learn: pick a target, touch the control; its type is detected from the messages (`learn-rules.ts`).
 * - Output: LEDs follow the decks' state (`LedFeedback`), all of them sent when a device connects.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { MappingInterpreter, type ControlEvent } from '@core/midi-map/interpreter';
import { LearnDetector } from '@core/midi-map/learn';
import {
  bindingsOfTarget,
  withBindingPatch,
  withoutBindingAt,
  withoutTarget,
  type IndexedBinding,
} from '@core/midi-map/mapping-edit';
import { describeMidi, parseMidi, type MidiMessage } from '@core/midi-map/message';
import { presetById, presetForDevice } from '@core/midi-map/presets';
import { SoftTakeover } from '@core/midi-map/soft-takeover';
import { parseLaunchTarget, parseTarget, targetInfo } from '@core/midi-map/targets';
import {
  emptyMapping,
  mappingFromJson,
  mappingToJson,
  sanitizeMapping,
  type Binding,
  type ControllerMapping,
  type InputSpec,
} from '@core/midi-map/types';
import { LauncherLeds } from '../../launcher/leds';
import type { DecksApi } from '../decks-api';
import { ABS_CONTROLS } from './abs';
import { BrowseCursor } from './browse';
import { DjDispatcher } from './dispatch';
import type { ResolvedDecks } from './decks-source';
import { detectorKindOf, isInputMessage, learnKindOf, learnLabelOf, learnPrompt, linkLearnedControl } from './learn-rules';
import { LedFeedback } from './leds';
import { idbControllerStorage, type ControllerStorage } from './storage';
import type { ControllerDevice, ControllersOptions, ControllersState, LearnState, LogEntry } from './types';

/** How often pad lights are compared with the launcher's state (it changes at bar lines, with nothing to tell us). */
const PAD_LIGHT_MS = 80;

/** The test view keeps this many of the latest messages. */
const MAX_LOG = 80;

/** Messages are added to the test view in batches this far apart (ms), so a fast jog wheel doesn't redraw it per tick. */
const LOG_BATCH_MS = 40;

/** A MIDI input that is being listened to, with the listener to remove again. */
interface OpenPort {
  input: MIDIInput;
  listener: (e: Event) => void;
}

/** Connects MIDI controllers to the live decks: devices, mappings, MIDI learn, lights and the test view. */
export class DjControllers {
  readonly store: StoreApi<ControllersState> = createStore<ControllersState>(() => ({
    access: 'off',
    devices: [],
    selected: null,
    mappings: {},
    customized: {},
    learn: null,
    decks: 'none',
    fakeDecks: false,
  }));
  /** Incoming messages for the test view (only kept while a view is watching). */
  readonly monitor: StoreApi<{ log: LogEntry[] }> = createStore<{ log: LogEntry[] }>(() => ({ log: [] }));
  readonly browse: BrowseCursor;

  private access: MIDIAccess | null = null;
  private readonly storage: ControllerStorage;
  private readonly ports = new Map<string, OpenPort>();
  private readonly interpreters = new Map<string, MappingInterpreter>();
  private readonly takeovers = new Map<string, SoftTakeover>();
  private readonly leds = new Map<string, LedFeedback>();
  private readonly padLeds = new Map<string, LauncherLeds>();
  private padUnsub: (() => void) | null = null;
  private padTimer: ReturnType<typeof setInterval> | null = null;
  private readonly dispatcher: DjDispatcher;
  private decks: DecksApi | null = null;
  private decksUnsub: (() => void) | null = null;
  private decksLoading: Promise<void> | null = null;
  private detector: LearnDetector | null = null;
  private watchers = 0;
  private logCount = 0;
  private logPending: LogEntry[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  /** The mappings the musician customized, as saved (raw: they are checked when loaded). */
  private saved: Record<string, unknown> = {};
  private wantEnabled = false;

  constructor(private readonly opts: ControllersOptions) {
    this.storage = opts.storage ?? idbControllerStorage;
    this.browse = new BrowseCursor(opts.songs ?? (() => []));
    this.dispatcher = new DjDispatcher({
      // Replaced as soon as decks exist; nothing is dispatched before then.
      decks: undefined as unknown as DecksApi,
      browse: this.browse,
      runCommand: (id) => opts.runCommand(id),
      report: (m) => opts.toast?.(m, 'error'),
    });
  }

  // ---- switching on and off -------------------------------------------------------------

  get enabled(): boolean {
    return this.access !== null;
  }

  /** Loads what was saved (mappings, and whether controllers were on); call once at start. Returns whether they were on. */
  async restore(): Promise<boolean> {
    const data = await this.storage.load();
    this.saved = data.mappings;
    this.loadSavedMappings();
    this.wantEnabled = data.enabled;
    return data.enabled;
  }

  /** The browser's way to ask for MIDI access, or null where there is none. */
  private midiRequester(): (() => Promise<MIDIAccess>) | null {
    if (this.opts.requestAccess) return this.opts.requestAccess;
    const hasWebMidi = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
    return hasWebMidi ? () => navigator.requestMIDIAccess({ sysex: false }) : null;
  }

  /** Asks for MIDI access (Chrome shows a permission prompt the first time) and starts listening. */
  async enable(): Promise<void> {
    if (this.access) return;
    this.store.setState({ access: 'asking' });
    const request = this.midiRequester();
    if (!request) {
      this.store.setState({ access: 'unsupported' });
      return;
    }
    let access: MIDIAccess;
    try {
      access = await request();
    } catch {
      this.store.setState({ access: 'denied' });
      this.opts.toast?.('MIDI access was not allowed. Allow it for this site (the lock icon in the address bar) to use a controller.', 'error');
      return;
    }
    this.access = access;
    access.onstatechange = () => this.refreshDevices();
    this.opts.claim?.((device) => this.isClaimed(device));
    this.store.setState({ access: 'ready' });
    this.refreshDevices();
    void this.persist(true);
    this.watchLauncher();
    await this.ensureDecks();
  }

  /** Lets go of the devices (their LEDs go dark). */
  disable(): void {
    if (!this.access) return;
    this.cancelLearn();
    for (const led of this.leds.values()) led.clear();
    this.leds.clear();
    for (const led of this.padLeds.values()) led.clear();
    this.padLeds.clear();
    this.padUnsub?.();
    this.padUnsub = null;
    if (this.padTimer) clearInterval(this.padTimer);
    this.padTimer = null;
    for (const { input, listener } of this.ports.values()) input.removeEventListener('midimessage', listener);
    this.ports.clear();
    this.interpreters.clear();
    this.takeovers.clear();
    this.access.onstatechange = null;
    this.access = null;
    this.decksUnsub?.();
    this.decksUnsub = null;
    this.opts.claim?.(null);
    this.store.setState({ access: 'off', devices: [] });
    void this.persist(false);
  }

  /** A device with at least one binding is the controllers' (the keyboard input leaves it alone). */
  private isClaimed(device: string): boolean {
    const mapping = this.store.getState().mappings[device];
    return !!mapping && mapping.bindings.length > 0;
  }

  /** Saves whether the controllers are on and the musician's own mappings. */
  private async persist(enabled?: boolean): Promise<void> {
    if (enabled !== undefined) this.wantEnabled = enabled;
    const state = this.store.getState();
    const mappings: Record<string, unknown> = {};
    for (const name of Object.keys(state.customized)) if (state.mappings[name]) mappings[name] = state.mappings[name];
    this.saved = mappings;
    await this.storage.save({ enabled: this.wantEnabled, mappings });
  }

  private loadSavedMappings(): void {
    const mappings: Record<string, ControllerMapping> = {};
    const customized: Record<string, true> = {};
    for (const [name, raw] of Object.entries(this.saved)) {
      const checked = sanitizeMapping(raw, name);
      if (!checked) continue;
      mappings[name] = checked.mapping;
      customized[name] = true;
    }
    this.store.setState((s) => ({ mappings: { ...s.mappings, ...mappings }, customized: { ...s.customized, ...customized } }));
  }

  // ---- decks ----------------------------------------------------------------------------

  /** Gets the live decks (once) and starts mirroring their state on the LEDs. */
  ensureDecks(): Promise<void> {
    if (this.decks) return Promise.resolve();
    if (this.decksLoading) return this.decksLoading;
    this.store.setState({ decks: 'loading' });
    this.decksLoading = this.loadDecks();
    return this.decksLoading;
  }

  private async loadDecks(): Promise<void> {
    let resolved: ResolvedDecks | null = null;
    try {
      resolved = await this.opts.getDecks();
    } catch (error) {
      this.opts.toast?.(`The decks could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    this.decksLoading = null;
    if (!resolved) {
      this.store.setState({ decks: 'missing' });
      return;
    }
    this.decks = resolved.decks;
    this.dispatcher.setEnv({
      decks: resolved.decks,
      browse: this.browse,
      runCommand: (id) => this.opts.runCommand(id),
      report: (m) => this.opts.toast?.(m, 'error'),
    });
    this.decksUnsub?.();
    this.decksUnsub = resolved.decks.store.subscribe((state) => {
      for (const led of this.leds.values()) led.update(state);
    });
    this.store.setState({ decks: 'ready', fakeDecks: resolved.fake });
    this.syncLeds();
  }

  /** The decks in use (null until they are ready). */
  get liveDecks(): DecksApi | null {
    return this.decks;
  }

  // ---- devices --------------------------------------------------------------------------

  /** Brings the listeners, lights and device list up to date with the MIDI ports that exist now. */
  private refreshDevices(): void {
    const access = this.access;
    if (!access) return;
    const seenInputIds = new Set<string>();
    const devices: ControllerDevice[] = [];
    const outputs = [...access.outputs.values()];
    for (const input of access.inputs.values()) {
      if (input.state === 'disconnected') continue;
      const name = input.name ?? input.id;
      seenInputIds.add(input.id);
      this.listenTo(input, name);
      const output = outputs.find((o) => o.name === input.name && o.state !== 'disconnected');
      if (!this.leds.has(name) && output) this.openLeds(name, output);
      if (!devices.some((d) => d.name === name)) {
        devices.push({ name, hasOutput: !!output, preset: presetForDevice(name)?.id ?? null });
      }
      this.ensureMapping(name);
    }
    this.dropGonePorts(seenInputIds, devices);
    const selected = this.store.getState().selected;
    const stillThere = selected !== null && devices.some((d) => d.name === selected);
    this.store.setState({ devices, selected: stillThere ? selected : (devices[0]?.name ?? null) });
    this.syncLeds();
  }

  /** Starts listening to a MIDI input (once) with a listener of its own, so the keyboard input of the app keeps working. */
  private listenTo(input: MIDIInput, name: string): void {
    if (this.ports.has(input.id)) return;
    const listener = (e: Event) => {
      const data = (e as MIDIMessageEvent).data;
      if (data) this.handle(input.id, name, data);
    };
    input.addEventListener('midimessage', listener);
    // Unlike `onmidimessage`, listening with addEventListener does not open the port by itself.
    void Promise.resolve(input.open?.()).catch(() => {});
    this.ports.set(input.id, { input, listener });
    this.interpreters.set(input.id, new MappingInterpreter(this.mappingFor(name)));
  }

  /** Opens a device's output and makes its deck lights and its launcher pad lights. */
  private openLeds(name: string, output: MIDIOutput): void {
    void Promise.resolve(output.open?.()).catch(() => {});
    const send = (bytes: number[]) => {
      try {
        output.send(bytes);
      } catch {
        // The device went away between messages.
      }
    };
    const mapping = this.mappingFor(name);
    const led = new LedFeedback(send);
    led.setMapping(mapping);
    this.leds.set(name, led);
    const pads = new LauncherLeds(send);
    pads.setMapping(mapping);
    this.padLeds.set(name, pads);
  }

  /** Stops listening to inputs that are gone, and forgets the lights of devices that are gone. */
  private dropGonePorts(seenInputIds: Set<string>, devices: ControllerDevice[]): void {
    for (const [id, port] of this.ports) {
      if (seenInputIds.has(id)) continue;
      port.input.removeEventListener('midimessage', port.listener);
      this.ports.delete(id);
      this.interpreters.delete(id);
    }
    const isPresent = (name: string) => devices.some((d) => d.name === name);
    for (const name of [...this.leds.keys()]) if (!isPresent(name)) this.leds.delete(name);
    for (const name of [...this.padLeds.keys()]) if (!isPresent(name)) this.padLeds.delete(name);
  }

  /** The preset for a device with no mapping yet (kept out of storage until it is changed). */
  private ensureMapping(name: string): void {
    if (this.store.getState().mappings[name]) return;
    const preset = presetForDevice(name);
    const mapping = preset ? preset.mapping() : emptyMapping(name);
    this.store.setState((s) => ({ mappings: { ...s.mappings, [name]: mapping } }));
    this.applyMapping(name);
  }

  mappingFor(name: string): ControllerMapping {
    return this.store.getState().mappings[name] ?? presetForDevice(name)?.mapping() ?? emptyMapping(name);
  }

  /** Sends every LED of every device again (a device connected, the decks came up). */
  syncLeds(): void {
    // A pad light that was just made has sent nothing yet; the others only send what changed.
    this.updatePadLeds();
    if (!this.decks) return;
    const state = this.decks.store.getState();
    for (const led of this.leds.values()) {
      led.reset();
      led.update(state);
    }
  }

  select(name: string | null): void {
    this.store.setState({ selected: name });
  }

  // ---- the clip launcher's pads ---------------------------------------------------------

  /** Pad lights follow the launcher: at once when something is pressed, and now and then for what the clock decides. */
  private watchLauncher(): void {
    const launcher = this.opts.launcher?.();
    if (!launcher || this.padUnsub) return;
    this.padUnsub = launcher.subscribe(() => this.updatePadLeds());
    this.padTimer = setInterval(() => this.updatePadLeds(), PAD_LIGHT_MS);
  }

  private updatePadLeds(): void {
    const launcher = this.opts.launcher?.();
    if (!launcher) return;
    for (const led of this.padLeds.values()) if (led.active) led.update(launcher);
  }

  /** A pad, a scene button or a stop button of the launcher was pressed or let go; returns what it did, or null. */
  private applyLaunch(ev: ControlEvent): string | null {
    const target = parseLaunchTarget(ev.target);
    const launcher = this.opts.launcher?.();
    if (!target || ev.kind !== 'button' || !launcher) return null;
    switch (target.kind) {
      case 'slot':
        launcher.padPress(target.track - 1, target.scene - 1, ev.down);
        break;
      case 'scene':
        if (ev.down) launcher.padScene(target.scene - 1);
        break;
      case 'stop':
        if (ev.down) launcher.padStop(target.track - 1);
        break;
      case 'stopAll':
        if (ev.down) launcher.stopAll();
        break;
      case 'page':
        if (ev.down) launcher.movePage(target.dir);
        break;
    }
    this.updatePadLeds();
    return ev.down ? (targetInfo(ev.target)?.label ?? ev.target) : null;
  }

  // ---- messages -------------------------------------------------------------------------

  /** One MIDI message from a device (called by the port listeners; tests call it directly). */
  handle(inputId: string, deviceName: string, data: ArrayLike<number>): void {
    const msg = parseMidi(data);
    if (!msg) return;
    if (this.isLearningFrom(deviceName)) {
      this.log(deviceName, data, 'Learning…');
      this.learnMessage(deviceName, msg);
      return;
    }
    const allEvents = this.interpreterFor(inputId, deviceName).process(msg);
    // The clip launcher's pads do not need the decks.
    const did: string[] = [];
    const deckEvents: ControlEvent[] = [];
    for (const ev of allEvents) {
      if (!parseLaunchTarget(ev.target)) {
        deckEvents.push(ev);
        continue;
      }
      const what = this.applyLaunch(ev);
      if (what) did.push(what);
    }
    if (!this.decks && (deckEvents.length > 0 || allEvents.length === 0)) {
      this.log(deviceName, data, deckEvents.length > 0 ? 'The decks are not ready yet' : 'Not mapped');
      if (this.store.getState().access === 'ready') void this.ensureDecks();
      return;
    }
    for (const ev of deckEvents) {
      const what = this.apply(deviceName, ev);
      if (what) did.push(what);
    }
    this.log(deviceName, data, this.describeOutcome(did, allEvents.length, deckEvents.length));
  }

  /** Learning is waiting for a touch, and it is the selected device that spoke. */
  private isLearningFrom(deviceName: string): boolean {
    const state = this.store.getState();
    return !!state.learn && state.learn.target !== null && this.detector !== null && deviceName === state.selected;
  }

  private interpreterFor(inputId: string, deviceName: string): MappingInterpreter {
    let interpreter = this.interpreters.get(inputId);
    if (!interpreter) {
      interpreter = new MappingInterpreter(this.mappingFor(deviceName));
      this.interpreters.set(inputId, interpreter);
    }
    return interpreter;
  }

  /** The test view's explanation of what a message did (or why nothing happened). */
  private describeOutcome(did: string[], eventCount: number, deckEventCount: number): string {
    if (did.length > 0) return did.join(', ');
    if (eventCount === 0) return 'Not mapped';
    return deckEventCount > 0 ? 'Waiting for the knob to meet the screen value' : 'Released';
  }

  /** Applies one event (soft takeover for faders and knobs); returns what it did, or null. */
  private apply(deviceName: string, ev: ControlEvent): string | null {
    const label = targetInfo(ev.target)?.label ?? ev.target;
    if (ev.kind !== 'abs') {
      this.dispatcher.apply(ev);
      if (ev.kind === 'button' && !ev.down) return null;
      return label;
    }
    const value = this.valueAfterTakeover(deviceName, ev);
    if (value === null) return null;
    this.dispatcher.abs(ev.target, value);
    return label;
  }

  /**
   * The value to send for a fader or knob. With soft takeover on, a control that is not where the screen is yet sends
   * nothing (null) until it meets it, so a deck never jumps; otherwise the raw value.
   */
  private valueAfterTakeover(deviceName: string, ev: Extract<ControlEvent, { kind: 'abs' }>): number | null {
    if (!this.mappingFor(deviceName).softTakeover || !this.decks) return ev.value;
    const parsed = parseTarget(ev.target);
    const control = parsed ? ABS_CONTROLS[parsed.fn] : undefined;
    if (!control || !parsed) return ev.value;
    const key = `${deviceName}|${ev.layer ?? ''}|${ev.target}`;
    let takeover = this.takeovers.get(key);
    if (!takeover) this.takeovers.set(key, (takeover = new SoftTakeover()));
    return takeover.feed(ev.value, control.read(this.decks.store.getState(), parsed.deck));
  }

  // ---- the test view --------------------------------------------------------------------

  /** A view that shows incoming messages calls this while it is open; returns the stop function. */
  watch(): () => void {
    this.watchers++;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.watchers--;
      if (!this.watchers) this.monitor.setState({ log: [] });
    };
  }

  private log(device: string, data: ArrayLike<number>, did: string): void {
    if (!this.watchers) return;
    this.logPending.push({ n: ++this.logCount, at: this.opts.now?.() ?? Date.now(), device, text: describeMidi(data), did });
    if (this.logTimer) return;
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      const added = this.logPending;
      this.logPending = [];
      this.monitor.setState((s) => ({ log: [...s.log, ...added].slice(-MAX_LOG) }));
    }, LOG_BATCH_MS);
  }

  clearLog(): void {
    this.logPending = [];
    this.monitor.setState({ log: [] });
  }

  // ---- mappings -------------------------------------------------------------------------

  /** Tells the device's interpreters and lights about its (new) mapping. */
  private applyMapping(name: string): void {
    const mapping = this.store.getState().mappings[name];
    if (!mapping) return;
    for (const [id, port] of this.ports) if ((port.input.name ?? id) === name) this.interpreters.get(id)?.setMapping(mapping);
    for (const key of [...this.takeovers.keys()]) if (key.startsWith(`${name}|`)) this.takeovers.delete(key);
    const led = this.leds.get(name);
    if (led) {
      led.setMapping(mapping);
      if (this.decks) led.update(this.decks.store.getState());
    }
    const pads = this.padLeds.get(name);
    if (pads) {
      pads.setMapping(mapping);
      this.updatePadLeds();
    }
  }

  /** Replaces a device's mapping (the musician's own from now on). */
  setMapping(name: string, mapping: ControllerMapping): void {
    this.store.setState((s) => ({ mappings: { ...s.mappings, [name]: mapping }, customized: { ...s.customized, [name]: true } }));
    this.applyMapping(name);
    void this.persist();
  }

  usePreset(name: string, presetId: string): boolean {
    const preset = presetById(presetId);
    if (!preset) return false;
    this.setMapping(name, preset.mapping());
    return true;
  }

  /** Back to the preset for this device (or an empty mapping when there is none). */
  resetMapping(name: string): void {
    const preset = presetForDevice(name);
    this.store.setState((s) => {
      const customized = { ...s.customized };
      delete customized[name];
      return { mappings: { ...s.mappings, [name]: preset ? preset.mapping() : emptyMapping(name) }, customized };
    });
    this.applyMapping(name);
    void this.persist();
  }

  /** Removes every control link of this device (a blank mapping to learn from scratch). */
  clearMapping(name: string): void {
    this.setMapping(name, emptyMapping(name));
  }

  /** The bindings of a target (any layer), with their position in the mapping. */
  bindingsFor(name: string, target: string): IndexedBinding[] {
    return bindingsOfTarget(this.mappingFor(name), target);
  }

  removeBinding(name: string, index: number): void {
    this.setMapping(name, withoutBindingAt(this.mappingFor(name), index));
  }

  clearTarget(name: string, target: string, layer?: string): void {
    this.setMapping(name, withoutTarget(this.mappingFor(name), target, layer));
  }

  updateBinding(name: string, index: number, patch: Partial<Pick<Binding, 'invert' | 'scale'>>): void {
    const mapping = this.mappingFor(name);
    if (!mapping.bindings[index]) return;
    this.setMapping(name, withBindingPatch(mapping, index, patch));
  }

  setOptions(name: string, options: Partial<Pick<ControllerMapping, 'softTakeover' | 'ledFromButtons'>>): void {
    this.setMapping(name, { ...this.mappingFor(name), ...options });
  }

  exportJson(name: string): string {
    return mappingToJson(this.mappingFor(name));
  }

  /** Imports a mapping file for a device; returns how many entries were dropped, or null if it is not a mapping. */
  importJson(name: string, text: string): { dropped: number; bindings: number } | null {
    const result = mappingFromJson(text);
    if (!result) return null;
    this.setMapping(name, { ...result.mapping, name: result.mapping.name || name });
    return { dropped: result.dropped, bindings: result.mapping.bindings.length };
  }

  // ---- learn ----------------------------------------------------------------------------

  /** Starts learn mode: click a control in the list (or on a deck), then move or press it on the controller. */
  startLearn(): void {
    const state = this.store.getState();
    if (state.access !== 'ready') {
      void this.enable().then(() => this.startLearn());
      return;
    }
    if (!state.selected && state.devices.length === 1) this.select(state.devices[0]!.name);
    if (!this.store.getState().selected) {
      this.opts.toast?.('No controller found. Plug one in (and allow MIDI), then try again.', 'error');
      return;
    }
    this.detector = null;
    this.store.setState({ learn: { target: null, shifted: false, session: 'mode', message: 'Click a control in the list (or on a deck) to link it.' } });
  }

  /** Waits for the next touch of a control on the selected controller and links it to `target` ("shift" = the Shift key). */
  learnTarget(target: string, shifted = false): void {
    const state = this.store.getState();
    if (target !== 'shift' && !targetInfo(target)) return;
    if (state.access !== 'ready') {
      void this.enable().then(() => this.learnTarget(target, shifted));
      return;
    }
    if (!state.selected && state.devices.length >= 1) this.select(state.devices[0]!.name);
    if (!this.store.getState().selected) {
      this.opts.toast?.('No controller found. Plug one in (and allow MIDI), then try again.', 'error');
      return;
    }
    const kind = learnKindOf(target);
    this.detector = new LearnDetector(detectorKindOf(kind));
    const session = this.store.getState().learn?.session === 'mode' ? 'mode' : 'single';
    this.store.setState({
      learn: {
        target,
        shifted: shifted && target !== 'shift',
        session,
        message: learnPrompt(kind, learnLabelOf(target), shifted),
      },
    });
  }

  cancelLearn(): void {
    this.detector = null;
    if (this.store.getState().learn) this.store.setState({ learn: null });
  }

  /** Uses what was seen so far even if the type is not certain (the "That's enough" button). */
  finishLearn(): void {
    const learn = this.store.getState().learn;
    const name = this.store.getState().selected;
    if (!learn?.target || !this.detector || !name) return;
    const input = this.detector.guess();
    if (input) this.learned(name, learn, input);
  }

  private learnMessage(name: string, msg: MidiMessage): void {
    const learn = this.store.getState().learn;
    if (!learn?.target || !this.detector) return;
    // Learning a shifted function: the Shift key itself (held down) is not the control.
    if (learn.shifted && this.mappingFor(name).shifts.some((shift) => isInputMessage(shift.input, msg))) return;
    const outcome = this.detector.feed(msg);
    if (outcome.status === 'progress') {
      if (outcome.message !== learn.message) this.store.setState({ learn: { ...learn, message: outcome.message } });
      return;
    }
    if (outcome.status === 'done') this.learned(name, learn, outcome.input);
  }

  /** A control was recognised: link it, or say why it doesn't fit and keep waiting. */
  private learned(name: string, learn: LearnState, input: InputSpec): void {
    const target = learn.target!;
    const result = linkLearnedControl(this.mappingFor(name), target, learn.shifted, input);
    if (result.status === 'retry') {
      // Keep waiting: the musician touches the right control.
      this.detector = new LearnDetector(detectorKindOf(learnKindOf(target)));
      this.store.setState({ learn: { ...learn, message: result.message } });
      return;
    }
    if (result.status === 'needsShift') {
      this.store.setState({ learn: { ...learn, message: result.message } });
      this.detector = null;
      return;
    }
    this.setMapping(name, result.mapping);
    this.detector = null;
    const next = learn.session === 'mode' ? { ...learn, target: null, shifted: false, message: `${result.done} Click another control to link it, or press Done.` } : null;
    this.store.setState({ learn: next });
    this.opts.toast?.(result.done);
  }
}
