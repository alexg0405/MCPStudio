/** The parts of the Reference window: the drop zone, the progress line, the facts table, the strips, the tonal balance and the match buttons. */
import type { DragEvent, MouseEvent } from 'react';
import { chooseReferenceFile, stopReferenceWork, arrangeLikeReference, matchLoudnessFromUi, matchTempoAndKey, toneDifferenceFromUi } from '@app/reference/actions';
import type { ToneReport } from '@app/reference/state';
import type { Services } from '@app/services';
import type { Project, ReferenceTrack } from '@core/model/types';
import { sectionStrip } from '@core/reference/track';
import { Icon } from '../../controls/Icon';
import styles from './Reference.module.css';
import { bandFill, bandRows, diffText, factRows, referenceStrip, stripParts, type StripPart } from './reference-view';

/** What is being worked on, as the window shows it. */
export interface ReferenceWork {
  label: string;
  /** 0 to 1. */
  fraction: number;
}

/** The empty state: how to choose a reference song, and what is (and is not) kept from it. */
export function ReferenceDrop({ services, working, onDrop, onDragOver, onLibraryMenu }: {
  services: Services;
  working: ReferenceWork | null;
  onDrop(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onLibraryMenu(e: MouseEvent): void;
}) {
  return (
    <div className={styles.drop} onDrop={onDrop} onDragOver={onDragOver} data-hint="Drop an audio file here: a song you own (MP3, AAC/M4A, WAV, FLAC, OGG)">
      <Icon name="note" size={28} />
      <div className={styles.emptyTitle}>Shape your song after one you like</div>
      <div className={styles.emptyText}>
        Drop a song you own here, or choose a file. AGstudio measures its tempo, key, parts, loudness and tone, and uses those numbers to help shape your song.
      </div>
      <div className={styles.emptyText}>Only the numbers are kept. Its sound, melody and chords are never copied, played or put in your song.</div>
      <div className={styles.row}>
        <button className={styles.primary} onClick={() => void chooseReferenceFile(services)} disabled={!!working} data-hint="Choose an audio file from your computer to use as the reference">
          Choose a song file…
        </button>
        <button className={styles.button} onClick={onLibraryMenu} disabled={!!working} data-hint="Use a song from your music library (DJ window) as the reference">
          From my music…
        </button>
      </div>
    </div>
  );
}

/** The line shown while the reference is being measured or compared, with a Stop button. */
export function ReferenceProgress({ working }: { working: ReferenceWork }) {
  return (
    <div className={styles.progress} role="status">
      <div className={styles.progressBar} aria-hidden>
        <div className={styles.progressFill} style={{ width: `${Math.round(working.fraction * 100)}%` }} />
      </div>
      <span className={styles.progressText}>{working.label}…</span>
      <button className={styles.ghost} onClick={stopReferenceWork} data-hint="Stop. Nothing is changed in your song">
        Stop
      </button>
    </div>
  );
}

/** The bar on top: the reference's title and the buttons to change or clear it. */
export function ReferenceBar({ services, reference, working, onLibraryMenu, onClear }: {
  services: Services;
  reference: ReferenceTrack;
  working: ReferenceWork | null;
  onLibraryMenu(e: MouseEvent): void;
  onClear(): void;
}) {
  return (
    <div className={styles.bar}>
      <span className={styles.label}>Reference</span>
      <span className={styles.title} data-hint={`${reference.title}: measured, not copied. The file stays yours`}>
        {reference.title}
      </span>
      <span className={styles.spacer} />
      <button className={styles.button} onClick={() => void chooseReferenceFile(services)} disabled={!!working} data-hint="Choose another song as the reference (one undo step)">
        Change…
      </button>
      <button className={styles.ghost} onClick={onLibraryMenu} disabled={!!working} data-hint="Use a song of your music library instead">
        From my music…
      </button>
      <button className={styles.ghost} onClick={onClear} disabled={!!working} data-hint="Remove the reference from this project (one undo step)">
        Clear
      </button>
    </div>
  );
}

/** Tempo, key, loudness and the like, the reference and your song side by side. */
export function FactsTable({ project, reference, toneReport }: { project: Project; reference: ReferenceTrack; toneReport: ToneReport | null }) {
  const facts = factRows(project, reference, toneReport?.song ?? null);
  return (
    <table className={styles.facts}>
      <thead>
        <tr>
          <th />
          <th>Reference</th>
          <th>Your song</th>
        </tr>
      </thead>
      <tbody>
        {facts.map((f) => (
          <tr key={f.label} data-hint={f.hint}>
            <td className={styles.factLabel}>{f.label}</td>
            <td>{f.reference}</td>
            <td>{f.mine}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One song's parts as a strip: width is length in bars, height is energy. */
function Strip({ title, parts, hint }: { title: string; parts: StripPart[]; hint: string }) {
  return (
    <div className={styles.stripRow}>
      <span className={styles.stripTitle} data-hint={hint}>
        {title}
      </span>
      <div className={styles.strip} role="img" aria-label={`${title}: ${parts.map((x) => `${x.label} ${x.bars} bars`).join(', ') || 'none'}`}>
        {parts.length === 0 ? (
          <span className={styles.stripEmpty}>No sections yet: add markers to the playlist, or press Arrange like the reference</span>
        ) : (
          parts.map((x, i) => (
            <div key={i} className={styles.part} style={{ width: `${x.widthPct}%` }} data-hint={`${x.label}: ${x.bars} bars, energy ${Math.round(x.energy * 100)} %`}>
              <div className={styles.partFill} data-kind={x.kind} style={{ height: `${Math.max(8, Math.round(x.energy * 100))}%` }} />
              <span className={styles.partLabel}>
                {x.label} {x.bars}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** A song's sections as the strip shows them. */
export interface MySection {
  label: string;
  bars: number;
  energy: number;
  kind: string;
}

/** The reference's parts and yours, on one shared scale of bars. */
export function PartsSection({ reference, mine }: { reference: ReferenceTrack; mine: MySection[] }) {
  const barsOf = (sections: readonly { bars: number }[]) => sections.reduce((n, s) => n + s.bars, 0);
  const scale = Math.max(barsOf(reference.sections), barsOf(mine));
  return (
    <div className={styles.section}>
      <span className={styles.label} data-hint="The parts of each song: widths are bars, heights are energy">
        Parts and energy
      </span>
      <Strip title="Reference" parts={stripParts(referenceStrip(reference), scale)} hint={`The reference’s parts in bars: ${sectionStrip(reference)}`} />
      <Strip title="Your song" parts={stripParts(mine, scale)} hint="Your song’s sections (the playlist’s markers) in bars, with the energy of what plays" />
    </div>
  );
}

/** How each song's energy spreads over the frequencies, with the bands where your mix is off listed below. */
export function TonalSection({ reference, toneReport }: { reference: ReferenceTrack; toneReport: ToneReport | null }) {
  const rows = bandRows(reference, toneReport?.comparison ?? null);
  return (
    <div className={styles.section}>
      <span className={styles.label} data-hint="How each song’s energy spreads over the frequencies, in dB under the total. Bars are longer where there is more">
        Tonal balance
      </span>
      <div className={styles.bands}>
        {rows.map((r) => (
          <div key={r.id} className={styles.band} data-hint={`${r.label}: the reference has ${r.refDb.toFixed(1)} dB${r.mixDb !== null ? `, your mix ${r.mixDb.toFixed(1)} dB` : ''}`}>
            <span className={styles.bandLabel}>{r.label}</span>
            <div className={styles.bandBars}>
              <div className={styles.refBar} style={{ width: `${Math.round(bandFill(r.refDb) * 100)}%` }} />
              {r.mixDb !== null && <div className={r.off ? styles.mixBarOff : styles.mixBar} style={{ width: `${Math.round(bandFill(r.mixDb) * 100)}%` }} />}
            </div>
            <span className={r.off ? styles.diffOff : styles.diff}>{diffText(r.diffDb)}</span>
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span className={styles.swatchRef} /> Reference <span className={styles.swatchMix} /> Your mix {toneReport ? `(${toneReport.song.what})` : '(press Show the tonal difference)'}
      </div>
      {toneReport && (
        <ul className={styles.findings} data-hint="Bands where your mix is more than 3 dB away from the reference, with what to do">
          {toneReport.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The four buttons that shape your song after the reference (each is one undo step, except the tonal difference, which changes nothing). */
export function MatchActions({ services, reference, working, hasPatterns }: { services: Services; reference: ReferenceTrack; working: ReferenceWork | null; hasPatterns: boolean }) {
  const toast = services.session.getState().toast;
  const done = (r: { message: string; error?: boolean }) => toast(r.message, r.error ? 'error' : 'info');
  const keyNote = reference.key ? ` · ${reference.key.mode === 'minor' ? 'minor' : 'major'} key` : '';
  const arrangeHint = hasPatterns
    ? 'Lays your patterns out with the reference’s section lengths and energy, with fills and transitions. Replaces the song’s arrangement. One undo step'
    : 'Make a beat first: the arrangement needs your patterns to play';
  return (
    <div className={styles.actions}>
      <button
        className={styles.action}
        onClick={() => done(matchTempoAndKey(services))}
        disabled={!!working}
        data-hint="Sets the tempo to the reference’s BPM and moves your pitched notes to its key (drums stay). One undo step"
      >
        <strong>Match tempo and key</strong>
        <span>
          {reference.bpm !== null ? `${reference.bpm} BPM` : 'no steady tempo'}
          {keyNote}
        </span>
      </button>
      <button className={styles.action} onClick={() => done(arrangeLikeReference(services))} disabled={!!working || !hasPatterns} data-hint={arrangeHint}>
        <strong>Arrange like the reference</strong>
        <span>
          {reference.sections.length} parts · {reference.sections.reduce((n, s) => n + s.bars, 0)} bars
        </span>
      </button>
      <button
        className={styles.action}
        onClick={() => void matchLoudnessFromUi(services)}
        disabled={!!working}
        data-hint={`Listens to your mix and sets the faders and the master Limiter so it plays at ${reference.lufs.toFixed(1)} LUFS. One undo step`}
      >
        <strong>Match loudness</strong>
        <span>{reference.lufs.toFixed(1)} LUFS</span>
      </button>
      <button
        className={styles.action}
        onClick={() => void toneDifferenceFromUi(services)}
        disabled={!!working}
        data-hint="Listens to your mix and shows the bands where it is more than 3 dB away from the reference, with a plain suggestion. Changes nothing"
      >
        <strong>Show the tonal difference</strong>
        <span>changes nothing</span>
      </button>
    </div>
  );
}
