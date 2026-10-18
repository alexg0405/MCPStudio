import type { ChannelId } from '@core/model/types';
import type { NoteOff, NoteOn } from '@agstudio/sdk';
import type { ChannelStrip } from './channel-strip';
import type { NoteFeedHub } from './note-feed';
import type { AudioOn, TransportSink } from './sched/transport';

/**
 * Where the transport's events go: the channel strips, each held back by the mixer's delay compensation.
 *
 * The song's events reach a channel `strip.shift` seconds late (the compensation is done in time instead of with delay
 * lines: see ChannelStrip.shift), and the note feed (what melody-following effects hear) gets them unshifted, as the
 * song schedules them. Previews and live input go to the strips directly and are never held back.
 */
export class SongNoteSink implements TransportSink {
  /**
   * The shift (seconds) each song note was dispatched with, until its release. A note's release, or its cancellation by
   * a re-plan, must carry the shift its start did even if the compensation changed meanwhile: a release earlier than
   * the start cancels the note, and a later one would let it sound for the difference.
   */
  private readonly shiftOfNote = new Map<number, number>();

  constructor(
    private readonly strips: ReadonlyMap<ChannelId, ChannelStrip>,
    private readonly noteFeed: NoteFeedHub,
  ) {}

  noteOn(channelId: ChannelId, note: NoteOn): void {
    this.noteFeed.emit(channelId, {
      kind: 'on',
      time: note.time,
      noteId: note.noteId,
      key: note.key,
      velocity: note.velocity,
    });
    const strip = this.strips.get(channelId);
    if (!strip) return;
    const shift = strip.shift;
    if (shift === 0) return strip.noteOn(note);
    this.shiftOfNote.set(note.noteId, shift);
    strip.noteOn({ ...note, time: note.time + shift });
  }

  audioOn(channelId: ChannelId, clip: AudioOn): void {
    const strip = this.strips.get(channelId);
    if (!strip) return;
    const shift = strip.shift;
    if (shift === 0) return strip.audioOn(clip);
    this.shiftOfNote.set(clip.noteId, shift);
    strip.audioOn({ ...clip, time: clip.time + shift });
  }

  noteOff(channelId: ChannelId, note: NoteOff): void {
    const defaultReleaseVelocity = 0.5;
    this.noteFeed.emit(channelId, {
      kind: 'off',
      time: note.time,
      noteId: note.noteId,
      key: note.key,
      velocity: note.release ?? defaultReleaseVelocity,
    });
    const shift = this.shiftOfNote.get(note.noteId);
    if (shift === undefined) return this.strips.get(channelId)?.noteOff(note);
    this.shiftOfNote.delete(note.noteId);
    this.strips.get(channelId)?.noteOff({ ...note, time: note.time + shift });
  }

  allNotesOff(time: number): void {
    this.noteFeed.emitAllOff(time);
    // Everything not yet started goes, whatever shift it has (they are all at or after `time`).
    this.shiftOfNote.clear();
    for (const strip of this.strips.values()) strip.allNotesOff(time);
  }
}
