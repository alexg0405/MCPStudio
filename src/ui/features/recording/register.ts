import type { Services } from '@app/services';
import { MASTER, type InsertId } from '@core/model/types';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { AudioInputOverlay, audioInputDialog, runCalibration } from './AudioInputDialog';

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

  addMenuItems('options', [
    cmd('transport.recordNotes', 74),
    cmd('transport.recordAudio', 75),
    cmd('audio.monitor', 76),
    cmd('options.audioInput', 77),
    cmd('audio.calibrateLatency', 78),
    sep(79),
  ]);
  addMenuItems('playlist', [cmd('transport.recordAudio', 40), cmd('options.audioInput', 41), sep(49)]);
  addOverlay('audio-input', AudioInputOverlay);
}
