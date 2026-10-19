import { useEffect, useMemo, type DragEvent, type MouseEvent } from 'react';
import { useStore } from 'zustand';
import { variantEnvFor } from '@app/arrange/env';
import { inferSections } from '@core/arrange/infer';
import { inferStyle } from '@core/beat/style';
import { library, loadLibrary } from '@app/dj/library';
import { clearReference, setReferenceFromFile, setReferenceFromSong } from '@app/reference/actions';
import { referenceState } from '@app/reference/state';
import type { Services } from '@app/services';
import type { Project } from '@core/model/types';
import { songSections } from '@core/query/sections';
import { ticksPerBar } from '@core/time/ppq';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import styles from './Reference.module.css';
import { FactsTable, MatchActions, PartsSection, ReferenceBar, ReferenceDrop, ReferenceProgress, TonalSection, type MySection } from './ReferenceSections';

/** The drag data type of a song dragged from the music library. */
const SONG_DRAG = 'text/x-ag-song';
/** How many songs of the music library the "From my music" menu lists. */
const MAX_LIBRARY_MENU_SONGS = 60;
/** The energy a section gets when it could not be worked out (0 to 1: the middle). */
const UNKNOWN_SECTION_ENERGY = 0.5;

/** The musician's own sections for the strip (energy from what plays; none without markers or clips). */
function mySections(p: Project): MySection[] {
  try {
    const bar = ticksPerBar(p.transport.timeSig);
    const marks = songSections(p);
    if (!marks.length) return [];
    const inferred = inferSections(p, variantEnvFor(p, inferStyle(p)));
    return marks.map((m) => {
      const hit = inferred.find((s) => s.markerId === m.markerId);
      // The inferred energy runs 1 to 5; the strip wants 0 to 1.
      const energy = hit ? (hit.energy - 1) / 4 : UNKNOWN_SECTION_ENERGY;
      return { label: m.name, bars: Math.max(1, Math.round((m.to - m.from) / bar)), energy, kind: hit?.role ?? 'verse' };
    });
  } catch {
    return [];
  }
}

/** Songs or files dropped on the window become the reference (ignored while something is being measured). */
function useReferenceDrop(services: Services, isWorking: boolean) {
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (isWorking) return;
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
  return { onDrop, onDragOver };
}

/** The Reference window: drop a song you own, see how your song compares, and shape yours after it. */
export function ReferenceWindow() {
  const services = useServices();
  const reference = useDoc((p) => p.reference);
  const bpm = useDoc((p) => p.transport.bpm);
  const key = useDoc((p) => p.transport.key);
  const playlist = useDoc((p) => p.playlist);
  const working = useStore(referenceState, (s) => s.working);
  const lastToneReport = useStore(referenceState, (s) => s.tone);
  const songs = useStore(library, (s) => s.songs);
  useEffect(() => void loadLibrary(), []);

  const project = services.doc.getState().project;
  const toneReport =
    lastToneReport && reference && lastToneReport.projectId === project.projectId && lastToneReport.referenceHash === reference.hash ? lastToneReport : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when what it reads changes
  const mine = useMemo(() => mySections(services.doc.getState().project), [services, playlist, bpm, key]);
  const { onDrop, onDragOver } = useReferenceDrop(services, !!working);

  const showLibraryMenu = (e: MouseEvent) => {
    const items: MenuEntry[] = songs.length
      ? songs.slice(0, MAX_LIBRARY_MENU_SONGS).map((x) => ({ label: x.label, onSelect: () => void setReferenceFromSong(services, x) }))
      : [{ label: 'The music library is empty (add songs in the DJ window)', disabled: true, onSelect: () => {} }];
    showContextMenu(e, items);
  };

  const progress = working && <ReferenceProgress working={working} />;
  if (!reference) {
    return (
      <div className={styles.root} data-tour="reference">
        {progress}
        <ReferenceDrop services={services} working={working} onDrop={onDrop} onDragOver={onDragOver} onLibraryMenu={showLibraryMenu} />
      </div>
    );
  }

  return (
    <div className={styles.root} data-tour="reference" onDrop={onDrop} onDragOver={onDragOver}>
      <ReferenceBar services={services} reference={reference} working={working} onLibraryMenu={showLibraryMenu} onClear={() => clearReference(services)} />
      {progress}
      <div className={styles.body}>
        <FactsTable project={project} reference={reference} toneReport={toneReport} />
        <PartsSection reference={reference} mine={mine} />
        <TonalSection reference={reference} toneReport={toneReport} />
      </div>
      <MatchActions services={services} reference={reference} working={working} hasPatterns={Object.keys(project.patterns).length > 0} />
      <div className={styles.note}>Only measurements are kept. The reference’s audio, melodies and chords are never copied, played or placed in your song.</div>
    </div>
  );
}
