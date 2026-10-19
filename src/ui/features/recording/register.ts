import type { Services } from '@app/services';
import { clearPunch, describePunch, punchFromLoop, recordPunch, setPunchIn, setPunchOut, setPunchRange } from '@app/actions/punch';
import { MASTER, type InsertId, type Tick } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { AudioInputOverlay } from './AudioInputDialog';
import { audioInputDialog, runCalibration } from './audio-input-store';

export const order = 12;

/** A mixer track by number ("3"), name, id, or "master". */
function trackFrom(s: Services, ref: unknown): InsertId | null {
  const mixer = s.doc.getState().project.mixer;
  if (ref === 'master' || ref === 0 || ref === '0' || ref === '') return MASTER;
  const n = typeof ref === 'number' ? ref : typeof ref === 'string' && /^\d+$/.test(ref) ? Number(ref) : NaN;
  if (Number.isInteger(n)) return (mixer.order[n] as InsertId | undefined) ?? null;
  if (typeof ref !== 'string') return null;
  if (mixer.inserts[ref as InsertId]) return ref as InsertId;
  const want = ref.toLowerCase();
  return (Object.values(mixer.inserts).find((i) => i.name.toLowerCase() === want)?.id as InsertId | undefined) ?? null;
}

/**
 * Audio recording settings and tools: Options › Audio input… (device, mono/stereo, level meter,
 * monitoring, latency and its calibration), what record mode records (notes, audio), and a command
 * for each so menus, the action search and the AI reach them.
 */
