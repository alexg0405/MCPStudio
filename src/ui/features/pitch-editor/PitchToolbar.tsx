import { useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { useStore } from 'zustand';
import { audioClipOf, editFor, renderNow, setNoteSettings, setTransition, snapClip } from '@app/actions/pitch';
import { pitchState, type PitchEditorState } from '@app/pitch/state';
import { pitchRenderSignature } from '@core/audio/align/edit';
import { DEFAULT_TRANSITION_MS, isNeutralEdit } from '@core/audio/pitch-edit';
import type { ClipId, PitchEdit } from '@core/model/types';
import { PITCH_NAMES, SCALES } from '@agstudio/sdk/notes';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useDoc, useEngineStatus, useServices } from '../../services-context';
import type { PitchEditorController, PitchTool } from './controller';
import { moreMenuEntries, type NoteSelection } from './pitch-menus';
import styles from './PitchEditor.module.css';

/** A 0-to-1 amount as a percent ("85 %"). */
const percentText = (amount: number) => `${Math.round(amount * 100)} %`;

/** Pressing a toolbar button must not take the keyboard away from the editor (its keys move notes). */
const keepFocus = (e: PointerEvent) => e.preventDefault();

/** How much one click on − or + zooms (a factor). */
const ZOOM_STEP = 1.4;

/** The longest transition the slider offers, in ms, and its step. */
const MAX_TRANSITION_MS = 300;
const TRANSITION_STEP_MS = 5;

/** Everything the toolbar sections show, worked out once per render from the editor state and the clip's edit. */
function useToolbarModel() {
  const services = useServices();
  const st = useStore(pitchState, (s) => s);
  const songKey = useDoc((p) => p.transport.key);
  const { playing } = useEngineStatus();
  const clipId = st.clipId;
  const clip = st.clip;
  const edit = useDoc((p) => (clipId ? audioClipOf(p, clipId)?.clip.pitchEdit : undefined));
  // What the render must have been made for (the edit, and the aligned sound it was made from).
  const signature = useDoc((p) => {
    const found = clipId ? audioClipOf(p, clipId) : null;
    return found ? pitchRenderSignature(found.clip) : null;
  });
  const hearingOriginal = useStore(services.editor, (e) => !!clipId && e.pitchOriginal.includes(clipId));
  const noteCount = clip ? editFor(services.doc.getState().project, clip).notes.length : 0;
  const selected = st.selected;
  const which: NoteSelection = selected.length > 0 ? new Set(selected) : 'all';
  const hasSelection = selected.length > 0;

  // The note whose settings the sliders show: the first selected one, else the first of the clip.
  const allNoteIndices = edit?.notes.map((_, i) => i) ?? clip?.analysis.notes.map((_, i) => i) ?? [];
  const shownNote = edit?.notes[(hasSelection ? selected : allNoteIndices)[0] ?? 0];

  const isReady = st.phase === 'ready' && !!clip && noteCount > 0;
  const hasCorrection = !!edit && !isNeutralEdit(edit);
  const isRenderCurrent = !!edit && !!edit.renderedSampleId && edit.renderedFor === signature;
  const needsRender = hasCorrection && !isRenderCurrent && !st.rendering && st.phase === 'ready';
  const selectionScope = selected.length === 1 ? 'the selected note' : `the ${selected.length} selected notes`;
  const scaleName = SCALES.find((s) => s.id === st.keyScale)?.label.toLowerCase() ?? st.keyScale;

  return {
    services,
    st,
    songKey,
    isPlaying: playing,
    clipId,
    clip,
    edit,
    hearingOriginal,
    noteCount,
    selected,
    which,
    isReady,
    needsRender,
    canCompare: !!edit && hasCorrection && st.phase === 'ready',
    scope: hasSelection ? selectionScope : 'all notes',
    keyLabel: `${PITCH_NAMES[st.keyRoot] ?? 'C'} ${scaleName}`,
    drift: shownNote?.drift ?? 0,
    vibrato: shownNote?.vibrato ?? 1,
    transitionMs: edit?.transition ?? DEFAULT_TRANSITION_MS,
    statusText: statusText({ st, clipId, edit, signature, hearingOriginal, noteCount }),
  };
}

