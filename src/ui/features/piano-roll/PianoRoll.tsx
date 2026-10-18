import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import { NOTE_LANES, type NoteLane, type PianoRollTool } from '@app/stores/editor';
import { useDoc, useServices, useSession, useView } from '../../services-context';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { PianoRollController, KEYS_WIDTH, RULER_HEIGHT, type PianoRollElements } from './controller';
import { PlayPatternButton } from '../transport/PlayPatternButton';
import { LANES } from './lanes';
import { emptyMenu, keyMenu, noteMenu, songKeyName, toolsMenu } from './menus';
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

function Toolbar({ controller }: { controller: React.RefObject<PianoRollController | null> }) {
  const services = useServices();
  const pr = useStore(services.editor, (s) => s.pianoRoll);
  const count = useStore(services.editor, (s) => s.noteSelection.length);
  const songKey = useDoc((p) => p.transport.key);
  const set = services.editor.getState().setPianoRoll;
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();
  const keyName = songKeyName(songKey);
  const follow = useStore(services.prefs, (p) => p.followPlayhead);
  const noKey = 'Choose a song key first (the Key button)';
  return (
    <div className={styles.toolbar}>
      <PlayPatternButton className={`${styles.tool} ${styles.playButton}`} onClassName={styles.toolOn} />
      <div className={styles.tools} role="toolbar">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            tabIndex={-1}
            className={`${styles.tool} ${pr.tool === t.tool ? styles.toolOn : ''}`}
            onPointerDown={keepFocus}
            onClick={() => set({ tool: t.tool })}
            data-hint={`${t.hint} (${t.key})`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <button
        tabIndex={-1}
        className={styles.tool}
        onPointerDown={keepFocus}
        onClick={(e) => menuBelow(e, toolsMenu(services))}
        data-hint="Tools: Quantize, Make legato, Humanize, Strum, Arpeggiate, Chop and more. They change the selected notes, or every note when none are selected"
      >
        Tools ▾
      </button>
      <label
        className={styles.field}
        data-hint="Snap: the grid notes are placed and moved on. Hold Alt while dragging to ignore it"
      >
        Snap
        <select value={pr.snap} onChange={(e) => set({ snap: e.target.value as Snap })}>
          {SNAP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
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
      <button
        tabIndex={-1}
        className={`${styles.tool} ${pr.ghosts ? styles.toolOn : ''}`}
        onPointerDown={keepFocus}
        onClick={() => set({ ghosts: !pr.ghosts })}
        data-hint="Ghost notes: show the other channels’ notes faintly behind this one"
      >
        Ghost notes
      </button>
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
      <span className={styles.selCount}>{count > 0 ? `${count} selected` : ''}</span>
    </div>
  );
}

export function PianoRoll() {
  const services = useServices();
  const channelId = useSession((s) => s.selectedChannelId);
  const patternId = useView((s) => s.currentPatternId);
  const isInstrument = useDoc((p) => (channelId ? p.channels[channelId]?.kind === 'instrument' : false));
  const hasNotes = useDoc((p) => !!(channelId && patternId && p.patterns[patternId]?.notes[channelId]));
  const velocityLane = useStore(services.editor, (s) => s.pianoRoll.velocityLane);
  const lane = useStore(services.editor, (s) => s.pianoRoll.lane);
  const controller = useRef<PianoRollController | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const gridHost = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLCanvasElement>(null);
  const grid = useRef<HTMLCanvasElement>(null);
  const notes = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const velocity = useRef<HTMLCanvasElement>(null);
  const velocityHost = useRef<HTMLDivElement>(null);
  const laneValue = useRef<HTMLSpanElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const hscroll = useRef<HTMLDivElement>(null);
  const hthumb = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const els = {
      area: area.current,
      gridHost: gridHost.current,
      ruler: ruler.current,
      keys: keys.current,
      grid: grid.current,
      notes: notes.current,
      overlay: overlay.current,
      velocity: velocity.current,
      velocityHost: velocityHost.current,
      laneValue: laneValue.current,
      playhead: playhead.current,
      hscroll: hscroll.current,
      hthumb: hthumb.current,
    };
    if (Object.values(els).some((el) => !el)) return;
    const c = new PianoRollController(services, els as PianoRollElements);
    c.onMenu = (request, at) =>
      showContextMenu(at, request.kind === 'note' ? noteMenu(services, request) : emptyMenu(services, request));
    controller.current = c;
    c.mount();
    return () => {
      c.unmount();
      controller.current = null;
    };
  }, [services]);

  return (
    <div className={styles.root}>
      <Toolbar controller={controller} />
      <div
        ref={area}
        className={styles.area}
        style={{
          gridTemplateColumns: `${KEYS_WIDTH}px 1fr`,
          gridTemplateRows: `${RULER_HEIGHT}px 1fr ${velocityLane ? 76 : 0}px 12px`,
        }}
      >
        <div className={styles.corner} />
        <canvas ref={ruler} className={styles.ruler} />
        <canvas ref={keys} className={styles.keys} data-hint="Click a key to hear it" />
        <div ref={gridHost} className={styles.gridHost}>
          <canvas ref={grid} className={styles.layer} />
          <canvas ref={notes} className={styles.layer} />
          <canvas ref={overlay} className={styles.layer} />
          {!isInstrument && (
            <div className={styles.empty}>Select an instrument channel in the channel rack to edit its notes.</div>
          )}
          {isInstrument && !hasNotes && (
            <div className={styles.emptyHint}>
              No notes yet. Click in the grid to draw one, or use Tools ▾ › Generate to write a melody or chords.
            </div>
          )}
        </div>
        <div
          className={styles.velocityLabel}
          data-hint={velocityLane ? `${LANES[lane].label} lane: drag to draw values, right-drag to reset` : undefined}
        >
          {velocityLane ? LANES[lane].label : ''}
          <span ref={laneValue} className={styles.laneValue} />
        </div>
        <div
          ref={velocityHost}
          className={styles.velocityHost}
          data-hint={
            velocityLane ? `${LANES[lane].label}: drag to set it for each note, right-drag to reset it` : undefined
          }
        >
          <canvas ref={velocity} className={styles.layer} />
        </div>
        <div className={styles.corner} />
        <div ref={hscroll} className={styles.hscroll}>
          <div ref={hthumb} className={styles.hthumb} />
        </div>
        <div ref={playhead} className={styles.playhead} />
      </div>
    </div>
  );
}
