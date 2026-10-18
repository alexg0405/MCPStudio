import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import type { PlaylistTool } from '@app/stores/editor';
import { useServices } from '../../services-context';
import { PatternPicker } from '../patterns/PatternPicker';
import { PlaylistController, type PlaylistElements } from './controller';
import { connectPlaylistController, registerPlaylistAnchors } from './connect';
import { askAboutSelection } from '../ask-ai/ask-state';
import { HEADER_WIDTH, RULER_HEIGHT } from './layout';
import { ChordLane, useChordLaneVisible } from '../chords/ChordLane';
import styles from './Playlist.module.css';

const TOOLS: { tool: PlaylistTool; label: string; key: string; hint: string }[] = [
  {
    tool: 'draw',
    label: 'Draw',
    key: 'P',
    hint: 'Draw: click an empty spot for a menu (place a pattern, paste, ask Studio, add a marker…), drag on one to place the current pattern; drag clips to move, drag edges to resize, right-click to delete; a clip’s ▾ opens its menu',
  },
  { tool: 'paint', label: 'Paint', key: 'B', hint: 'Paint: drag to place repeats of the current pattern' },
  { tool: 'delete', label: 'Delete', key: 'D', hint: 'Delete: click or drag over clips' },
  { tool: 'slice', label: 'Slice', key: 'C', hint: 'Slice: click a clip to split it' },
  { tool: 'select', label: 'Select', key: 'E', hint: 'Select: drag a box around clips' },
  {
    tool: 'comp',
    label: 'Comp',
    key: 'T',
    hint: 'Comp: drag across a take (open a recording’s takes with the ▸ on its comp track) to use that part of it in the comp; the comp track plays it with a short crossfade (Alt-drag on a take does the same with any tool)',
  },
];

function Toolbar({ controller }: { controller: React.RefObject<PlaylistController | null> }) {
  const services = useServices();
  const pl = useStore(services.editor, (s) => s.playlist);
  const set = services.editor.getState().setPlaylist;
  const follow = useStore(services.prefs, (p) => p.followPlayhead);
  return (
    <div className={styles.toolbar}>
      <div className={styles.tools}>
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            tabIndex={-1}
            className={`${styles.tool} ${pl.tool === t.tool ? styles.toolOn : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => set({ tool: t.tool })}
            data-hint={`${t.hint} (${t.key})`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className={styles.field} data-hint="Snap grid for clips (Alt bypasses it)">
        Snap
        <select value={pl.snap} onChange={(e) => set({ snap: e.target.value as Snap })}>
          {SNAP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <span className={styles.field} data-hint="The pattern you draw with">
        Pattern <PatternPicker compact />
      </span>
      <span className={styles.zoom}>
        <button
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => controller.current?.zoomBy(1 / 1.5)}
          data-hint="Zoom out (Ctrl/Cmd + wheel, or pinch)"
        >
          −
        </button>
        <button
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => controller.current?.zoomBy(1.5)}
          data-hint="Zoom in"
        >
          +
        </button>
      </span>
      <button
        tabIndex={-1}
        className={`${styles.tool} ${follow ? styles.toolOn : ''}`}
        aria-pressed={follow}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => services.commands.run('view.followPlayhead')}
        data-hint={`Follow playhead ${follow ? 'on' : 'off'}: while playing, the view scrolls along so the playhead stays in sight (scrolling by hand pauses it until the playhead is back on screen)`}
      >
        Follow
      </button>
      <span className={styles.help}>
        Click an empty spot for a menu · drag on the ruler to loop a range (Alt-drag: punch range) · click it to set the song position · right-click it to add a marker · the gold Ask Studio pill (or a marker's mark) asks Studio about a part
      </span>
    </div>
  );
}

/** The playlist window: the toolbar, the ruler, the track headers and the grid. The canvases are drawn by `PlaylistController`. */
export function Playlist() {
  const services = useServices();
  const tool = useStore(services.editor, (s) => s.playlist.tool);
  const controller = useRef<PlaylistController | null>(null);
  const gridHost = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLCanvasElement>(null);
  const clips = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const headers = useRef<HTMLCanvasElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const hscroll = useRef<HTMLDivElement>(null);
  const hthumb = useRef<HTMLDivElement>(null);
  const rename = useRef<HTMLInputElement>(null);
  const markerRename = useRef<HTMLInputElement>(null);
  const askPill = useRef<HTMLButtonElement>(null);
  const showChordLane = useChordLaneVisible(services);
  // The chord lane reads the playlist's scroll and zoom every frame, so its bars stay lined up with the playlist's.
  const laneView = useCallback(() => controller.current?.vp ?? null, []);

  useEffect(() => {
    const els = {
      gridHost: gridHost.current,
      grid: grid.current,
      clips: clips.current,
      overlay: overlay.current,
      headers: headers.current,
      ruler: ruler.current,
      playhead: playhead.current,
      hscroll: hscroll.current,
      hthumb: hthumb.current,
      rename: rename.current,
      markerRename: markerRename.current,
      askPill: askPill.current,
    };
    if (Object.values(els).some((el) => !el)) return;
    const c = new PlaylistController(services, els as PlaylistElements);
    connectPlaylistController(services, c);
    controller.current = c;
    c.mount();
    const offAnchor = registerPlaylistAnchors(c);
    return () => {
      offAnchor();
      c.unmount();
      controller.current = null;
    };
  }, [services]);

  return (
    <div className={styles.root}>
      <Toolbar controller={controller} />
      {showChordLane && <ChordLane view={laneView} headerWidth={HEADER_WIDTH} />}
      <div
        className={styles.area}
        style={{ gridTemplateColumns: `${HEADER_WIDTH}px 1fr`, gridTemplateRows: `${RULER_HEIGHT}px 1fr 12px` }}
      >
        <div className={styles.corner} />
        <canvas
          ref={ruler}
          className={styles.ruler}
          data-hint="Drag to set a loop region, click to set the song position, double-click to clear the loop · Alt-drag sets the punch range audio recording keeps (Alt-double-click clears it) · right-click for markers and the punch range (marker: Alt+T)"
        />
        <canvas
          ref={headers}
          className={styles.headers}
          data-hint="Tracks: click the light to mute, right-click it to solo; double-click a name to rename, right-click it for options · the ▸ on a comp track opens the takes of that recording"
        />
        <div ref={gridHost} className={styles.gridHost} data-hint={TOOLS.find((t) => t.tool === tool)?.hint}>
          <canvas ref={grid} className={styles.layer} />
          <canvas ref={clips} className={styles.layer} />
          <canvas ref={overlay} className={styles.layer} />
        </div>
        <div className={styles.corner} />
        <div ref={hscroll} className={styles.hscroll}>
          <div ref={hthumb} className={styles.hthumb} />
        </div>
        <div ref={playhead} className={styles.playhead} />
        <input ref={rename} className={styles.rename} style={{ width: HEADER_WIDTH - 30 }} />
        <input ref={markerRename} className={styles.markerRename} aria-label="Marker name" />
        {/* Its text, place and hint are set by the controller (dirty frames only). */}
        <button
          ref={askPill}
          className={styles.askPill}
          style={{ display: 'none' }}
          tabIndex={-1}
          aria-label="Ask Studio about this part"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => void askAboutSelection(services, { kind: 'pill' })}
          data-hint="Ask Studio to change this part (Alt+A): only it changes"
        />
      </div>
    </div>
  );
}
