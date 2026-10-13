import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import type { PianoRollTool } from '@app/stores/editor';
import { useDoc, useServices, useSession } from '../../services-context';
import { PianoRollController, KEYS_WIDTH, RULER_HEIGHT, type PianoRollElements } from './controller';
import styles from './PianoRoll.module.css';

const TOOLS: { tool: PianoRollTool; label: string; key: string; hint: string }[] = [
  {
    tool: 'draw',
    label: 'Draw',
    key: 'P',
    hint: 'Draw: click to add a note, drag notes to move, drag the end to resize, right-click to delete',
  },
  { tool: 'paint', label: 'Paint', key: 'B', hint: 'Paint: drag to paint a run of notes' },
  { tool: 'delete', label: 'Delete', key: 'D', hint: 'Delete: click or drag over notes to delete them' },
  { tool: 'slice', label: 'Slice', key: 'C', hint: 'Slice: click a note to split it at the grid line' },
  { tool: 'select', label: 'Select', key: 'E', hint: 'Select: drag a box to select notes' },
];

function Toolbar({ controller }: { controller: React.RefObject<PianoRollController | null> }) {
  const services = useServices();
  const pr = useStore(services.editor, (s) => s.pianoRoll);
  const count = useStore(services.editor, (s) => s.noteSelection.length);
  const set = services.editor.getState().setPianoRoll;
  return (
    <div className={styles.toolbar}>
      <div className={styles.tools} role="toolbar">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            tabIndex={-1}
            className={`${styles.tool} ${pr.tool === t.tool ? styles.toolOn : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => set({ tool: t.tool })}
            data-hint={`${t.hint} (${t.key})`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className={styles.field} data-hint="Snap: the grid notes are placed and moved on. Hold Alt to bypass it.">
        Snap
        <select value={pr.snap} onChange={(e) => set({ snap: e.target.value as Snap })}>
          {SNAP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        tabIndex={-1}
        className={`${styles.tool} ${pr.ghosts ? styles.toolOn : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => set({ ghosts: !pr.ghosts })}
        data-hint="Show other channels' notes as ghosts"
      >
        Ghosts
      </button>
      <button
        tabIndex={-1}
        className={`${styles.tool} ${pr.velocityLane ? styles.toolOn : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => set({ velocityLane: !pr.velocityLane })}
        data-hint="Show the velocity lane"
      >
        Velocity
      </button>
      <span className={styles.zoom}>
        <button
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => controller.current?.zoomBy(1 / 1.4)}
          data-hint="Zoom out (or Ctrl/Cmd + wheel, or pinch)"
        >
          −
        </button>
        <button
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => controller.current?.zoomBy(1.4)}
          data-hint="Zoom in"
        >
          +
        </button>
      </span>
      <span className={styles.selCount}>{count > 0 ? `${count} selected` : ''}</span>
    </div>
  );
}

export function PianoRoll() {
  const services = useServices();
  const channelId = useSession((s) => s.selectedChannelId);
  const isInstrument = useDoc((p) => (channelId ? p.channels[channelId]?.kind === 'instrument' : false));
  const velocityLane = useStore(services.editor, (s) => s.pianoRoll.velocityLane);
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
      playhead: playhead.current,
      hscroll: hscroll.current,
      hthumb: hthumb.current,
    };
    if (Object.values(els).some((el) => !el)) return;
    const c = new PianoRollController(services, els as PianoRollElements);
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
        <canvas ref={keys} className={styles.keys} />
        <div ref={gridHost} className={styles.gridHost}>
          <canvas ref={grid} className={styles.layer} />
          <canvas ref={notes} className={styles.layer} />
          <canvas ref={overlay} className={styles.layer} />
          {!isInstrument && (
            <div className={styles.empty}>Select an instrument channel in the channel rack to edit its notes.</div>
          )}
        </div>
        <div className={styles.velocityLabel}>{velocityLane ? 'Velocity' : ''}</div>
        <div ref={velocityHost} className={styles.velocityHost}>
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
