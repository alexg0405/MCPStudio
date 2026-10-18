import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { useDoc, useServices, useSession, useView } from '../../services-context';
import { showContextMenu } from '../../controls/ContextMenu';
import { PianoRollController, KEYS_WIDTH, RULER_HEIGHT, type PianoRollElements } from './controller';
import { LANES } from './lanes';
import { emptyMenu, noteMenu } from './menus';
import { Toolbar } from './PianoRollToolbar';
import styles from './PianoRoll.module.css';

/** The piano roll window: the toolbar, the keys, the grid with its notes, the event lane and the scrollbar. */
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
