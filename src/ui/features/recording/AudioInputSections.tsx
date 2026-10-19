/** The parts of the audio input dialog: the device, what record mode keeps, monitoring, punch and takes, and latency. */
import { measurementOk } from '@app/audio-input';
import type { PrefsState } from '@app/stores/prefs';
import type { Services } from '@app/services';
import type { Mixer } from '@core/model/types';
import { MASTER } from '@core/model/types';
import dialog from '../../controls/Dialog.module.css';
import { LevelMeter } from './LevelMeter';
import styles from './Recording.module.css';
import { runCalibration, type Calibration } from './audio-input-store';

type SetPrefs = (patch: Partial<PrefsState>) => void;
type InputState = ReturnType<Services['audioInput']['store']['getState']>;

/** The longest pre-roll offered, in bars. */
const MAX_PRE_ROLL_BARS = 4;
/** The longest comp crossfade offered, in milliseconds. */
const MAX_COMP_CROSSFADE_MS = 500;
/** The most the latency correction can move a recording either way, in milliseconds. */
const MAX_LATENCY_CORRECTION_MS = 200;

interface InlineNumberProps {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Round what is typed to a whole number before checking it. */
  isWhole?: boolean;
  /** Called with a typed value only when it is a number inside `min` to `max`. */
  onCommit(value: number): void;
}

/** A small number box with its unit after it; a typed value outside the range is ignored (the box keeps the last good one). */
function InlineNumber({ value, min, max, step, unit, isWhole, onCommit }: InlineNumberProps) {
  return (
    <span className={styles.inline}>
      <input
        type="number"
        className={styles.number}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const typed = isWhole ? Math.round(Number(e.target.value)) : Number(e.target.value);
          if (Number.isFinite(typed) && typed >= min && typed <= max) onCommit(typed);
        }}
      />
      {unit}
    </span>
  );
}

/** What the status line under the meter says about the input. */
function inputStatusText(input: InputState): string {
  if (input.status === 'on') return `Listening to ${input.label}.`;
  if (input.status === 'opening') return 'Opening the input… (the browser may ask for permission)';
  if (input.status === 'error') return input.error ?? '';
  return 'The input is closed: it opens when you record, or press “Allow microphone access”.';
}

/** The input device and channels, the permission button, the level meter and what the input is doing. */
export function InputDeviceSection({ services, prefs, input, set }: { services: Services; prefs: PrefsState; input: InputState; set: SetPrefs }) {
  const devices = input.devices.filter((d) => d.deviceId !== 'default' && d.deviceId !== '');
  const needsPermission = input.status !== 'on' || devices.some((d) => !d.label);
  const openAndListDevices = () => void services.audioInput.open().then(() => services.audioInput.refreshDevices());
  return (
    <>
      <div className={styles.row}>
        <label className={styles.field} data-hint="The microphone or audio interface to record from">
          Input
          <select value={prefs.audioInputDevice} onChange={(e) => set({ audioInputDevice: e.target.value })}>
            <option value="">System default{input.status === 'on' && !prefs.audioInputDevice ? ` (${input.label})` : ''}</option>
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="Mono records one channel (a mic); stereo records two (a stereo pair, a synth's outputs)">
          Channels
          <select value={prefs.audioInputChannels} onChange={(e) => set({ audioInputChannels: e.target.value === 'stereo' ? 'stereo' : 'mono' })}>
            <option value="mono">Mono (1)</option>
            <option value="stereo">Stereo (2)</option>
          </select>
        </label>
      </div>
      {needsPermission && (
        <button className={`${dialog.button} ${styles.allow}`} onClick={openAndListDevices} data-hint="The browser asks once whether AGstudio may use your microphone">
          {input.status === 'opening' ? 'Opening…' : 'Allow microphone access'}
        </button>
      )}
      <LevelMeter />
      <p className={input.status === 'error' ? styles.error : styles.status}>{inputStatusText(input)}</p>
    </>
  );
}

/** The two switches for what record mode keeps: the audio, and the notes and knob moves. */
export function RecordWhatSection({ prefs, set }: { prefs: PrefsState; set: SetPrefs }) {
  return (
    <>
      <label className={styles.check} data-hint="Record mode (R) then records your input into the playlist when you press Play">
        <input type="checkbox" checked={prefs.recordAudio} onChange={(e) => set({ recordAudio: e.target.checked })} />
        <span>Record audio when recording</span>
      </label>
      <label className={styles.check} data-hint="Record mode also records the notes you play and the knobs you move">
        <input type="checkbox" checked={prefs.recordNotes} onChange={(e) => set({ recordNotes: e.target.checked })} />
        <span>Record notes and knob moves too</span>
      </label>
    </>
  );
}

/** The mixer tracks to choose from, as "Master", "1 · Drums"…; the master's value is the empty string. */
function mixerTrackChoices(mixer: Mixer): { id: string; label: string }[] {
  return mixer.order.map((id, i) => ({
    id: id === MASTER ? '' : id,
    label: i === 0 ? 'Master' : `${i} · ${mixer.inserts[id]?.name ?? `Insert ${i}`}`,
  }));
}

