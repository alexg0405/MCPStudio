import { useEffect, useMemo, type DragEvent, type MouseEvent } from 'react';
import { useStore } from 'zustand';
import { variantEnvFor } from '@app/arrange/env';
import { inferSections } from '@core/arrange/infer';
import { inferStyle } from '@core/beat/style';
import { library, loadLibrary } from '@app/dj/library';
import {
  arrangeLikeReference,
  chooseReferenceFile,
  clearReference,
  matchLoudnessFromUi,
  matchTempoAndKey,
  setReferenceFromFile,
  setReferenceFromSong,
  stopReferenceWork,
  toneDifferenceFromUi,
} from '@app/reference/actions';
import { referenceState } from '@app/reference/state';
import type { Project } from '@core/model/types';
import { sectionStrip } from '@core/reference/track';
import { songSections } from '@core/query/sections';
import { ticksPerBar } from '@core/time/ppq';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import styles from './Reference.module.css';
import { bandFill, bandRows, factRows, referenceStrip, stripParts, type StripPart } from './reference-view';

const SONG_DRAG = 'text/x-ag-song';

/** The musician's own sections for the strip (energy from what plays; none without markers or clips). */
function mySections(p: Project): { label: string; bars: number; energy: number; kind: string }[] {
  try {
    const bar = ticksPerBar(p.transport.timeSig);
    const marks = songSections(p);
    if (!marks.length) return [];
    const inferred = inferSections(p, variantEnvFor(p, inferStyle(p)));
    return marks.map((m) => {
      const hit = inferred.find((s) => s.markerId === m.markerId);
      return { label: m.name, bars: Math.max(1, Math.round((m.to - m.from) / bar)), energy: hit ? (hit.energy - 1) / 4 : 0.5, kind: hit?.role ?? 'verse' };
    });
  } catch {
    return [];
  }
}

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

/** The Reference window: drop a song you own, see how your song compares, and shape yours after it. */
export function ReferenceWindow() {
  const services = useServices();
  const ref = useDoc((p) => p.reference);
  const bpm = useDoc((p) => p.transport.bpm);
  const key = useDoc((p) => p.transport.key);
  const playlist = useDoc((p) => p.playlist);
  const working = useStore(referenceState, (s) => s.working);
  const lastToneReport = useStore(referenceState, (s) => s.tone);
  const songs = useStore(library, (s) => s.songs);
  useEffect(() => void loadLibrary(), []);

  const project = services.doc.getState().project;
  const toneReport = lastToneReport && ref && lastToneReport.projectId === project.projectId && lastToneReport.referenceHash === ref.hash ? lastToneReport : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when what it reads changes
  const mine = useMemo(() => mySections(services.doc.getState().project), [services, playlist, bpm, key]);

  const toast = services.session.getState().toast;
  const done = (r: { message: string; error?: boolean }) => toast(r.message, r.error ? 'error' : 'info');

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (working) return;
    const songKey = e.dataTransfer.getData(SONG_DRAG);
    if (songKey) {
      const song = library.getState().songs.find((x) => x.key === songKey);
      if (song) void setReferenceFromSong(services, song);
      return;
    }
    const file = e.dataTransfer.files[0];
    if (file) void setReferenceFromFile(services, file);
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(SONG_DRAG)) e.preventDefault();
  };

  const libraryMenu = (e: MouseEvent) => {
    const items: MenuEntry[] = songs.length
      ? songs.slice(0, 60).map((x) => ({ label: x.label, onSelect: () => void setReferenceFromSong(services, x) }))
      : [{ label: 'The music library is empty (add songs in the DJ window)', disabled: true, onSelect: () => {} }];
    showContextMenu(e, items);
  };

  const drop = (
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
        <button className={styles.button} onClick={libraryMenu} disabled={!!working} data-hint="Use a song from your music library (DJ window) as the reference">
          From my music…
        </button>
      </div>
    </div>
  );

  const progress = working && (
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

  if (!ref) {
    return (
      <div className={styles.root} data-tour="reference">
        {progress}
        {drop}
      </div>
    );
  }

  const facts = factRows(project, ref, toneReport?.song ?? null);
  const rows = bandRows(ref, toneReport?.comparison ?? null);
  const scale = Math.max(ref.sections.reduce((n, s) => n + s.bars, 0), mine.reduce((n, s) => n + s.bars, 0));
  const noSong = Object.keys(project.patterns).length === 0;

  return (
    <div className={styles.root} data-tour="reference" onDrop={onDrop} onDragOver={onDragOver}>
      <div className={styles.bar}>
        <span className={styles.label}>Reference</span>
        <span className={styles.title} data-hint={`${ref.title}: measured, not copied. The file stays yours`}>
          {ref.title}
        </span>
        <span className={styles.spacer} />
        <button className={styles.button} onClick={() => void chooseReferenceFile(services)} disabled={!!working} data-hint="Choose another song as the reference (one undo step)">
          Change…
        </button>
        <button className={styles.ghost} onClick={libraryMenu} disabled={!!working} data-hint="Use a song of your music library instead">
          From my music…
        </button>
        <button className={styles.ghost} onClick={() => clearReference(services)} disabled={!!working} data-hint="Remove the reference from this project (one undo step)">
          Clear
        </button>
      </div>
      {progress}
      <div className={styles.body}>
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

        <div className={styles.section}>
          <span className={styles.label} data-hint="The parts of each song: widths are bars, heights are energy">
            Parts and energy
          </span>
          <Strip title="Reference" parts={stripParts(referenceStrip(ref), scale)} hint={`The reference’s parts in bars: ${sectionStrip(ref)}`} />
          <Strip title="Your song" parts={stripParts(mine, scale)} hint="Your song’s sections (the playlist’s markers) in bars, with the energy of what plays" />
        </div>

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
                <span className={r.off ? styles.diffOff : styles.diff}>{r.diffDb === null ? '' : `${r.diffDb > 0 ? '+' : r.diffDb < 0 ? '−' : ''}${Math.abs(r.diffDb).toFixed(1)} dB`}</span>
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
      </div>
      <div className={styles.actions}>
        <button
          className={styles.action}
          onClick={() => done(matchTempoAndKey(services))}
          disabled={!!working}
          data-hint="Sets the tempo to the reference’s BPM and moves your pitched notes to its key (drums stay). One undo step"
        >
          <strong>Match tempo and key</strong>
          <span>{ref.bpm !== null ? `${ref.bpm} BPM` : 'no steady tempo'}{ref.key ? ` · ${ref.key.mode === 'minor' ? 'minor' : 'major'} key` : ''}</span>
        </button>
        <button
          className={styles.action}
          onClick={() => done(arrangeLikeReference(services))}
          disabled={!!working || noSong}
          data-hint={noSong ? 'Make a beat first: the arrangement needs your patterns to play' : 'Lays your patterns out with the reference’s section lengths and energy, with fills and transitions. Replaces the song’s arrangement. One undo step'}
        >
          <strong>Arrange like the reference</strong>
          <span>{ref.sections.length} parts · {ref.sections.reduce((n, s) => n + s.bars, 0)} bars</span>
        </button>
        <button
          className={styles.action}
          onClick={() => void matchLoudnessFromUi(services)}
          disabled={!!working}
          data-hint={`Listens to your mix and sets the faders and the master Limiter so it plays at ${ref.lufs.toFixed(1)} LUFS. One undo step`}
        >
          <strong>Match loudness</strong>
          <span>{ref.lufs.toFixed(1)} LUFS</span>
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
      <div className={styles.note}>Only measurements are kept. The reference’s audio, melodies and chords are never copied, played or placed in your song.</div>
    </div>
  );
}
