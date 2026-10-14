import { useEffect, useRef } from 'react';
import { createStore, useStore } from 'zustand';
import { measurementOk } from '@app/audio-input';
import type { Services } from '@app/services';
import type { LatencyMeasurement } from '@core/audio/latency';
import { MASTER } from '@core/model/types';
import { holdModal } from '../../controls/Dialog';
import { onFrame } from '../../frame-loop';
import { useDoc, useServices } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import styles from './Recording.module.css';

/** Whether the dialog is open. */
export const audioInputDialog = createStore<{ open: boolean }>(() => ({ open: false }));

type Calibration =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; m: LatencyMeasurement }
  | { state: 'error'; error: string };

/** The latency calibration's progress (the dialog shows it; the command starts it). */
export const calibrationStore = createStore<{ c: Calibration; abort: AbortController | null }>(() => ({
  c: { state: 'idle' },
  abort: null,
}));

/** Plays the clicks and measures the round trip (the result waits in the dialog to be used). */
export async function runCalibration(s: Services): Promise<void> {
  if (calibrationStore.getState().c.state === 'running') return;
  const abort = new AbortController();
  calibrationStore.setState({ c: { state: 'running' }, abort });
  const res = await s.audioInput.calibrate(abort.signal);
  calibrationStore.setState({ c: 'error' in res ? { state: 'error', error: res.error } : { state: 'done', m: res }, abort: null });
}

export function AudioInputOverlay() {
  const open = useStore(audioInputDialog, (s) => s.open);
  return open ? <AudioInputDialog /> : null;
}

/** Two bars that follow the input's level on the frame loop (no React renders). */
function LevelMeter() {
  const services = useServices();
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = new Float32Array(2);
    const shown = [0, 0];
    return onFrame(() => {
      services.audioInput.levels(out);
      [left, right].forEach((ref, i) => {
        // dB scale: −60 dB empty, 0 dB full; falls back slowly like a meter.
        const v = out[i] as number;
        const db = v > 0 ? 20 * Math.log10(v) : -120;
        const target = Math.max(0, Math.min(1, (db + 60) / 60));
        shown[i] = Math.max(target, (shown[i] as number) - 0.02);
        const el = ref.current;
        if (el) {
          el.style.width = `${(shown[i] as number) * 100}%`;
          el.dataset.clip = v >= 0.99 ? 'true' : 'false';
        }
      });
    });
  }, [services]);
  return (
    <div className={styles.meter} data-hint="Input level (−60 to 0 dB): play or speak; keep it out of the red at the right">
      <div className={styles.meterRow}>
        <div ref={left} className={styles.meterBar} />
      </div>
      <div className={styles.meterRow}>
        <div ref={right} className={styles.meterBar} />
      </div>
    </div>
  );
}

