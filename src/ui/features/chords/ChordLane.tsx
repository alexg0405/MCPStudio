import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import { ticksPerBar } from '@core/time/ppq';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import { ChordLaneController, CHORD_LANE_HEIGHT, type LaneView } from './lane-controller';
import { chordMenu, laneMenu } from './lane-menu';
import styles from './ChordLane.module.css';

/** Whether the lane is shown: the musician's choice, else whenever the project has chords. */
export function useChordLaneVisible(services: Services): boolean {
  const choice = useStore(services.editor, (state) => state.chordLane);
  const hasChords = useDoc((project) => !!project.chords);
  return choice ?? hasChords;
}

interface Props {
  /** The playlist's view (its scroll and zoom), read on every frame so the lane stays lined up with it. */
  view: () => LaneView | null;
  /** Width of the track-header column the lane's label sits in (px). */
  headerWidth: number;
}

/** The chord lane above the playlist: chords over time, typed or dragged, lined up with the playlist's bars. */
export function ChordLane({ view, headerWidth }: Props) {
  const services = useServices();
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canvas.current || !input.current) return;
    const controller = new ChordLaneController(services, { canvas: canvas.current, input: input.current }, view);
    controller.onMenu = (chordId, tick, at) => {
      const event = chordId ? services.doc.getState().project.chords?.[chordId] : undefined;
      const bar = ticksPerBar(services.doc.getState().project.transport.timeSig);
      const startTyping = () => controller.openInput({ tick: Math.floor(tick / bar) * bar, length: bar }, null);
      if (chordId && event) {
        showContextMenu(at, chordMenu(services, chordId, tick, () => controller.openInput({ tick: event.tick, length: event.length }, chordId)));
      } else showContextMenu(at, laneMenu(services, tick, startTyping));
    };
    controller.mount();
    return () => controller.unmount();
  }, [services, view]);

  return (
    <div className={styles.row} style={{ height: CHORD_LANE_HEIGHT }}>
      <div
        className={styles.head}
        style={{ width: headerWidth }}
        data-hint="The chord track: the song’s harmony. Chord parts, basslines and melodies are written against it, and the piano roll shows it behind the notes"
      >
        <span>Chords</span>
        <button
          className={styles.open}
          tabIndex={-1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void services.commands.run('view.chords')}
          data-hint="Open the Chords window: progressions by mood and genre, detect chords, make chords, a bassline and a melody that fit"
        >
          ▸
        </button>
      </div>
      <div className={styles.laneHost}>
        <canvas
          ref={canvas}
          tabIndex={0}
          className={styles.canvas}
          data-hint="Chord lane: click to type a chord (Am7, F/C), drag across to draw one, drag a chord to move it, drag its edges to resize, double-click to retype, right-click for more · Delete removes the selected chord"
        />
        <input ref={input} className={styles.input} aria-label="Chord name" placeholder="Am7" spellCheck={false} />
      </div>
    </div>
  );
}
