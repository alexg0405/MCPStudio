import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { audioClipOf, defaultPitchClip, loadPitchClip } from '@app/actions/pitch';
import { pitchState } from '@app/pitch/state';
import type { Services } from '@app/services';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import { PitchEditorController, KEYS_WIDTH, RULER_HEIGHT, type PitchEditorElements, type PitchTool } from './controller';
import { noteMenuEntries } from './pitch-menus';
import { PitchToolbar } from './PitchToolbar';
import styles from './PitchEditor.module.css';

/** The canvases and scroll elements the controller draws on and reads, as refs to the elements React renders. */
function useEditorElements() {
  return {
    area: useRef<HTMLDivElement>(null),
    stage: useRef<HTMLDivElement>(null),
    ruler: useRef<HTMLCanvasElement>(null),
    keys: useRef<HTMLCanvasElement>(null),
    grid: useRef<HTMLCanvasElement>(null),
    content: useRef<HTMLCanvasElement>(null),
    overlay: useRef<HTMLCanvasElement>(null),
    hscroll: useRef<HTMLDivElement>(null),
    hthumb: useRef<HTMLDivElement>(null),
  };
}

/**
 * What the clip plays, as one string: a trim, a tempo or a channel change moves it, so the editor looks at the clip again
 * when this changes (empty when no clip is open).
 */
function useClipPlayingSignature(): string {
  return useDoc((p) => {
    const id = pitchState.getState().clipId;
    const found = id ? audioClipOf(p, id) : null;
    if (!found) return '';
    const { clip, channel } = found;
    const parts = [clip.offsetSec, clip.length, channel.pitch ?? 0, channel.reverse ? 1 : 0, channel.stretch ?? '', channel.sourceBpm ?? 0, channel.sampleId];
    return parts.join('|');
  });
}

/** Opens the editor on the selected audio clip when nothing was chosen yet, and looks again when the clip's sound changes. */
function useLoadedClip(services: Services): void {
  const signature = useClipPlayingSignature();
  useEffect(() => {
    const current = pitchState.getState();
    const id = current.clipId ?? defaultPitchClip(services);
    if (id && (current.clipId !== id || current.phase === 'none')) void loadPitchClip(services, id);
  }, [services]);
  // A trim, a tempo or channel change moves what the clip plays: look again (cached when it is the same part).
  useEffect(() => {
    const id = pitchState.getState().clipId;
    if (id && signature) void loadPitchClip(services, id);
  }, [services, signature]);
}

/** Creates the controller that draws and handles the editor once the elements exist, and tears it down with the window. */
function useEditorController(services: Services, elements: ReturnType<typeof useEditorElements>, tool: PitchTool): RefObject<PitchEditorController | null> {
  const controller = useRef<PitchEditorController | null>(null);
  useEffect(() => {
    const found = Object.fromEntries(Object.entries(elements).map(([name, ref]) => [name, ref.current]));
    if (Object.values(found).some((el) => !el)) return;
    const created = new PitchEditorController(services, found as unknown as PitchEditorElements);
    created.onMenu = (noteIndex, atMs, at) => {
      const clip = pitchState.getState().clip;
      if (clip) showContextMenu(at, noteMenuEntries(services, clip, noteIndex, atMs));
    };
    controller.current = created;
    created.mount();
    return () => {
      created.unmount();
      controller.current = null;
    };
    // The element refs never change; the controller lives as long as the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);
  useEffect(() => {
    if (controller.current) controller.current.tool = tool;
  }, [tool]);
  return controller;
}

/** The text over the grid when there is nothing to show, or an empty string when the clip's notes are drawn. */
function emptyMessage(clipId: string | null, phase: string, errorText: string, hasNotes: boolean): string {
  if (!clipId && phase === 'none') {
    return 'No clip chosen yet. Select an audio clip in the playlist, then right-click it and choose “Pitch editor…” (or Alt + double-click the clip).';
  }
  if (phase === 'error') return errorText;
  if (phase === 'analyzing') return 'Listening to the clip to find its notes…';
  if (phase === 'ready' && !hasNotes) {
    return 'No sung notes found in this clip. Pitch correction works on one voice or melody line at a time (not chords or drums): try a clip of a vocal.';
  }
  return '';
}

/** The Pitch editor window: a toolbar over a piano grid of the notes found in an audio clip, drawn by the controller. */
export function PitchEditor() {
  const services = useServices();
  const clipId = useStore(pitchState, (s) => s.clipId);
  const phase = useStore(pitchState, (s) => s.phase);
  const errorText = useStore(pitchState, (s) => s.message);
  const hasNotes = useStore(pitchState, (s) => (s.clip?.analysis.notes.length ?? 0) > 0);
  const [tool, setTool] = useState<PitchTool>('select');
  const elements = useEditorElements();
  const { area, stage, ruler, keys, grid, content, overlay, hscroll, hthumb } = elements;
  useLoadedClip(services);
  const controller = useEditorController(services, elements, tool);
  // Closing the editor puts every clip back on its corrected sound (A/B is for comparing while the editor is open).
  useEffect(() => () => services.editor.getState().clearPitchOriginal(), [services]);

  const message = useMemo(() => emptyMessage(clipId, phase, errorText, hasNotes), [clipId, phase, errorText, hasNotes]);

  return (
    <div className={styles.root}>
      <PitchToolbar controller={controller} tool={tool} setTool={setTool} />
      <div
        ref={area}
        className={styles.area}
        tabIndex={0}
        data-hint="The Pitch editor: click a note, then use the arrow keys to move it (Alt: by cents), S splits it, M joins it with the next, Delete puts it back as sung"
        style={{ gridTemplateColumns: `${KEYS_WIDTH}px 1fr`, gridTemplateRows: `${RULER_HEIGHT}px 1fr 12px` }}
      >
        <div className={styles.corner} />
        <canvas ref={ruler} className={styles.ruler} data-hint="Time in the clip's recording (minutes:seconds)" />
        <canvas ref={keys} className={styles.keys} data-hint="Notes: the rows are semitones; rows of the chosen key are marked" />
        <div
          ref={stage}
          className={styles.stage}
          data-hint="The notes found in the recording: blobs on a piano grid, the thin line is the pitch as sung, the bright line is the corrected pitch. Drag a blob up or down to retune it"
        >
          <canvas ref={grid} className={styles.layer} />
          <canvas ref={content} className={styles.layer} />
          <canvas ref={overlay} className={styles.layer} />
          {message ? <div className={phase === 'error' || !clipId ? styles.empty : styles.emptyHint}>{message}</div> : null}
        </div>
        <div className={styles.corner} />
        <div ref={hscroll} className={styles.hscroll}>
          <div ref={hthumb} className={styles.hthumb} />
        </div>
      </div>
    </div>
  );
}