type ToolbarModel = ReturnType<typeof useToolbarModel>;

/** What the status line needs to know. */
interface StatusInput {
  st: PitchEditorState;
  clipId: ClipId | null;
  edit: PitchEdit | undefined;
  /** What the edit's render must have been made for (`pitchRenderSignature`). */
  signature: string | null;
  hearingOriginal: boolean;
  noteCount: number;
}

/** What the status line says about the clip: listening, hearing the original, rendering, ready or nothing corrected yet. */
function statusText({ st, clipId, edit, signature, hearingOriginal, noteCount }: StatusInput): string {
  if (st.phase === 'analyzing') return 'Listening to the clip…';
  if (st.phase !== 'ready') return '';
  if (hearingOriginal) return 'Hearing your original recording (B switches back to the corrected sound)';
  if (st.rendering && st.rendering.clipId === clipId) return `Rendering corrected audio ${Math.round(st.rendering.fraction * 100)} %…`;
  if (edit && !isNeutralEdit(edit)) {
    if (edit.renderedSampleId && edit.renderedFor === signature) return 'Corrected audio ready: the clip plays it';
    // Nothing is rendering and nothing is on the way: the project was opened with an out-of-date render, or a render failed.
    return st.rendering ? 'Corrected audio is being made…' : 'Corrected audio is not made yet';
  }
  return noteCount ? `${noteCount} note${noteCount === 1 ? '' : 's'} found: nothing corrected yet` : '';
}

type ControllerRef = RefObject<PitchEditorController | null>;

/** The toolbar over the Pitch editor: play, A/B listening, tools, key and snap, the shaping sliders, zoom and status. */
export function PitchToolbar({ controller, tool, setTool }: { controller: ControllerRef; tool: PitchTool; setTool: (t: PitchTool) => void }) {
  const model = useToolbarModel();
  return (
    <div className={styles.toolbar}>
      <PlayButton model={model} />
      <ListenChoice model={model} />
      <ToolChoice tool={tool} setTool={setTool} />
      <KeyChoice model={model} />
      <SnapStrength model={model} />
      <SnapButtons model={model} controller={controller} />
      <span className={styles.sep} />
      <ShapeSliders model={model} />
      <MoreButton model={model} />
      <ZoomButtons controller={controller} />
      <StatusLine model={model} />
    </div>
  );
}

function PlayButton({ model }: { model: ToolbarModel }) {
  const { services, clip, isPlaying } = model;
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`${styles.tool} ${styles.play} ${isPlaying ? styles.toolOn : ''}`}
      disabled={!clip}
      onPointerDown={keepFocus}
      onClick={() => services.commands.run(isPlaying ? 'transport.stop' : 'pitchEditor.play')}
      data-hint={isPlaying ? 'Stop playing' : 'Play the clip from the selected note (or its start) with the correction'}
      aria-label={isPlaying ? 'Stop' : 'Play'}
    >
      <Icon name={isPlaying ? 'stop' : 'play'} size={14} />
    </button>
  );
}

/** A and B: hear the corrected sound or the original recording, to compare. */
function ListenChoice({ model }: { model: ToolbarModel }) {
  const { services, clipId, hearingOriginal, canCompare } = model;
  const listen = (original: boolean) => clipId && services.commands.run('pitchEditor.toggleOriginal', { clip: clipId, original });
  return (
    <div className={styles.tools} role="group" aria-label="Hear">
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${!hearingOriginal ? styles.toolOn : ''}`}
        disabled={!canCompare}
        aria-pressed={!hearingOriginal}
        onPointerDown={keepFocus}
        onClick={() => listen(false)}
        data-hint="A: hear the corrected sound (what the clip plays). Press B to switch between A and B; nothing in the project changes"
      >
        Corrected
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${hearingOriginal ? styles.toolOn : ''}`}
        disabled={!canCompare}
        aria-pressed={hearingOriginal}
        onPointerDown={keepFocus}
        onClick={() => listen(true)}
        data-hint="B: hear your original recording instead of the correction, to compare (press B to switch). Nothing in the project changes; it goes back to corrected when the editor is closed"
      >
        Original
      </button>
    </div>
  );
}

