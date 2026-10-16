/**
 * DJ controllers: connects Web MIDI devices to the live decks. Live control is performance, not an
 * edit of the project, so nothing here goes through History.
 *
 * - Devices: every MIDI input is listened to (with its own `midimessage` listener, so the keyboard
 *   input of the app keeps working); a device with a mapping is "claimed" and not played as a keyboard.
 * - Mappings: per device name; a preset chosen by the name, or what the musician learned or imported.
 * - Learn: pick a target, touch the control; its type is detected from the messages.
 * - Output: LEDs follow the decks' state (`LedFeedback`), all of them sent when a device connects.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { MappingInterpreter, type ControlEvent } from '@core/midi-map/interpreter';
import { LearnDetector } from '@core/midi-map/learn';
import { describeMidi, parseMidi, type MidiMessage } from '@core/midi-map/message';
import { presetById, presetForDevice } from '@core/midi-map/presets';
import { SoftTakeover } from '@core/midi-map/soft-takeover';
import { parseTarget, targetInfo, type TargetKind } from '@core/midi-map/targets';
import {
  describeInput,
  emptyMapping,
  inputKey,
  mappingFromJson,
  mappingToJson,
  sanitizeMapping,
  type Binding,
  type ControllerMapping,
  type InputSpec,
} from '@core/midi-map/types';
import type { DecksApi } from '../decks-api';
import { ABS_CONTROLS } from './abs';
import { BrowseCursor, type BrowseSong } from './browse';
import { DjDispatcher } from './dispatch';
import { resolveDecks, type ResolvedDecks } from './decks-source';
import { LedFeedback } from './leds';
import { idbControllerStorage, type ControllerStorage } from './storage';

export type AccessStatus = 'off' | 'asking' | 'ready' | 'denied' | 'unsupported';

export interface ControllerDevice {
  /** The MIDI port's name, which is also the key of its mapping. */
  name: string;
  /** Its MIDI output is open, so LEDs can be driven. */
  hasOutput: boolean;
  /** Id of the preset that matches its name, if any. */
  preset: string | null;
}

export interface LearnState {
  /** The target being learned; null = pick one (in the list or on a deck). */
  target: string | null;
  /** Learning the shifted function of the control. */
  shifted: boolean;
  /** One target (stops after it) or learn mode (keeps going until Done). */
  session: 'single' | 'mode';
  message: string;
}

export interface ControllersState {
  access: AccessStatus;
  devices: ControllerDevice[];
  /** The device name shown in the window. */
  selected: string | null;
  /** The mapping in use per device name (a preset, or the musician's own). */
  mappings: Record<string, ControllerMapping>;
  /** Names whose mapping the musician changed (kept in this browser). */
  customized: Record<string, true>;
  learn: LearnState | null;
  decks: 'none' | 'loading' | 'ready' | 'missing';
  /** The decks are the development stand-in (the real decks are not wired in). */
  fakeDecks: boolean;
}

export interface LogEntry {
  n: number;
  /** performance.now()-style ms. */
  at: number;
  device: string;
  text: string;
  /** What it did ("Deck A: Play / pause"), or why it did nothing. */
  did: string;
}

export interface ControllersOptions {
  requestAccess?: () => Promise<MIDIAccess>;
  /** The live decks (see `decks-source.ts`). */
  getDecks: () => Promise<ResolvedDecks | null>;
  storage?: ControllerStorage;
  runCommand(id: string): void;
  /** The music library for the browse encoder. */
  songs?: () => readonly BrowseSong[];
  toast?(message: string, kind?: 'error'): void;
  /** Called with a predicate for devices the controllers use, so the keyboard input leaves them alone. */
  claim?(isClaimed: ((device: string) => boolean) | null): void;
  now?(): number;
}

const MAX_LOG = 80;

/** Is this message sent by that input (a button's note on or off, a CC)? */
function isInputMessage(input: InputSpec, msg: MidiMessage): boolean {
  if (input.type === 'note') return (msg.kind === 'noteOn' || msg.kind === 'noteOff') && msg.channel === input.channel && msg.note === input.note;
  if (input.type === 'cc') return msg.kind === 'cc' && msg.channel === input.channel && msg.cc === input.cc;
  return false;
}

