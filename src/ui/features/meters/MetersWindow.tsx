import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { MASTER, type InsertId } from '@core/model/types';
import { STREAMING_TARGETS } from '@core/metering/targets';
import type { TargetChoice } from '@app/metering/targets';
import { useDoc, useServices } from '../../services-context';
import { insertName } from '../mixer/routing';
import { MetersController } from './controller';
import styles from './Meters.module.css';
import { ReportPanel } from './ReportPanel';

const SLOPES = [
  { value: 0, label: 'Flat (true levels)' },
  { value: 3, label: '+3 dB per octave' },
  { value: 4.5, label: '+4.5 dB per octave' },
];

function Readout({ name, label, hint, unit }: { name: string; label: string; hint: string; unit: string }) {
  return (
    <div className={styles.readout} data-hint={hint}>
      <span className={styles.readoutLabel}>{label}</span>
      <b className={styles.readoutValue} data-meter={name} data-state="none">
        −∞
      </b>
      <span className={styles.readoutUnit}>{unit}</span>
    </div>
  );
}

/** The master (or one insert), measured live: loudness, true peak, stereo and the spectrum. */
export function MetersWindow() {
  const services = useServices();
  const settings = useStore(services.meters.store, (s) => s);
  const hasReference = useDoc((p) => !!p.reference);
  const order = useDoc((p) => p.mixer.order);
  const names = useDoc((p) => order.map((id) => insertName(p, id)).join('\u0001'));
  const rootRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MetersController | null>(null);
  const [showReference, setShowReference] = useState(true);
  const showReferenceNow = useRef(showReference);
  showReferenceNow.current = showReference;
  const source = order.includes(settings.source) ? settings.source : MASTER;
  const insertNames = useMemo(() => names.split('\u0001'), [names]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // The lease opens the meter (full detail) and gives it back when the window closes: a closed window costs nothing.
    const lease = services.meters.listen(source, { full: true });
    const watcher = new MetersController(services, () => lease.meter, root);
    watcher.showReference = showReferenceNow.current;
    controller.current = watcher;
    return () => {
      watcher.dispose();
      controller.current = null;
      lease.release();
    };
  }, [services, source]);

  useEffect(() => {
    if (controller.current) controller.current.showReference = showReference;
    controller.current?.invalidate();
  }, [showReference, settings.target, settings.slopeDb]);

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={styles.bar}>
        <label className={styles.field} data-hint="Which mixer track to measure: the Master (everything you hear) or one insert, after its fader">
          <span className={styles.label}>Listen to</span>
          <select value={source} onChange={(e) => services.meters.store.setState({ source: e.target.value as InsertId })}>
            {order.map((id, index) => (
              <option key={id} value={id}>
                {id === MASTER ? 'Master' : `${index}: ${insertNames[index] ?? ''}`}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="The loudness to aim for, drawn as a dashed line: your reference song's, your song style's, or what a streaming service plays at (in LUFS)">
          <span className={styles.label}>Target</span>
          <select value={settings.target} onChange={(e) => services.meters.store.setState({ target: e.target.value as TargetChoice })}>
            <option value="auto">Automatic (reference, else style)</option>
            {hasReference && <option value="reference">Reference song</option>}
            <option value="style">Song style</option>
            {STREAMING_TARGETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
            <option value="none">No target line</option>
          </select>
        </label>
        <label className={styles.field} data-hint="Tilts the spectrum around 1 kHz so a typical mix looks flat instead of sloping down (dB per octave; it only changes the drawing)">
          <span className={styles.label}>Slope</span>
          <select value={settings.slopeDb} onChange={(e) => services.meters.store.setState({ slopeDb: Number(e.target.value) })}>
            {SLOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {hasReference && (
          <label className={styles.check} data-hint="Draws the tonal balance of your reference song as a dashed line over the spectrum, placed at the loudness you are playing">
            <input type="checkbox" checked={showReference} onChange={(e) => setShowReference(e.target.checked)} />
            Reference tone
          </label>
        )}
        <span className={styles.spacer} />
        <label className={styles.check} data-hint="Starts the integrated loudness, range and maximums again every time the song starts playing">
          <input type="checkbox" checked={settings.resetOnPlay} onChange={(e) => services.meters.store.setState({ resetOnPlay: e.target.checked })} />
          Restart on play
        </label>
        <button className={styles.button} onClick={() => services.meters.reset()} data-hint="Starts the integrated loudness (LUFS), loudness range, true-peak hold and the history graph again, from now">
          Reset
        </button>
        <button className={styles.button} onClick={() => void services.meters.showReport()} data-hint="Renders the song offline (the whole song, or your pattern) and reports its integrated loudness, range, true peak and what streaming services will do (it waits while the song plays)">
          Loudness report…
        </button>
      </div>
      {settings.reportOpen && <ReportPanel onClose={() => services.meters.store.setState({ reportOpen: false })} />}
      <div className={styles.grid}>
        <section className={styles.panel}>
          <h3 className={styles.heading}>Loudness</h3>
          <div className={styles.readouts}>
            <Readout name="momentary" label="Momentary" unit="LUFS" hint="Loudness of the last 0.4 seconds (LUFS, EBU R128). Jumps with every beat" />
            <Readout name="shortTerm" label="Short-term" unit="LUFS" hint="Loudness of the last 3 seconds (LUFS): the number to watch while mixing" />
            <Readout name="integrated" label="Integrated" unit="LUFS" hint="Loudness of everything since the song started playing (LUFS, gated): what streaming services measure" />
            <Readout name="range" label="Range" unit="LU" hint="Loudness range (LU): how far the loud and quiet parts are apart. Under 4 is squashed, over 12 is very dynamic" />
            <Readout name="truePeak" label="True peak" unit="dBTP" hint="The highest level between the samples (4× oversampled), since the song started playing. Keep it under −1 dBTP" />
          </div>
          <p className={styles.target} data-meter="target" data-hint="The dashed line on the graph: where your loudness should end up. Change it with Target above" />
          <div className={styles.moreReadouts}>
            <span data-hint="True peak of the left channel, held (dBTP)">
              L peak <b data-meter="peakL" data-state="none">−∞</b>
            </span>
            <span data-hint="True peak of the right channel, held (dBTP)">
              R peak <b data-meter="peakR" data-state="none">−∞</b>
            </span>
            <span data-hint="The loudest momentary (0.4 s) loudness since the song started playing (LUFS)">
              Max momentary <b data-meter="maxMomentary">−∞</b>
            </span>
            <span data-hint="The loudest short-term (3 s) loudness since the song started playing (LUFS)">
              Max short-term <b data-meter="maxShortTerm">−∞</b>
            </span>
          </div>
          <div className={styles.canvasBox} data-hint="Loudness over time: bold line short-term, thin line momentary (LUFS); the dashed line is the target">
            <canvas className={styles.canvas} data-canvas="history" />
            <div className={styles.idle} data-meter="idle">
              Press play: the loudness is measured from the moment the song starts, and drawn here.
            </div>
            <div className={styles.idle} data-meter="unavailable" hidden>
              The meters need the audio engine and cross-origin isolation: run AGstudio from its own server and click the page once.
            </div>
          </div>
        </section>
        <section className={styles.panel}>
          <h3 className={styles.heading}>Stereo</h3>
          <div className={styles.stereo}>
            <div className={styles.gonioBox} data-hint="Goniometer: a straight vertical line is mono, a wide cloud is stereo, a horizontal line is out of phase (it will vanish in mono)">
              <canvas className={styles.canvas} data-canvas="gonio" />
            </div>
            <div className={styles.barsBox} data-hint="Correlation: +1 mono, 0 unrelated channels, −1 out of phase. Width: how much of each band (low under 150 Hz, mid, high over 2 kHz) is side signal, 0 to 100 %">
              <canvas className={styles.canvas} data-canvas="bars" />
            </div>
          </div>
          <p className={styles.warning} data-meter="warning" hidden />
        </section>
        <section className={styles.panel}>
          <h3 className={styles.heading}>Spectrum</h3>
          <div className={styles.canvasBox} data-hint="Spectrum in 1/6-octave bands (dB; 0 dB is a full-scale tone): low notes left, highs right. The thin line is the peak hold; a dashed line is your reference song's tone">
            <canvas className={styles.canvas} data-canvas="spectrum" />
          </div>
          <p className={styles.note} data-meter="referenceNote" hidden>
            Dashed line: the tonal balance of your reference song, at the level you are playing.
          </p>
          <h3 className={styles.heading}>Spectrogram</h3>
          <div className={styles.canvasBox} data-hint="The spectrum over time: the newest moment is on the right, highs are up, brighter is louder">
            <canvas className={styles.canvas} data-canvas="spectrogram" />
          </div>
        </section>
      </div>
    </div>
  );
}
