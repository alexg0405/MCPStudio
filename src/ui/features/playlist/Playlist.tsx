import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import { addAudioClip, addKitAudioClip, importAudioFile } from '@app/actions/samples';
import type { PlaylistTool } from '@app/stores/editor';
import type { Services } from '@app/services';
import type { LaneId, Tick } from '@core/model/types';
import { useServices } from '../../services-context';
import { PatternPicker } from '../patterns/PatternPicker';
import { PlaylistController, type PlaylistElements } from './controller';
import { HEADER_WIDTH, RULER_HEIGHT } from './render';
import styles from './Playlist.module.css';

const TOOLS: { tool: PlaylistTool; label: string; key: string; hint: string }[] = [
  {
    tool: 'draw',
    label: 'Draw',
    key: 'P',
    hint: 'Draw: click to place the current pattern, drag clips to move, drag edges to resize',
  },
  { tool: 'paint', label: 'Paint', key: 'B', hint: 'Paint: drag to place repeats of the current pattern' },
  { tool: 'delete', label: 'Delete', key: 'D', hint: 'Delete: click or drag over clips' },
  { tool: 'slice', label: 'Slice', key: 'C', hint: 'Slice: click a clip to split it' },
  { tool: 'select', label: 'Select', key: 'E', hint: 'Select: drag a box around clips' },
];

function Toolbar({ controller }: { controller: React.RefObject<PlaylistController | null> }) {
  const services = useServices();
  const pl = useStore(services.editor, (s) => s.playlist);
  const set = services.editor.getState().setPlaylist;
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
      <span className={styles.help}>Drag on the ruler to loop a range · click it to set the song position</span>
    </div>
  );
}

export function Playlist() {
  const services = useServices();
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
    };
    if (Object.values(els).some((el) => !el)) return;
    const c = new PlaylistController(services, els as PlaylistElements);
    c.onSampleDrop = (generator, laneId, tick) => addKitAudioClip(services, generator, laneId, tick);
    c.onFilesDrop = (files, laneId, tick) => void dropAudioFiles(services, files, laneId, tick);
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
        className={styles.area}
        style={{ gridTemplateColumns: `${HEADER_WIDTH}px 1fr`, gridTemplateRows: `${RULER_HEIGHT}px 1fr 12px` }}
      >
        <div className={styles.corner} />
        <canvas
          ref={ruler}
          className={styles.ruler}
          data-hint="Drag to set a loop region, click to set the song position, double-click to clear the loop"
        />
        <canvas
          ref={headers}
          className={styles.headers}
          data-hint="Tracks: click the light to mute, right-click to solo, double-click a name to rename"
        />
        <div ref={gridHost} className={styles.gridHost}>
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
      </div>
    </div>
  );
}

/** FL behaviour: several files dropped at once go on consecutive tracks, all starting at the drop point. */
async function dropAudioFiles(s: Services, files: Promise<File[]>, laneId: LaneId, tick: Tick): Promise<void> {
  const lanes = s.doc.getState().project.playlist.laneOrder;
  let lane = lanes.indexOf(laneId);
  for (const file of await files) {
    const ref = await importAudioFile(s, file);
    const target = lanes[Math.min(lane, lanes.length - 1)];
    if (ref && target) {
      addAudioClip(s, ref, target, tick);
      lane++;
    }
  }
}
