import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { MASTER, type InsertId } from '@core/model/types';
import { STREAMING_TARGETS } from '@core/metering/targets';
import type { MeterState } from '@app/metering/service';
import type { TargetChoice } from '@app/metering/targets';
import type { Services } from '@app/services';
import { useDoc, useServices } from '../../services-context';
import { insertName } from '../mixer/routing';
import { MetersController } from './controller';
import styles from './Meters.module.css';
import { LoudnessPanel, SpectrumPanel, StereoPanel } from './MeterPanels';
import { ReportPanel } from './ReportPanel';

const SLOPES = [
  { value: 0, label: 'Flat (true levels)' },
  { value: 3, label: '+3 dB per octave' },
  { value: 4.5, label: '+4.5 dB per octave' },
];

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
  const source = order.includes(settings.source) ? settings.source : MASTER;
  const insertNames = useMemo(() => names.split('\u0001'), [names]);

  // Before the effect that makes the controller, so a new controller starts with the current choice.
  useEffect(() => {
    showReferenceNow.current = showReference;
  }, [showReference]);

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
      <MetersBar
        services={services}
        settings={settings}
        source={source}
        order={order}
        insertNames={insertNames}
        hasReference={hasReference}
        showReference={showReference}
        onShowReferenceChange={setShowReference}
      />
      {settings.reportOpen && <ReportPanel onClose={() => services.meters.store.setState({ reportOpen: false })} />}
      <div className={styles.grid}>
        <LoudnessPanel />
        <StereoPanel />
        <SpectrumPanel />
      </div>
    </div>
  );
}

interface MetersBarProps {
  services: Services;
  settings: MeterState;
  /** The track being measured, the mixer's track order and their names. */
  source: InsertId;
  order: readonly InsertId[];
  insertNames: readonly string[];
  hasReference: boolean;
  showReference: boolean;
  onShowReferenceChange(show: boolean): void;
}

/** The bar on top: which track to measure, the loudness target, the spectrum slope, the reference tone switch and the resets. */
function MetersBar({ services, settings, source, order, insertNames, hasReference, showReference, onShowReferenceChange }: MetersBarProps) {
  return (
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
        <input type="checkbox" checked={showReference} onChange={(e) => onShowReferenceChange(e.target.checked)} />
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
  );
}