/** Monitoring (hearing the input) and the mixer track it goes through. */
export function MonitoringSection({ prefs, mixer, set }: { prefs: PrefsState; mixer: Mixer; set: SetPrefs }) {
  const chosenTrack = prefs.audioInputTrack && mixer.inserts[prefs.audioInputTrack as never] ? prefs.audioInputTrack : '';
  return (
    <>
      <div className={styles.row}>
        <label className={styles.check} data-hint="Hear what you record, through the chosen mixer track (with its effects)">
          <input type="checkbox" checked={prefs.audioMonitor} onChange={(e) => set({ audioMonitor: e.target.checked })} />
          <span>Hear the input (monitoring)</span>
        </label>
        <label className={styles.field} data-hint="The mixer track you hear the input through, and that recorded clips play on">
          Mixer track
          <select value={chosenTrack} onChange={(e) => set({ audioInputTrack: e.target.value })}>
            {mixerTrackChoices(mixer).map((t) => (
              <option key={t.id || 'master'} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.note}>
        Monitoring is off by default: through speakers the microphone hears itself and howls (feedback). Use headphones when you turn it on.
      </p>
    </>
  );
}

/** Pre-roll before a punch-in, and the crossfade between comp takes. */
export function PunchSection({ prefs, set }: { prefs: PrefsState; set: SetPrefs }) {
  return (
    <fieldset className={styles.group}>
      <legend>Punch and takes</legend>
      <p className={styles.note}>
        Set a punch range on the ruler (right-click it, or Alt-drag) and Record the punch range plays in from a few bars before it and keeps only that part. Loop
        passes become takes you can comp in the playlist.
      </p>
      <div className={styles.row}>
        <label className={styles.field} data-hint="Bars played before the punch-in so you can find the beat (0 starts right at it)">
          Pre-roll
          <InlineNumber value={prefs.preRollBars} min={0} max={MAX_PRE_ROLL_BARS} step={1} unit="bars" isWhole onCommit={(preRollBars) => set({ preRollBars })} />
        </label>
        <label className={styles.field} data-hint="How long two takes fade across each other where a new comp changes take (0–500 ms; each comp can change it afterwards)">
          Comp crossfade
          <InlineNumber value={prefs.compCrossfadeMs} min={0} max={MAX_COMP_CROSSFADE_MS} step={1} unit="ms" onCommit={(compCrossfadeMs) => set({ compCrossfadeMs })} />
        </label>
      </div>
    </fieldset>
  );
}

/** What to tell the musician when a latency measurement was not clear enough to use. */
function unclearMeasurementText(found: number, played: number, spreadMs: number): string {
  if (found === 0) {
    return 'No clicks came back: turn the speakers up and hold the mic near them (or connect the output to the input with a cable), then try again.';
  }
  const variedNote = Number.isFinite(spreadMs) ? ` (they varied by ${spreadMs} ms)` : '';
  return `Only ${found} of ${played} clicks came back clearly${variedNote}: try again somewhere quieter, or type a correction instead.`;
}

interface LatencySectionProps {
  services: Services;
  prefs: PrefsState;
  calibration: Calibration;
  onForgetCalibration(): void;
  set: SetPrefs;
}

/** Latency: what is applied now, a calibration with clicks, and a manual correction. */
export function LatencySection({ services, prefs, calibration, onForgetCalibration, set }: LatencySectionProps) {
  return (
    <fieldset className={styles.group}>
      <legend>Latency</legend>
      <p className={styles.note}>
        Recordings are moved back by the time sound takes to go out and come back in, so they land on the beat. Now: <b>{services.audioInput.describeLatency()}</b>.
      </p>
      <div className={styles.row}>
        <button
          className={dialog.button}
          disabled={calibration.state === 'running'}
          onClick={() => void runCalibration(services)}
          data-hint="Plays 8 clicks and listens through the input to measure the delay (turn the speakers up a little, or connect the output to the input with a cable)"
        >
          {calibration.state === 'running' ? 'Listening…' : 'Calibrate latency…'}
        </button>
        {prefs.recordLatencyMs >= 0 && (
          <button className={dialog.button} onClick={() => services.audioInput.setMeasuredLatency(-1)} data-hint="Forget the measurement and use what the browser reports">
            Use the browser’s estimate
          </button>
        )}
        <label className={styles.field} data-hint="Added to the latency, in ms: if recordings land late, increase it; if early, decrease it">
          Correction
          <InlineNumber
            value={prefs.recordLatencyOffsetMs}
            min={-MAX_LATENCY_CORRECTION_MS}
            max={MAX_LATENCY_CORRECTION_MS}
            step={0.5}
            unit="ms"
            onCommit={(recordLatencyOffsetMs) => set({ recordLatencyOffsetMs })}
          />
        </label>
      </div>
      {calibration.state === 'done' && <CalibrationResult services={services} measurement={calibration.m} onUsed={onForgetCalibration} />}
      {calibration.state === 'error' && <p className={styles.error}>{calibration.error}</p>}
    </fieldset>
  );
}

/** The result of a calibration: a number to use when the clicks came back clearly, else what to try. */
function CalibrationResult({ services, measurement, onUsed }: { services: Services; measurement: Extract<Calibration, { state: 'done' }>['m']; onUsed(): void }) {
  if (!measurementOk(measurement)) {
    return <p className={styles.error}>{unclearMeasurementText(measurement.found, measurement.played, measurement.spreadMs)}</p>;
  }
  return (
    <div className={styles.result}>
      <span>
        Measured {measurement.ms} ms (heard {measurement.found} of {measurement.played} clicks, steady within {measurement.spreadMs} ms).
      </span>
      <button
        className={`${dialog.button} ${dialog.primary}`}
        onClick={() => {
          services.audioInput.setMeasuredLatency(measurement.ms);
          onUsed();
        }}
      >
        Use it
      </button>
    </div>
  );
}