/** Select or Split: what a click on a note does. */
function ToolChoice({ tool, setTool }: { tool: PitchTool; setTool: (t: PitchTool) => void }) {
  return (
    <div className={styles.tools} role="toolbar">
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${tool === 'select' ? styles.toolOn : ''}`}
        onPointerDown={keepFocus}
        onClick={() => setTool('select')}
        data-hint="Select: click a note, drag it up or down to retune it (snaps to semitones; hold Alt to move by cents), drag empty space to select several"
      >
        Select
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${tool === 'split' ? styles.toolOn : ''}`}
        onPointerDown={keepFocus}
        onClick={() => setTool('split')}
        data-hint="Split: click on a note to cut it in two there (or press S over a note). Merge them again with M"
      >
        Split
      </button>
    </div>
  );
}

/** The key notes are pulled to: tonic and scale, with a button to go back to the song's key. */
function KeyChoice({ model }: { model: ToolbarModel }) {
  const { st, songKey } = model;
  return (
    <span className={styles.group}>
      <label className={styles.field} data-hint="The key notes are pulled to: pick the tonic and the scale (starts as the song's key)">
        Key
        <select value={st.keyRoot} onChange={(e) => pitchState.setState({ keyRoot: Number(e.target.value), keyFollowsSong: false })}>
          {PITCH_NAMES.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
        <select value={st.keyScale} onChange={(e) => pitchState.setState({ keyScale: e.target.value, keyFollowsSong: false })} aria-label="Scale">
          {SCALES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {songKey && !st.keyFollowsSong ? (
        <button
          type="button"
          tabIndex={-1}
          className={styles.tool}
          onPointerDown={keepFocus}
          onClick={() => pitchState.setState({ keyRoot: songKey.root, keyScale: songKey.scale, keyFollowsSong: true })}
          data-hint="Use the song's key again"
        >
          Song key
        </button>
      ) : null}
    </span>
  );
}

/** How far Snap pulls each note towards the key. */
function SnapStrength({ model }: { model: ToolbarModel }) {
  const { st } = model;
  return (
    <label className={styles.field} data-hint="How far Snap pulls each note towards the key: 100 % puts it exactly on the nearest note of the key, 50 % goes half way (keeps some of the human feel)">
      Strength
      <input type="range" min={0} max={100} step={1} value={Math.round(st.strength * 100)} onChange={(e) => pitchState.setState({ strength: Number(e.target.value) / 100 })} />
      <span className={styles.value}>{percentText(st.strength)}</span>
    </label>
  );
}

/** Snap to key, and the two switches for dragging in key and shading the key's rows. */
function SnapButtons({ model, controller }: { model: ToolbarModel; controller: ControllerRef }) {
  const { services, st, clip, which, scope, keyLabel, isReady, selected } = model;
  const [isDragSnapped, setIsDragSnapped] = useState(false);
  const [isKeyShown, setIsKeyShown] = useState(true);
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className={styles.tool}
        disabled={!isReady}
        onPointerDown={keepFocus}
        onClick={() => clip && snapClip(services, clip, { root: st.keyRoot, scale: st.keyScale }, st.strength, which)}
        data-hint={`Snap ${scope} to ${keyLabel} at ${percentText(st.strength)} (one undo step)`}
      >
        {selected.length > 0 ? 'Snap selected to key' : 'Snap all to key'}
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${isDragSnapped ? styles.toolOn : ''}`}
        aria-pressed={isDragSnapped}
        onPointerDown={keepFocus}
        onClick={() => {
          setIsDragSnapped(!isDragSnapped);
          controller.current?.setSnapToScale(!isDragSnapped);
        }}
        data-hint={`Snap drags to key ${isDragSnapped ? 'on' : 'off'}: dragged notes land on the notes of ${keyLabel} instead of every semitone`}
      >
        Drag in key
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${isKeyShown ? styles.toolOn : ''}`}
        aria-pressed={isKeyShown}
        onPointerDown={keepFocus}
        onClick={() => {
          setIsKeyShown(!isKeyShown);
          controller.current?.setShowScale(!isKeyShown);
        }}
        data-hint="Shade the rows that are outside the chosen key"
      >
        Show key
      </button>
    </>
  );
}

