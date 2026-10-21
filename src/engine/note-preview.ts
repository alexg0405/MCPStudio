import type { ChannelId } from '@core/model/types';
import type { ChannelStrip } from './channel-strip';
import type { LiveMidiFx } from './live-midi-fx';
import type { NoteFeedHub } from './note-feed';
import type { OutputClock } from './output-clock';

/**
 * Live notes get ids from here up, far above any note id the document or the transport hands out, so a live note's
 * release can never be mistaken for a song note's.
 */
const LIVE_NOTE_ID_BASE = 2 ** 30;
/** The velocity of a live note played without one (0 to 1). */
const DEFAULT_LIVE_VELOCITY = 0.8;
/** The release velocity a live note reports to the note feed (0 to 1). */
const DEFAULT_RELEASE_VELOCITY = 0.5;

/** What live notes need from the engine. */
export interface NotePreviewHost {
  readonly ctx: BaseAudioContext;
  readonly strips: ReadonlyMap<ChannelId, ChannelStrip>;
  readonly noteFeed: NoteFeedHub;
  readonly clock: OutputClock;
  /** The MIDI effects live notes go through on channels that have them; absent offline. */
  readonly midiFx?: LiveMidiFx | null;
  /** Starts the context if the browser's autoplay policy left it suspended. */
  resume(): Promise<void>;
}

/**
 * Notes played live (the piano roll keyboard, MIDI input, the channel's test key): they go to the channel's strip
 * straight away, never held back by the mixer's delay compensation, and feed the same note feed as song notes. On a channel
 * that has MIDI effects the key goes to them instead, and what they make is what the strip plays.
 */
export class NotePreview {
  private nextNoteId = LIVE_NOTE_ID_BASE;
  /** Press time of each live note until its release. */
  private readonly pressedAt = new Map<number, number>();
  /** The keys that went to the MIDI effects (not to the strip), until their release. */
  private readonly throughEffects = new Set<number>();

  constructor(private readonly host: NotePreviewHost) {}

  /** Starts a note now; returns its id for `noteOff`. */
  noteOn(channelId: ChannelId, key: number, velocity = DEFAULT_LIVE_VELOCITY): number {
    void this.host.resume();
    const noteId = ++this.nextNoteId;
    const time = this.host.ctx.currentTime;
    this.pressedAt.set(noteId, time);
    const effects = this.host.midiFx;
    if (effects?.handles(channelId)) {
      this.throughEffects.add(noteId);
      effects.noteOn(channelId, noteId, key, velocity);
      return noteId;
    }
    this.host.noteFeed.emit(channelId, { kind: 'on', time, noteId, key, velocity });
    this.host.strips.get(channelId)?.noteOn({ time, noteId, key, velocity });
    return noteId;
  }

  /**
   * Releases a live note. A quick tap's release is held back until the sound has started (see
   * OutputClock.previewHold), or it could cancel the note it belongs to.
   */
  noteOff(channelId: ChannelId, noteId: number): void {
    const pressedAt = this.pressedAt.get(noteId);
    this.pressedAt.delete(noteId);
    const now = this.host.ctx.currentTime;
    const time = pressedAt === undefined ? now : Math.max(now, pressedAt + this.host.clock.previewHold());
    if (this.throughEffects.delete(noteId)) {
      this.host.midiFx?.noteOff(channelId, noteId, time);
      return;
    }
    this.host.noteFeed.emit(channelId, { kind: 'off', time, noteId, key: 0, velocity: DEFAULT_RELEASE_VELOCITY });
    this.host.strips.get(channelId)?.noteOff({ time, noteId, key: 0 });
  }

  /** A live MIDI control change for the channel's instrument (value 0 to 1). */
  controlChange(channelId: ChannelId, controller: number, value: number): void {
    this.host.strips.get(channelId)?.controlChange(controller, value, this.host.ctx.currentTime);
  }

  /** Live MIDI pitch bend for the channel, in cents. */
  pitchBend(channelId: ChannelId, cents: number): void {
    this.host.strips.get(channelId)?.setBend(cents, this.host.ctx.currentTime);
  }
}