function AudioInputDialog() {
  const services = useServices();
  const prefs = useStore(services.prefs);
  const input = useStore(services.audioInput.store);
  const inserts = useDoc((p) => p.mixer);
  const calibration = useStore(calibrationStore, (st) => st.c);
  const ref = useRef<HTMLDivElement>(null);
  const set = services.prefs.getState().set;
  const setCalibration = (c: Calibration) => calibrationStore.setState({ c });

  const close = () => {
    calibrationStore.getState().abort?.abort();
    calibrationStore.setState({ c: { state: 'idle' }, abort: null });
    audioInputDialog.setState({ open: false });
  };

  useEffect(() => {
    const release = holdModal();
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    // Opening shows the meter (and asks for permission the first time: the menu click is the gesture).
    void services.audioInput.open().then(() => services.audioInput.refreshDevices());
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
    };
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const calibrate = () => runCalibration(services);

  const tracks = inserts.order.map((id, i) => ({ id: id === MASTER ? '' : id, label: i === 0 ? 'Master' : `${i} · ${inserts.inserts[id]?.name ?? `Insert ${i}`}` }));
  const devices = input.devices.filter((d) => d.deviceId !== 'default' && d.deviceId !== '');
  const needsPermission = input.status !== 'on' || devices.some((d) => !d.label);
  return (
    <div className={dialog.backdrop}>
      <div ref={ref} tabIndex={-1} className={`${dialog.dialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby="ag-input-title">
        <h2 id="ag-input-title" className={dialog.title}>
          Audio input
        </h2>
        <p className={styles.note}>
          What record mode (R) records from: a microphone or an audio interface. Recordings land on the playlist where you
          played them.
        </p>
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
          <button className={`${dialog.button} ${styles.allow}`} onClick={() => void services.audioInput.open().then(() => services.audioInput.refreshDevices())} data-hint="The browser asks once whether AGstudio may use your microphone">
            {input.status === 'opening' ? 'Opening…' : 'Allow microphone access'}
          </button>
        )}
        <LevelMeter />
        <p className={input.status === 'error' ? styles.error : styles.status}>
          {input.status === 'on'
            ? `Listening to ${input.label}.`
            : input.status === 'opening'
              ? 'Opening the input… (the browser may ask for permission)'
              : input.status === 'error'
                ? input.error
                : 'The input is closed: it opens when you record, or press “Allow microphone access”.'}
        </p>

        <label className={styles.check} data-hint="Record mode (R) then records your input into the playlist when you press Play">
          <input type="checkbox" checked={prefs.recordAudio} onChange={(e) => set({ recordAudio: e.target.checked })} />
          <span>Record audio when recording</span>
        </label>
        <label className={styles.check} data-hint="Record mode also records the notes you play and the knobs you move">
          <input type="checkbox" checked={prefs.recordNotes} onChange={(e) => set({ recordNotes: e.target.checked })} />
          <span>Record notes and knob moves too</span>
        </label>

        <div className={styles.row}>
          <label className={styles.check} data-hint="Hear what you record, through the chosen mixer track (with its effects)">
            <input type="checkbox" checked={prefs.audioMonitor} onChange={(e) => set({ audioMonitor: e.target.checked })} />
            <span>Hear the input (monitoring)</span>
          </label>
          <label className={styles.field} data-hint="The mixer track you hear the input through, and that recorded clips play on">
            Mixer track
            <select value={prefs.audioInputTrack && inserts.inserts[prefs.audioInputTrack as never] ? prefs.audioInputTrack : ''} onChange={(e) => set({ audioInputTrack: e.target.value })}>
              {tracks.map((t) => (
                <option key={t.id || 'master'} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className={styles.note}>
          Monitoring is off by default: through speakers the microphone hears itself and howls (feedback). Use headphones
          when you turn it on.
        </p>

        <fieldset className={styles.group}>
          <legend>Latency</legend>
          <p className={styles.note}>
            Recordings are moved back by the time sound takes to go out and come back in, so they land on the beat. Now:{' '}
            <b>{services.audioInput.describeLatency()}</b>.
          </p>
          <div className={styles.row}>
            <button
              className={dialog.button}
              disabled={calibration.state === 'running'}
              onClick={() => void calibrate()}
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
              <span className={styles.inline}>
                <input
                  type="number"
                  className={styles.number}
                  min={-200}
                  max={200}
                  step={0.5}
                  value={prefs.recordLatencyOffsetMs}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= -200 && v <= 200) set({ recordLatencyOffsetMs: v });
                  }}
                />
                ms
              </span>
            </label>
          </div>
          {calibration.state === 'done' &&
            (measurementOk(calibration.m) ? (
              <div className={styles.result}>
                <span>
                  Measured {calibration.m.ms} ms (heard {calibration.m.found} of {calibration.m.played} clicks, steady within{' '}
                  {calibration.m.spreadMs} ms).
                </span>
                <button
                  className={`${dialog.button} ${dialog.primary}`}
                  onClick={() => {
                    services.audioInput.setMeasuredLatency(calibration.m.ms);
                    setCalibration({ state: 'idle' });
                  }}
                >
                  Use it
                </button>
              </div>
            ) : (
              <p className={styles.error}>
                {calibration.m.found === 0
                  ? 'No clicks came back: turn the speakers up and hold the mic near them (or connect the output to the input with a cable), then try again.'
                  : `Only ${calibration.m.found} of ${calibration.m.played} clicks came back clearly${Number.isFinite(calibration.m.spreadMs) ? ` (they varied by ${calibration.m.spreadMs} ms)` : ''}: try again somewhere quieter, or type a correction instead.`}
              </p>
            ))}
          {calibration.state === 'error' && <p className={styles.error}>{calibration.error}</p>}
        </fieldset>
        <div className={dialog.buttons}>
          <button className={`${dialog.button} ${dialog.primary}`} onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