/** Why a learned control does not fit a target, in plain words (null = it fits). */
export function learnMismatch(kind: TargetKind | 'shift', input: InputSpec, label: string): string | null {
  const is = input.type;
  if (kind === 'button' || kind === 'shift') {
    if (is === 'note' || is === 'cc') return null;
    return `That is a ${is === 'rel' ? 'jog wheel or endless dial' : 'fader or knob'}, but ${label} needs a button. Press a button.`;
  }
  if (kind === 'abs') {
    if (is === 'cc' || is === 'cc14' || is === 'bend') return null;
    return is === 'note' ? `That is a button, but ${label} needs a fader or knob. Move one.` : `That is a jog wheel or endless dial, but ${label} needs a fader or knob. Move one.`;
  }
  if (is === 'rel') return null;
  return is === 'note'
    ? `That is a button, but ${label} needs a jog wheel or endless dial. Turn one.`
    : `That looks like a fader or knob (it has a start and an end), but ${label} needs a jog wheel or endless dial. Turn one slowly both ways.`;
}

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
  private readonly ports = new Map<string, { input: MIDIInput; listener: (e: Event) => void }>();
  private readonly interpreters = new Map<string, MappingInterpreter>();
  private readonly takeovers = new Map<string, SoftTakeover>();
  private readonly leds = new Map<string, LedFeedback>();
  private readonly dispatcher: DjDispatcher;
  private decks: DecksApi | null = null;
  private decksUnsub: (() => void) | null = null;
  private decksLoading: Promise<void> | null = null;
  private detector: LearnDetector | null = null;
  private watchers = 0;
  private logN = 0;
  private logPending: LogEntry[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** Asks for MIDI access (Chrome shows a permission prompt the first time) and starts listening. */
  async enable(): Promise<void> {
    if (this.access) return;
    this.store.setState({ access: 'asking' });
    const request =
      this.opts.requestAccess ??
      (typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? () => navigator.requestMIDIAccess({ sysex: false }) : null);
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
    await this.ensureDecks();
  }

  /** Lets go of the devices (their LEDs go dark). */
  disable(): void {
    if (!this.access) return;
    this.cancelLearn();
    for (const led of this.leds.values()) led.clear();
    this.leds.clear();
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

  private isClaimed(device: string): boolean {
    const m = this.store.getState().mappings[device];
    return !!m && m.bindings.length > 0;
  }

  private async persist(enabled?: boolean): Promise<void> {
    if (enabled !== undefined) this.wantEnabled = enabled;
    const st = this.store.getState();
    const mappings: Record<string, unknown> = {};
    for (const name of Object.keys(st.customized)) if (st.mappings[name]) mappings[name] = st.mappings[name];
    this.saved = mappings;
    await this.storage.save({ enabled: this.wantEnabled, mappings });
  }

  private loadSavedMappings(): void {
    const mappings: Record<string, ControllerMapping> = {};
    const customized: Record<string, true> = {};
    for (const [name, raw] of Object.entries(this.saved)) {
      const r = sanitizeMapping(raw, name);
      if (!r) continue;
      mappings[name] = r.mapping;
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
    this.decksLoading = (async () => {
      let resolved: ResolvedDecks | null = null;
      try {
        resolved = await this.opts.getDecks();
      } catch (e) {
        this.opts.toast?.(`The decks could not start: ${e instanceof Error ? e.message : String(e)}`, 'error');
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
    })();
    return this.decksLoading;
  }

  /** The decks in use (null until they are ready). */
  get liveDecks(): DecksApi | null {
    return this.decks;
  }

  // ---- devices --------------------------------------------------------------------------

  private refreshDevices(): void {
    const access = this.access;
    if (!access) return;
    const seen = new Set<string>();
    const devices: ControllerDevice[] = [];
    const outputs = [...access.outputs.values()];
    for (const input of access.inputs.values()) {
      if (input.state === 'disconnected') continue;
      const name = input.name ?? input.id;
      seen.add(input.id);
      if (!this.ports.has(input.id)) {
        const listener = (e: Event) => {
          const data = (e as MIDIMessageEvent).data;
          if (data) this.handle(input.id, name, data);
        };
        input.addEventListener('midimessage', listener);
        this.ports.set(input.id, { input, listener });
        this.interpreters.set(input.id, new MappingInterpreter(this.mappingFor(name)));
      }
      const out = outputs.find((o) => o.name === input.name && o.state !== 'disconnected');
      if (!this.leds.has(name) && out) {
        const led = new LedFeedback((bytes) => {
          try {
            out.send(bytes);
          } catch {
            // The device went away between messages.
          }
        });
        led.setMapping(this.mappingFor(name));
        this.leds.set(name, led);
      }
      if (!devices.some((d) => d.name === name)) devices.push({ name, hasOutput: !!out, preset: presetForDevice(name)?.id ?? null });
      this.ensureMapping(name);
    }
    for (const [id, p] of this.ports) {
      if (seen.has(id)) continue;
      p.input.removeEventListener('midimessage', p.listener);
      this.ports.delete(id);
      this.interpreters.delete(id);
    }
    for (const name of [...this.leds.keys()]) if (!devices.some((d) => d.name === name)) this.leds.delete(name);
    const selected = this.store.getState().selected;
    this.store.setState({ devices, selected: selected && devices.some((d) => d.name === selected) ? selected : (devices[0]?.name ?? null) });
    this.syncLeds();
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

  // ---- messages -------------------------------------------------------------------------

  /** One MIDI message from a device (called by the port listeners; tests call it directly). */
  handle(inputId: string, deviceName: string, data: ArrayLike<number>): void {
    const msg = parseMidi(data);
    if (!msg) return;
    const learn = this.store.getState().learn;
    if (learn && learn.target !== null && this.detector && deviceName === this.store.getState().selected) {
      this.log(deviceName, data, 'Learning…');
      this.learnMessage(deviceName, msg);
      return;
    }
    let interp = this.interpreters.get(inputId);
    if (!interp) {
      interp = new MappingInterpreter(this.mappingFor(deviceName));
      this.interpreters.set(inputId, interp);
    }
    const events = interp.process(msg);
    if (!this.decks) {
      this.log(deviceName, data, events.length ? 'The decks are not ready yet' : 'Not mapped');
      if (this.store.getState().access === 'ready') void this.ensureDecks();
      return;
    }
    const did: string[] = [];
    for (const ev of events) {
      const what = this.apply(deviceName, ev);
      if (what) did.push(what);
    }
    this.log(deviceName, data, did.length ? did.join(', ') : events.length ? 'Waiting for the knob to meet the screen value' : 'Not mapped');
  }

  /** Applies one event (soft takeover for faders and knobs); returns what it did, or null. */
  private apply(deviceName: string, ev: ControlEvent): string | null {
    const label = targetInfo(ev.target)?.label ?? ev.target;
    if (ev.kind !== 'abs') {
      this.dispatcher.apply(ev);
      if (ev.kind === 'button' && !ev.down) return null;
      return label;
    }
    const mapping = this.mappingFor(deviceName);
    if (mapping.softTakeover && this.decks) {
      const p = parseTarget(ev.target);
      const control = p ? ABS_CONTROLS[p.fn] : undefined;
      if (control && p) {
        const key = `${deviceName}|${ev.layer ?? ''}|${ev.target}`;
        let st = this.takeovers.get(key);
        if (!st) this.takeovers.set(key, (st = new SoftTakeover()));
        const v = st.feed(ev.value, control.read(this.decks.store.getState(), p.deck));
        if (v === null) return null;
        this.dispatcher.abs(ev.target, v);
        return label;
      }
    }
    this.dispatcher.abs(ev.target, ev.value);
    return label;
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
    this.logPending.push({ n: ++this.logN, at: this.opts.now?.() ?? Date.now(), device, text: describeMidi(data), did });
    if (this.logTimer) return;
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      const add = this.logPending;
      this.logPending = [];
      this.monitor.setState((s) => ({ log: [...s.log, ...add].slice(-MAX_LOG) }));
    }, 40);
  }

  clearLog(): void {
    this.logPending = [];
    this.monitor.setState({ log: [] });
  }

  // ---- mappings -------------------------------------------------------------------------

  private applyMapping(name: string): void {
    const m = this.store.getState().mappings[name];
    if (!m) return;
    for (const [id, p] of this.ports) if ((p.input.name ?? id) === name) this.interpreters.get(id)?.setMapping(m);
    for (const k of [...this.takeovers.keys()]) if (k.startsWith(`${name}|`)) this.takeovers.delete(k);
    const led = this.leds.get(name);
    if (led) {
      led.setMapping(m);
      if (this.decks) led.update(this.decks.store.getState());
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
  bindingsFor(name: string, target: string): { index: number; binding: Binding }[] {
    return this.mappingFor(name).bindings.flatMap((binding, index) => (binding.target === target ? [{ index, binding }] : []));
  }

  removeBinding(name: string, index: number): void {
    const m = this.mappingFor(name);
    this.setMapping(name, { ...m, bindings: m.bindings.filter((_, i) => i !== index) });
  }

  clearTarget(name: string, target: string, layer?: string): void {
    const m = this.mappingFor(name);
    this.setMapping(name, { ...m, bindings: m.bindings.filter((b) => !(b.target === target && (layer === undefined || (b.layer ?? '') === layer))) });
  }

  updateBinding(name: string, index: number, patch: Partial<Pick<Binding, 'invert' | 'scale'>>): void {
    const m = this.mappingFor(name);
    const b = m.bindings[index];
    if (!b) return;
    const next: Binding = { ...b, ...patch };
    if (!next.invert) delete next.invert;
    if (next.scale === undefined || next.scale === 1) delete next.scale;
    this.setMapping(name, { ...m, bindings: m.bindings.map((x, i) => (i === index ? next : x)) });
  }

  setOptions(name: string, o: Partial<Pick<ControllerMapping, 'softTakeover' | 'ledFromButtons'>>): void {
    this.setMapping(name, { ...this.mappingFor(name), ...o });
  }

  exportJson(name: string): string {
    return mappingToJson(this.mappingFor(name));
  }

  /** Imports a mapping file for a device; returns how many entries were dropped, or null if it is not a mapping. */
  importJson(name: string, text: string): { dropped: number; bindings: number } | null {
    const r = mappingFromJson(text);
    if (!r) return null;
    this.setMapping(name, { ...r.mapping, name: r.mapping.name || name });
    return { dropped: r.dropped, bindings: r.mapping.bindings.length };
  }

  // ---- learn ----------------------------------------------------------------------------

  /** Starts learn mode: click a control in the list (or on a deck), then move or press it on the controller. */
  startLearn(): void {
    const st = this.store.getState();
    if (st.access !== 'ready') {
      void this.enable().then(() => this.startLearn());
      return;
    }
    if (!st.selected && st.devices.length === 1) this.select(st.devices[0]!.name);
    if (!this.store.getState().selected) {
      this.opts.toast?.('No controller found. Plug one in (and allow MIDI), then try again.', 'error');
      return;
    }
    this.detector = null;
    this.store.setState({ learn: { target: null, shifted: false, session: 'mode', message: 'Click a control in the list (or on a deck) to link it.' } });
  }

  /** Waits for the next touch of a control on the selected controller and links it to `target` ("shift" = the Shift key). */
  learnTarget(target: string, shifted = false): void {
    const st = this.store.getState();
    if (target !== 'shift' && !targetInfo(target)) return;
    if (st.access !== 'ready') {
      void this.enable().then(() => this.learnTarget(target, shifted));
      return;
    }
    if (!st.selected && st.devices.length >= 1) this.select(st.devices[0]!.name);
    const name = this.store.getState().selected;
    if (!name) {
      this.opts.toast?.('No controller found. Plug one in (and allow MIDI), then try again.', 'error');
      return;
    }
    const kind: TargetKind | 'shift' = target === 'shift' ? 'shift' : targetInfo(target)!.kind;
    this.detector = new LearnDetector(kind === 'shift' ? 'button' : kind);
    const session = this.store.getState().learn?.session === 'mode' ? 'mode' : 'single';
    const label = target === 'shift' ? 'the Shift key' : (targetInfo(target)?.label ?? target);
    this.store.setState({
      learn: {
        target,
        shifted: shifted && target !== 'shift',
        session,
        message: `${shifted ? 'Hold Shift if you like, then ' : ''}${kind === 'abs' ? 'move the fader or knob' : kind === 'rel' ? 'turn the jog wheel or dial a few clicks (both ways)' : 'press the button'} for ${label}…`,
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
    if (learn.shifted && this.mappingFor(name).shifts.some((s) => isInputMessage(s.input, msg))) return;
    const outcome = this.detector.feed(msg);
    if (outcome.status === 'progress') {
      if (outcome.message !== learn.message) this.store.setState({ learn: { ...learn, message: outcome.message } });
      return;
    }
    if (outcome.status === 'done') this.learned(name, learn, outcome.input);
  }

  private learned(name: string, learn: LearnState, input: InputSpec): void {
    const target = learn.target!;
    const kind: TargetKind | 'shift' = target === 'shift' ? 'shift' : targetInfo(target)!.kind;
    const label = target === 'shift' ? 'the Shift key' : targetInfo(target)!.label;
    const problem = learnMismatch(kind, input, label);
    if (problem) {
      // Keep waiting: the musician touches the right control.
      this.detector = new LearnDetector(kind === 'shift' ? 'button' : kind);
      this.store.setState({ learn: { ...learn, message: problem } });
      return;
    }
    const m = this.mappingFor(name);
    let next: ControllerMapping;
    let done: string;
    if (target === 'shift') {
      next = { ...m, shifts: [{ id: 'shift', input }] };
      done = `Shift key linked (${describeInput(input)}).`;
    } else {
      if (learn.shifted && !m.shifts.length) {
        this.store.setState({ learn: { ...learn, message: 'Link the Shift key first (the “Shift key” row), then learn the shifted control.' } });
        this.detector = null;
        return;
      }
      const layer = learn.shifted ? m.shifts[0]!.id : undefined;
      const bindings = m.bindings.filter(
        (b) => !(b.target === target && (b.layer ?? '') === (layer ?? '')) && !(inputKey(b.input) === inputKey(input) && (b.layer ?? '') === (layer ?? '')),
      );
      bindings.push({ input, target, ...(layer ? { layer } : {}) });
      next = { ...m, bindings };
      done = `${label}${learn.shifted ? ' (with Shift)' : ''} linked to ${describeInput(input)}.`;
    }
    this.setMapping(name, next);
    this.detector = null;
    this.store.setState({ learn: learn.session === 'mode' ? { ...learn, target: null, shifted: false, message: `${done} Click another control to link it, or press Done.` } : null });
    this.opts.toast?.(done);
  }
}
