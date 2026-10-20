import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import { ticksPerBeat } from '@core/time/ppq';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import { LyricsLaneController, LYRICS_LANE_HEIGHT, type LaneView } from './lane-controller';
import { laneMenu, wordMenu } from './lane-menu';
import styles from './LyricsLane.module.css';

/** Whether the lane is shown: the musician's choice, else whenever the project has lyrics. */
export function useLyricsLaneVisible(services: Services): boolean {
  const choice = useStore(services.editor, (state) => state.lyricsLane);
  const hasLyrics = useDoc((project) => !!project.lyrics);
  return choice ?? hasLyrics;
}

interface Props {
  /** The playlist's view (its scroll and zoom), read on every frame so the lane stays lined up with it. */
  view: () => LaneView | null;
  /** Width of the track-header column the lane's label sits in (px). */
  headerWidth: number;
}

/** The lyrics lane above the playlist: words and syllables over time, typed or dragged, lined up with the playlist's bars. */
export function LyricsLane({ view, headerWidth }: Props) {
  const services = useServices();
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canvas.current || !input.current) return;
    const controller = new LyricsLaneController(services, { canvas: canvas.current, input: input.current }, view);
    controller.onMenu = (wordId, tick, at) => {
      const word = wordId ? services.doc.getState().project.lyrics?.[wordId] : undefined;
      const beat = ticksPerBeat(services.doc.getState().project.transport.timeSig);
      const startTyping = () => controller.openInput({ tick: Math.floor(tick / beat) * beat, length: beat }, null);
      if (wordId && word) showContextMenu(at, wordMenu(services, wordId, () => controller.openInput({ tick: word.tick, length: word.length }, wordId)));
      else showContextMenu(at, laneMenu(services, tick, startTyping));
    };
    controller.mount();
    return () => controller.unmount();
  }, [services, view]);

  return (
    <div className={styles.row} style={{ height: LYRICS_LANE_HEIGHT }}>
      <div
        className={styles.head}
        style={{ width: headerWidth }}
        data-hint="The lyrics lane: words and syllables placed in song time. They show under the notes in the piano roll and the pitch editor, and the Lyrics window follows them like karaoke"
      >
        <span>Lyrics</span>
        <button
          className={styles.open}
          tabIndex={-1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void services.commands.run('view.lyrics')}
          data-hint="Open the Lyrics window: big text that follows playback, paste lyrics, export as text or LRC"
        >
          ▸
        </button>
      </div>
      <div className={styles.laneHost}>
        <canvas
          ref={canvas}
          tabIndex={0}
          className={styles.canvas}
          data-hint="Lyrics lane: click to type a word or syllable (beau-ti-ful makes three), drag across to set its length, drag a word to move it, drag its edges to resize, double-click to retype, right-click for more · Delete removes the selected word"
        />
        <input ref={input} className={styles.input} aria-label="Lyric word" placeholder="word" spellCheck={false} />
      </div>
    </div>
  );
}