/** The three sliders that shape the notes: drift, vibrato and transition speed. */
function ShapeSliders({ model }: { model: ToolbarModel }) {
  const { services, clip, which, scope, isReady, drift, vibrato, transitionMs } = model;
  return (
    <>
      <label className={styles.field} data-hint={`Flatten drift (${scope}): takes out slow wandering of the pitch within a note, in %. 100 % makes the line dead straight (a robotic sound); 0 leaves it as sung`}>
        Drift
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          disabled={!isReady}
          value={Math.round(drift * 100)}
          onChange={(e) => clip && setNoteSettings(services, clip, which, { drift: Number(e.target.value) / 100 }, 'Flatten drift', `pitch-drift:${clip.clipId}`)}
        />
        <span className={styles.value}>{percentText(drift)}</span>
      </label>
      <label className={styles.field} data-hint={`Vibrato (${scope}): how much of the singer's vibrato is kept, in %. 0 removes it, 100 leaves it as sung, 200 doubles it`}>
        Vibrato
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          disabled={!isReady}
          value={Math.round(vibrato * 100)}
          onChange={(e) => clip && setNoteSettings(services, clip, which, { vibrato: Number(e.target.value) / 100 }, 'Vibrato amount', `pitch-vibrato:${clip.clipId}`)}
        />
        <span className={styles.value}>{percentText(vibrato)}</span>
      </label>
      <label
        className={styles.field}
        data-hint="Transition speed: how long a pitch move takes to glide in at the start of a note, in ms. 0 jumps at once (the hard-tune sound), 25 ms is natural, 100 ms or more is a slow slide"
      >
        Transition
        <input
          type="range"
          min={0}
          max={MAX_TRANSITION_MS}
          step={TRANSITION_STEP_MS}
          disabled={!isReady}
          value={transitionMs}
          onChange={(e) => clip && setTransition(services, clip, Number(e.target.value), `pitch-transition:${clip.clipId}`)}
        />
        <span className={styles.value}>{transitionMs} ms</span>
      </label>
    </>
  );
}

/** "More ▾": merge notes, reset notes, render again, remove all correction. */
function MoreButton({ model }: { model: ToolbarModel }) {
  const { services, clip, clipId, edit, selected, which, isReady } = model;
  const openMenu = (e: MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    showContextMenu({ x: box.left, y: box.bottom + 2 }, moreMenuEntries({ services, clip, clipId, edit, selected, isReady, which }));
  };
  return (
    <button type="button" tabIndex={-1} className={styles.tool} disabled={!isReady} onPointerDown={keepFocus} onClick={openMenu} data-hint="More: merge notes, reset notes, render again, remove all correction">
      More ▾
    </button>
  );
}

function ZoomButtons({ controller }: { controller: ControllerRef }) {
  return (
    <span className={styles.zoom}>
      <button type="button" tabIndex={-1} onPointerDown={keepFocus} onClick={() => controller.current?.zoomBy(1 / ZOOM_STEP)} data-hint="Zoom out (or Ctrl/Cmd + wheel)">
        −
      </button>
      <button type="button" tabIndex={-1} onPointerDown={keepFocus} onClick={() => controller.current?.zoomBy(ZOOM_STEP)} data-hint="Zoom in (or Ctrl/Cmd + wheel)">
        +
      </button>
      <button type="button" tabIndex={-1} onPointerDown={keepFocus} onClick={() => controller.current?.fit()} data-hint="Fit the whole clip in the window">
        Fit
      </button>
    </span>
  );
}

/** What the clip plays right now, with a Render now button when the corrected audio is out of date. */
function StatusLine({ model }: { model: ToolbarModel }) {
  const { clipId, statusText: text, needsRender } = model;
  return (
    <span className={styles.status} data-hint="What the clip plays: the corrected audio is made in the background after each change and replaces the clip's sound; your original recording stays untouched">
      {text}
      {needsRender ? (
        <button type="button" tabIndex={-1} className={styles.link} onClick={() => clipId && renderNow(clipId)}>
          Render now
        </button>
      ) : null}
    </span>
  );
}
