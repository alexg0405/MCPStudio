/** The piano roll's toolbar: tools, snap, key and scale, chord stamp, ghost notes, event lane, zoom and follow. */
import { useStore } from 'zustand';
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import { NOTE_LANES, type NoteLane, type PianoRollTool } from '@app/stores/editor';
import { useDoc, useServices } from '../../services-context';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import type { PianoRollController } from './controller';
import { PlayPatternButton } from '../transport/PlayPatternButton';
import { LANES } from './lanes';
import { keyMenu, songKeyName, toolsMenu } from './menus';
import { STAMP_OPTIONS } from './stamp';
import styles from './PianoRoll.module.css';

const TOOLS: { tool: PianoRollTool; label: string; key: string; hint: string }[] = [
  {
    tool: 'draw',
    label: 'Draw',
    key: 'P',
    hint: 'Draw: click to add a note, drag notes to move them, drag a note’s end to resize it, right-click a note to delete it (right-click empty space for the menu)',
  },
  { tool: 'paint', label: 'Paint', key: 'B', hint: 'Paint: drag to paint a run of notes' },
  { tool: 'delete', label: 'Delete', key: 'D', hint: 'Delete: click or drag over notes to delete them' },
  { tool: 'mute', label: 'Mute', key: 'T', hint: 'Mute: click or drag over notes to mute them (again to unmute)' },
  { tool: 'slice', label: 'Slice', key: 'C', hint: 'Slice: click a note to cut it in two at the grid line' },
  { tool: 'select', label: 'Select', key: 'E', hint: 'Select: drag a box to select notes; right-click opens the menu' },
];


/** Opens a menu under a toolbar button. */
function menuBelow(e: React.MouseEvent<HTMLElement>, items: MenuEntry[]): void {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
}

/** Keeps the keyboard focus where it was (toolbar buttons never take it from the piano roll). */
const keepFocus = (e: React.PointerEvent): void => e.preventDefault();

/** The six tools, one button each. */
function ToolButtons() {
  const services = useServices();
  const tool = useStore(services.editor, (s) => s.pianoRoll.tool);
  const set = services.editor.getState().setPianoRoll;
  return (
  <div className={styles.tools} role="toolbar">
    {TOOLS.map((t) => (
      <button
        key={t.tool}
        tabIndex={-1}
        className={`${styles.tool} ${tool === t.tool ? styles.toolOn : ''}`}
        onPointerDown={keepFocus}
        onClick={() => set({ tool: t.tool })}
        data-hint={`${t.hint} (${t.key})`}
      >
        {t.label}
      </button>
    ))}
  </div>
  );
}

/** The Tools menu: quantize, legato, strum and the other note scripts. */
function ToolsMenuButton() {
  const services = useServices();
  return (
  <button
    tabIndex={-1}
    className={styles.tool}
    onPointerDown={keepFocus}
    onClick={(e) => menuBelow(e, toolsMenu(services))}
    data-hint="Tools: Quantize, Make legato, Humanize, Strum, Arpeggiate, Chop and more. They change the selected notes, or every note when none are selected"
  >
    Tools ▾
  </button>
  );
}

