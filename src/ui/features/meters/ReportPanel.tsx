import { useStore } from 'zustand';
import { momentLabel, type LoudnessReport } from '@core/metering/report';
import type { TimeSignature } from '@core/model/types';
import { useDoc, useServices } from '../../services-context';
import { lufsText, peakDbText } from './meters-model';
import styles from './Meters.module.css';

/**
 * The loudness report under the Meters window's bar: runs the offline measurement when it opens, shows the progress,
 * then the numbers, where the loudest moments are, what each streaming service does, and a button that copies it all.
 */
export function ReportPanel({ onClose }: { onClose: () => void }) {
  const services = useServices();
  const report = useStore(services.meters.store, (s) => s.report);
  const working = useStore(services.meters.store, (s) => s.working);
  const timeSig = useDoc((p) => p.transport.timeSig);

  const copy = () => {
    const text = services.meters.reportText();
    if (text) void navigator.clipboard?.writeText(text);
    services.session.getState().toast('Report copied.', 'info');
  };

  return (
    <section className={styles.report} aria-label="Loudness report">
      <div className={styles.reportBar}>
        <h3 className={styles.heading}>Loudness report{report && !working ? `: ${report.what}` : ''}</h3>
        <span className={styles.spacer} />
        {working && (
          <>
            <span className={styles.note}>
              {working.label}… {Math.round(working.fraction * 100)} %
            </span>
            <button className={styles.button} onClick={() => services.meters.stopReport()} data-hint="Stops measuring">
              Stop
            </button>
          </>
        )}
        {report && !working && (
          <button className={styles.button} onClick={copy} data-hint="Copies the report as plain text, to paste into notes or a message">
            Copy as text
          </button>
        )}
        <button className={styles.button} onClick={onClose} data-hint="Hides the report (the numbers are kept until you make another)">
          Close
        </button>
      </div>
      {!report && !working && <p className={styles.note}>Nothing measured yet.</p>}
      {report && (
        <div className={working ? styles.stale : undefined}>
          <ReportTable report={report} timeSig={timeSig} />
          <h4 className={styles.subheading}>What streaming services do</h4>
          <ul className={styles.reportList}>
            {report.services.map((s) => (
              <li key={s.service}>
                <b>{s.service}</b> ({lufsText(s.target)} LUFS) {s.text}
              </li>
            ))}
          </ul>
          {report.notes.map((note) => (
            <p key={note} className={styles.warning}>
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** The measured numbers: loudness, range, true peak, loudest moments and stereo, each with a hint that says what it is. */
function ReportTable({ report, timeSig }: { report: LoudnessReport; timeSig: TimeSignature }) {
  return (
    <table className={styles.reportTable}>
      <tbody>
        <tr data-hint="Gated loudness of the whole part (LUFS, BS.1770-4)">
          <th>Integrated loudness</th>
          <td>{lufsText(report.integrated)} LUFS</td>
        </tr>
        <tr data-hint="Loudness range (LU, EBU Tech 3342): the spread between the quiet and loud parts">
          <th>Loudness range</th>
          <td>{report.range.toFixed(1)} LU</td>
        </tr>
        <tr data-hint="The highest level between the samples (dBTP) and the bar where it happens">
          <th>True peak</th>
          <td>
            {peakDbText(report.truePeakDb)} dBTP at {momentLabel(report.truePeakAt, timeSig)}
          </td>
        </tr>
        <tr data-hint="The loudest 0.4 seconds and the bar where it ends">
          <th>Loudest momentary</th>
          <td>
            {lufsText(report.maxMomentary)} LUFS at {momentLabel(report.maxMomentaryAt, timeSig)}
          </td>
        </tr>
        <tr data-hint="The loudest 3 seconds and the bar where they end">
          <th>Loudest short-term</th>
          <td>
            {lufsText(report.maxShortTerm)} LUFS at {momentLabel(report.maxShortTermAt, timeSig)}
          </td>
        </tr>
        <tr data-hint="Correlation of the whole part (+1 mono, −1 out of phase) and what it loses when summed to mono (dB)">
          <th>Stereo</th>
          <td>
            correlation {report.correlation.toFixed(2)}, {peakDbText(report.monoLossDb)} dB in mono
          </td>
        </tr>
      </tbody>
    </table>
  );
}
