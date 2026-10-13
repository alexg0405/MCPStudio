/**
 * Records live notes (MIDI keyboard, typing keyboard, on-screen piano) into patterns while record
 * mode plays: each note lands on the selected channel in the current pattern (song mode: where that
 * pattern's clip is under the playhead), at the position it was heard, its start optionally snapped
 * to the record-quantize grid. Loop recording keeps adding on every pass. A take is one undo step
 * (a History gesture; another edit in between starts a new step).
 */
import type { Gesture } from '@core/history/history';
import { newId } from '@core/model/ids';
import type { ChannelId, Note, NoteId, PatternId } from '@core/model/types';
import { patternLength } from '@core/query/queries';
import { patternTickAt } from '@core/query/playlist';
import { snapRound } from '@core/time/snap';
import type { LiveEvent } from './live-input';
import type { Recorder } from './recording';
import type { Services } from './services';

interface Pending {
  key: number;
  velocity: number;
  patternId: PatternId;
  channelId: ChannelId;
  /** Pattern tick it started at (as played). */
  tick: number;
  len: number;
}

export class NoteRecorder implements Recorder {
  readonly id = 'notes';
  private gesture: Gesture | null = null;
  private off: (() => void) | null = null;
  private readonly pending = new Map<number, Pending>();
  private hinted = false;
  /** Notes recorded in this take (for tests and the status line). */
  count = 0;

  constructor(private readonly s: Services) {}

  start(): void {
    this.stop();
    this.hinted = false;
    this.count = 0;
    this.off = this.s.live.subscribe((e) => this.onLive(e));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    // Notes still held when playback stopped: one grid step long (at least a 1/16).
    for (const p of this.pending.values()) this.write(p, p.tick + Math.max(240, this.s.prefs.getState().recordQuantize));
    this.pending.clear();
    this.gesture?.commit();
    this.gesture = null;
  }

  private onLive(e: LiveEvent): void {
    if (e.type === 'noteOn') {
      if (!e.channelId) return;
      const pos = this.position(e.time);
      if (!pos) return;
      this.pending.set(e.id, {
        key: e.key,
        velocity: e.velocity,
        patternId: pos.patternId,
        channelId: e.channelId,
        tick: pos.tick,
        len: pos.length,
      });
    } else if (e.type === 'noteOff') {
      const p = this.pending.get(e.id);
      if (!p) return;
      this.pending.delete(e.id);
      const end = this.position(e.time);
      let endTick = end && end.patternId === p.patternId ? end.tick : p.tick + 240;
      // Held across the loop's end: it wrapped around.
      if (endTick < p.tick) endTick += p.len;
      this.write(p, endTick);
    }
  }

  /** Where `time` falls in the pattern being recorded into, or null. */
  private position(time: number): { patternId: PatternId; tick: number; length: number } | null {
    const project = this.s.doc.getState().project;
    const view = this.s.view.getState();
    const patternId = view.currentPatternId;
    const pattern = patternId ? project.patterns[patternId] : undefined;
    if (!patternId || !pattern) return null;
    const length = patternLength(pattern, project.transport.timeSig);
    const { tick } = this.s.engine.tickAt(time);
    if (view.mode === 'pattern') return { patternId, tick: ((tick % length) + length) % length, length };
    const inPattern = patternTickAt(project, tick, patternId);
    if (inPattern === null) {
      if (!this.hinted) {
        this.hinted = true;
        this.s.session
          .getState()
          .toast(`Recording goes into “${pattern.name}”: put it on the playlist under the playhead, or record in pattern mode.`);
      }
      return null;
    }
    return { patternId, tick: inPattern, length };
  }

  private write(p: Pending, endTick: number): void {
    const prefs = this.s.prefs.getState();
    const grid = prefs.recordQuantize;
    const start = grid > 0 ? snapRound(p.tick, grid) % p.len : Math.round(p.tick);
    const note: Note = {
      id: newId.note(),
      tick: start,
      length: Math.max(10, Math.round(endTick - p.tick)),
      key: p.key,
      velocity: Math.max(0.01, Math.min(1, p.velocity)),
    };
    const replace = prefs.recordMode === 'replace';
    if (!this.gesture?.active) this.gesture = this.s.history.gesture('Record notes');
    this.gesture.update((d) => {
      const pattern = d.patterns[p.patternId];
      if (!pattern) return;
      const notes = (pattern.notes[p.channelId] ??= {} as never) as Record<NoteId, Note>;
      if (replace) {
        // Replace mode: the new note takes the place of notes it overlaps.
        for (const [id, n] of Object.entries(notes))
          if (n.tick < note.tick + note.length && n.tick + n.length > note.tick) delete notes[id as NoteId];
      }
      notes[note.id] = note;
    });
    this.count++;
  }
}