/** The snap grid notes are placed and moved on. */
function SnapField() {
  const services = useServices();
  const snap = useStore(services.editor, (s) => s.pianoRoll.snap);
  const set = services.editor.getState().setPianoRoll;
  return (
  <label
    className={styles.field}
    data-hint="Snap: the grid notes are placed and moved on. Hold Alt while dragging to ignore it"
  >
    Snap
    <select value={snap} onChange={(e) => set({ snap: e.target.value as Snap })}>
      {SNAP_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </label>
  );
}

/** The song key, and the scale highlight, scale lock and chord tones buttons that work with it. */
function KeyAndScaleButtons() {
  const services = useServices();
  const pr = useStore(services.editor, (s) => s.pianoRoll);
  const songKey = useDoc((p) => p.transport.key);
  const set = services.editor.getState().setPianoRoll;
  const keyName = songKeyName(songKey);
  const noKey = 'Choose a song key first (the Key button)';
  return (
  <span className={styles.group}>
    <button
      tabIndex={-1}
      className={`${styles.tool} ${styles.keyButton} ${songKey ? styles.keySet : ''}`}
      onPointerDown={keepFocus}
      onClick={(e) => menuBelow(e, keyMenu(services))}
      data-hint={`Song key: ${keyName}. Click to choose a root and a scale; tools that work "in key" and the scale highlight use it`}
    >
      Key: {keyName} ▾
    </button>
    <button
      tabIndex={-1}
      className={`${styles.tool} ${songKey && pr.scaleHighlight ? styles.toolOn : ''}`}
      disabled={!songKey}
      onPointerDown={keepFocus}
      onClick={() => set({ scaleHighlight: !pr.scaleHighlight })}
      data-hint={
        songKey
          ? `Highlight scale ${pr.scaleHighlight ? 'on' : 'off'}: shades the rows of keys outside ${keyName} and marks its root`
          : noKey
      }
    >
      Highlight scale
    </button>
    <button
      tabIndex={-1}
      className={`${styles.tool} ${songKey && pr.scaleSnap ? styles.toolOn : ''}`}
      disabled={!songKey}
      onPointerDown={keepFocus}
      onClick={() => set({ scaleSnap: !pr.scaleSnap })}
      data-hint={
        songKey
          ? `Scale lock ${pr.scaleSnap ? 'on' : 'off'}: notes you draw, paint or drag snap to the notes of ${keyName}, so a melody cannot leave the key`
          : noKey
      }
    >
      Scale lock
    </button>
    <button
      tabIndex={-1}
      className={`${styles.tool} ${pr.chordHighlight ? styles.toolOn : ''}`}
      onPointerDown={keepFocus}
      onClick={() => set({ chordHighlight: !pr.chordHighlight })}
      data-hint={`Chord tones ${pr.chordHighlight ? 'on' : 'off'}: tints the rows of the chord track’s notes behind the notes, with each chord’s name at the top (add chords in the Chords window or the lane above the playlist)`}
    >
      Chord tones
    </button>
  </span>
  );
}

/** The chord stamp (drawing a note draws this chord) and, when one is chosen, its inversion. */
function ChordStampFields() {
  const services = useServices();
  const pr = useStore(services.editor, (s) => s.pianoRoll);
  const set = services.editor.getState().setPianoRoll;
  return (
    <>
      <label
        className={styles.field}
        data-hint="Chord stamp: clicking with the Draw or Paint tool draws this chord on the note you click (its name shows under the pointer)"
      >
        Chord stamp
        <select value={pr.chord} onChange={(e) => set({ chord: e.target.value })}>
          {STAMP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {pr.chord && (
        <label className={styles.field} data-hint="Inversion: which chord note is at the bottom">
          <select
            aria-label="Inversion"
            value={pr.inversion}
            onChange={(e) => set({ inversion: Number(e.target.value) })}
          >
            {['Root position', '1st inversion', '2nd inversion', '3rd inversion'].map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/** Shows the other channels' notes faintly behind this one. */
function GhostNotesButton() {
  const services = useServices();
  const ghosts = useStore(services.editor, (s) => s.pianoRoll.ghosts);
  const set = services.editor.getState().setPianoRoll;
  return (
  <button
    tabIndex={-1}
    className={`${styles.tool} ${ghosts ? styles.toolOn : ''}`}
    onPointerDown={keepFocus}
    onClick={() => set({ ghosts: !ghosts })}
    data-hint="Ghost notes: show the other channels’ notes faintly behind this one"
  >
    Ghost notes
  </button>
  );
}

/** Which value the lane under the grid edits (or hides it). */
function LaneField() {
  const services = useServices();
  const pr = useStore(services.editor, (s) => s.pianoRoll);
  const set = services.editor.getState().setPianoRoll;
  return (
  <label
    className={styles.field}
    data-hint="Lane: the strip under the notes. Drag in it to draw a value for each note, right-drag to reset (only the selected notes when some are selected)"
  >
    Lane
    <select
      value={pr.velocityLane ? pr.lane : 'off'}
      onChange={(e) =>
        e.target.value === 'off'
          ? set({ velocityLane: false })
          : set({ velocityLane: true, lane: e.target.value as NoteLane })
      }
    >
      <option value="off">Hidden</option>
      {NOTE_LANES.map((l) => (
        <option key={l} value={l}>
          {LANES[l].label}
        </option>
      ))}
    </select>
  </label>
  );
}

/** The zoom buttons. */
function ZoomButtons({ controller }: { controller: React.RefObject<PianoRollController | null> }) {
  return (
  <span className={styles.zoom}>
    <button
      tabIndex={-1}
      onPointerDown={keepFocus}
      onClick={() => controller.current?.zoomBy(1 / 1.4)}
      data-hint="Zoom out (or Ctrl/Cmd + wheel, or pinch)"
    >
      −
    </button>
    <button
      tabIndex={-1}
      onPointerDown={keepFocus}
      onClick={() => controller.current?.zoomBy(1.4)}
      data-hint="Zoom in (or Ctrl/Cmd + wheel, or pinch)"
    >
      +
    </button>
  </span>
  );
}

/** The follow playhead toggle. */
function FollowButton() {
  const services = useServices();
  const follow = useStore(services.prefs, (p) => p.followPlayhead);
  return (
  <button
    tabIndex={-1}
    className={`${styles.tool} ${follow ? styles.toolOn : ''}`}
    aria-pressed={follow}
    onPointerDown={keepFocus}
    onClick={() => services.commands.run('view.followPlayhead')}
    data-hint={`Follow playhead ${follow ? 'on' : 'off'}: while playing, the view scrolls along so the playhead stays in sight (scrolling by hand pauses it until the playhead is back on screen)`}
  >
    Follow
  </button>
  );
}

/** The piano roll's toolbar. */
export function Toolbar({ controller }: { controller: React.RefObject<PianoRollController | null> }) {
  const services = useServices();
  const count = useStore(services.editor, (s) => s.noteSelection.length);
  return (
    <div className={styles.toolbar}>
      <PlayPatternButton className={`${styles.tool} ${styles.playButton}`} onClassName={styles.toolOn} />
      <ToolButtons />
      <ToolsMenuButton />
      <SnapField />
      <KeyAndScaleButtons />
      <ChordStampFields />
      <GhostNotesButton />
      <LaneField />
      <ZoomButtons controller={controller} />
      <FollowButton />
      <span className={styles.selCount}>{count > 0 ? `${count} selected` : ''}</span>
    </div>
  );
}
