import type { ChannelId, Project } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import type { ChannelStrip } from './channel-strip';
import { LiveMidiFx, type LiveFxOutput, type LiveFxTimer } from './live-midi-fx';
import type { NoteFeedHub } from './note-feed';

/** The release velocity a generated note reports to the note feed (0 to 1). */
const DEFAULT_RELEASE_VELOCITY = 0.5;

/** What the live MIDI effects are given by the engine. */
export interface LiveFxLinkDeps {
  ctx: { readonly currentTime: number };
  strips: ReadonlyMap<ChannelId, ChannelStrip>;
  noteFeed: NoteFeedHub;
  project(): Project | null;
  tempoMap(): TempoMap;
  /** The song tick heard at a context time, or null while the song does not play. */
  songTickAt(time: number): number | null;
  /** The tick the stopped playhead rests on. */
  restingTick(): number;
  /** The timer that runs the effects ahead of the clock; null where there is none (offline engines never play live). */
  timer: LiveFxTimer | null;
  /** A generated note started or ended (note recording listens). */
  report(output: LiveFxOutput): void;
}

/**
 * Connects the live MIDI effects to the engine: the notes they make go to the channel strips directly, as any live note does
 * (never held back by delay compensation), and to the note feed that effects following a melody listen to.
 */
export function createLiveMidiFx(deps: LiveFxLinkDeps): LiveMidiFx {
  return new LiveMidiFx(
    {
      ctx: deps.ctx,
      project: deps.project,
      tempo: deps.tempoMap,
      songTickAt: deps.songTickAt,
      restingTick: deps.restingTick,
      startNote(channelId, note) {
        deps.noteFeed.emit(channelId, { kind: 'on', time: note.time, noteId: note.noteId, key: note.key, velocity: note.velocity });
        deps.strips.get(channelId)?.noteOn(note);
      },
      endNote(channelId, note) {
        deps.noteFeed.emit(channelId, { kind: 'off', time: note.time, noteId: note.noteId, key: note.key, velocity: note.release ?? DEFAULT_RELEASE_VELOCITY });
        deps.strips.get(channelId)?.noteOff(note);
      },
      report: deps.report,
    },
    deps.timer,
  );
}