export function register(services: Services): void {
  const { commands } = services;
  const prefs = (s: Services) => s.prefs.getState();

  commands.register({
    id: 'options.audioInput',
    title: 'Audio input…',
    category: 'Options',
    hint: 'Choose the microphone or audio interface to record from, mono or stereo, see its level, set monitoring and latency',
    // A dialog; the settings action sets channels, track, monitoring and latency (the audio.inputDevice command picks the device).
    ai: false,
    gesture: true,
    run: () => audioInputDialog.setState({ open: true }),
  });
  commands.register<boolean>({
    id: 'transport.recordAudio',
    title: 'Record audio',
    category: 'Transport',
    hint: 'Record mode (R) records your audio input into the playlist where you play it (asks for microphone access once)',
    argsHint: 'optional true or false (default: switch it)',
    gesture: true,
    checked: (s) => prefs(s).recordAudio,
    run: (s, on) => {
      const next = typeof on === 'boolean' ? on : !prefs(s).recordAudio;
      s.prefs.getState().set({ recordAudio: next });
      if (next)
        void s.audioInput.open().then((input) => {
          if (!input) s.session.getState().toast(s.audioInput.store.getState().error ?? 'The audio input could not be opened.', 'error');
          else s.session.getState().setHint(`Record mode will record audio from ${input.label}`);
        });
    },
  });
  commands.register<boolean>({
    id: 'transport.recordNotes',
    title: 'Record notes and knob moves',
    category: 'Transport',
    hint: 'Record mode (R) records the notes you play and the knobs you move',
    argsHint: 'optional true or false (default: switch it)',
    checked: (s) => prefs(s).recordNotes,
    run: (s, on) => s.prefs.getState().set({ recordNotes: typeof on === 'boolean' ? on : !prefs(s).recordNotes }),
  });
  commands.register<boolean>({
    id: 'audio.monitor',
    title: 'Input monitoring',
    category: 'Audio input',
    hint: 'Hear the audio input through its mixer track while you record (use headphones: speakers feed back into the mic)',
    argsHint: 'optional true or false (default: switch it)',
    gesture: true,
    checked: (s) => prefs(s).audioMonitor,
    run: (s, on) => {
      const next = typeof on === 'boolean' ? on : !prefs(s).audioMonitor;
      s.prefs.getState().set({ audioMonitor: next });
      if (next) void s.audioInput.open();
      s.session.getState().setHint(next ? 'Monitoring on: use headphones, speakers would feed back into the mic' : 'Monitoring off');
    },
  });
  commands.register<number | string>({
    id: 'audio.inputTrack',
    title: 'Audio input mixer track',
    category: 'Audio input',
    hint: 'The mixer track the input is monitored through and recorded clips play on',
    argsHint: "a mixer track number (1, 2…), its name, or 'master'",
    run: (s, ref) => {
      const id = trackFrom(s, ref);
      if (!id) {
        s.session.getState().toast('There is no mixer track by that name or number.', 'error');
        return;
      }
      s.prefs.getState().set({ audioInputTrack: id === MASTER ? '' : id });
    },
  });
  commands.register<'mono' | 'stereo'>({
    id: 'audio.inputChannels',
    title: 'Audio input channels',
    category: 'Audio input',
    hint: 'Record one channel (mono, a microphone) or two (stereo)',
    argsHint: "'mono' or 'stereo'",
    run: (s, ch) => s.prefs.getState().set({ audioInputChannels: ch === 'stereo' ? 'stereo' : 'mono' }),
  });
  commands.register<string>({
    id: 'audio.inputDevice',
    title: 'Audio input device',
    category: 'Audio input',
    hint: 'Pick the microphone or audio interface by name (empty: the system default)',
    argsHint: "the device's name (or part of it), or '' for the system default",
    gesture: true,
    run: async (s, name) => {
      const devices = await s.audioInput.refreshDevices();
      const want = String(name ?? '').trim().toLowerCase();
      const dev = want ? devices.find((d) => d.label.toLowerCase().includes(want)) : null;
      if (want && !dev) {
        s.session.getState().toast(`No audio input called “${name}”. Open Options › Audio input… to see them.`, 'error');
        return;
      }
      s.prefs.getState().set({ audioInputDevice: dev?.deviceId ?? '' });
    },
  });
  commands.register({
    id: 'audio.calibrateLatency',
    title: 'Calibrate latency…',
    category: 'Audio input',
    hint: 'Plays clicks and listens through the input to measure the delay, so recordings land on the beat',
    gesture: true,
    run: (s) => {
      audioInputDialog.setState({ open: true });
      void runCalibration(s);
    },
  });
  commands.register<number>({
    id: 'audio.latencyCorrection',
    title: 'Recording latency correction',
    category: 'Audio input',
    hint: 'Milliseconds added to the latency recordings are moved back by (late recordings: more; early: less)',
    argsHint: 'milliseconds, −200 to 200',
    run: (s, ms) => {
      const v = Number(ms);
      if (Number.isFinite(v)) s.prefs.getState().set({ recordLatencyOffsetMs: Math.max(-200, Math.min(200, v)) });
    },
  });

  // ---- Punch range: separate from the loop region ----
  const barTick = (s: Services, bar: unknown): Tick | null =>
    typeof bar === 'number' && Number.isFinite(bar) ? Math.max(0, Math.round((bar - 1) * ticksPerBar(s.doc.getState().project.transport.timeSig))) : null;
  const punchAt = (s: Services, args: { bar?: number } | undefined) => barTick(s, args?.bar) ?? s.view.getState().songStart;
  commands.register<{ bar?: number }>({
    id: 'record.punchIn',
    title: 'Set punch-in',
    category: 'Recording',
    hint: 'Audio recording starts keeping sound here (the song position by default); the red band on the ruler shows the punch range',
    argsHint: '{ bar: 1-based bar (fractions allowed) } (default: the song position)',
    run: (s, args) => {
      setPunchIn(s, punchAt(s, args));
      s.session.getState().setHint(`Punch range: ${describePunch(s) ?? 'none'}`);
    },
  });
  commands.register<{ bar?: number }>({
    id: 'record.punchOut',
    title: 'Set punch-out',
    category: 'Recording',
    hint: 'Audio recording stops keeping sound here (the song position by default); with no loop region the take ends there and the song plays on',
    argsHint: '{ bar: 1-based bar where the punch ends (fractions allowed) } (default: the song position)',
    run: (s, args) => {
      setPunchOut(s, punchAt(s, args));
      s.session.getState().setHint(`Punch range: ${describePunch(s) ?? 'none'}`);
    },
  });
  commands.register<{ from_bar?: number; to_bar?: number }>({
    id: 'record.punchRange',
    title: 'Set the punch range',
    category: 'Recording',
    hint: 'Only this part of an audio recording is kept (bars from–to, inclusive); without arguments the loop region becomes the punch range',
    argsHint: '{ from_bar, to_bar } 1-based inclusive bars (default: the loop region)',
    run: (s, args) => {
      const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
      const a = typeof args?.from_bar === 'number' ? args.from_bar : null;
      const b = typeof args?.to_bar === 'number' ? args.to_bar : a;
      const ok =
        a !== null && b !== null
          ? setPunchRange(s, Math.max(0, Math.round((Math.min(a, b) - 1) * bar)), Math.round(Math.max(a, b) * bar))
          : punchFromLoop(s);
      if (ok) s.session.getState().setHint(`Punch range: ${describePunch(s)}`);
      else s.session.getState().toast('Give the bars to punch (from_bar, to_bar), or set a loop region first.');
    },
  });
  commands.register({
    id: 'record.clearPunch',
    title: 'Clear the punch range',
    category: 'Recording',
    hint: 'Audio recording keeps everything again (or whatever the loop region says)',
    enabled: (s) => !!s.view.getState().punch,
    run: (s) => clearPunch(s),
  });
  commands.register<number>({
    id: 'record.preRoll',
    title: 'Pre-roll bars',
    category: 'Recording',
    hint: 'Bars played before the punch-in when you record the punch range, so you can find the beat (0 starts right at the punch-in)',
    argsHint: 'a number of bars, 0–4',
    run: (s, bars) => {
      const v = Math.max(0, Math.min(4, Math.round(Number(bars))));
      if (Number.isFinite(v)) s.prefs.getState().set({ preRollBars: v });
    },
  });
  commands.register({
    id: 'transport.recordPunch',
    title: 'Record the punch range',
    category: 'Transport',
    hint: 'Plays from the pre-roll before the punch-in (after the count-in) and records audio from the punch-in to the punch-out, then keeps the song playing',
    gesture: true,
    enabled: (s) => !!s.view.getState().punch,
    run: async (s) => {
      if (!(await recordPunch(s)) && !s.view.getState().punch) s.session.getState().toast('Set the punch range first: right-click the ruler or Alt-drag across it.');
    },
  });

  addMenuItems('options', [
    cmd('transport.recordNotes', 74),
    cmd('transport.recordAudio', 75),
    cmd('audio.monitor', 76),
    cmd('options.audioInput', 77),
    cmd('audio.calibrateLatency', 78),
    sep(79),
  ]);
  addMenuItems('playlist', [
    cmd('transport.recordAudio', 40),
    cmd('options.audioInput', 41),
    cmd('record.punchIn', 42),
    cmd('record.punchOut', 43),
    cmd('record.punchRange', 44),
    cmd('record.clearPunch', 45),
    cmd('transport.recordPunch', 46),
    sep(49),
  ]);
  addOverlay('audio-input', AudioInputOverlay);
}
