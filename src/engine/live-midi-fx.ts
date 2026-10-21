/**
 * MIDI effects for live notes (the piano roll keyboard, a MIDI keyboard, the typing piano): a key pressed on a channel that has
 * effects does not go straight to the instrument. It joins the notes held on that channel, the same chain the song uses
 * (`core/midi-fx`) turns the held notes into the notes to play, and those are scheduled just ahead of the audio clock.
 *
 * The chain thinks in ticks, so live play needs a clock in ticks. While the song plays it is the song's: the arpeggio lines up with
 * what is heard. While it is stopped it is a free-running one that starts with the first key pressed, so "start on key press"
 * gives a first note at once. A key's own time is "now", exactly as for a plain live note: a channel without effects pays nothing,
 * and an arpeggiator adds only the time the chain takes to run (a few microseconds), not a wait for the next step.
 */
import { activeEffects, chainReach, runChain, type ActiveFx } from '@core/midi-fx/chain';
import { createFxContext } from '@core/midi-fx/context';
import type { FxContext, FxNote } from '@core/midi-fx/types';
import type { ChannelId, MidiFxSlot, Project } from '@core/model/types';
import { symbolOf } from '@core/ops/chords';
import { chordAt } from '@core/query/chords';
import { hasActiveMidiFx } from '@core/query/midi-fx';
import { PPQ, constantTempo, ticksPerBar, type TempoMap } from '@core/time/ppq';
import type { NoteOff, NoteOn } from '@agstudio/sdk';

/**
 * Notes the effects make get ids from here up: above the live notes' own (2^30 and up), below what a 32-bit message can carry,
 * so a generated note's release can never be mistaken for a played note's.
 */
const FX_NOTE_ID_BASE = 2 ** 30 + 2 ** 29;
/** How far ahead of the audio clock the notes of live effects are scheduled (seconds): more than a timer beat (25 ms) and its jitter. */
const LOOKAHEAD_SEC = 0.07;
/** A note that starts less than this far (seconds) after now has reached the audio thread and can no longer be cancelled. */
const SAFETY_SEC = 0.01;
/** A release is put this far (seconds) after the note's start: a release at the start would cancel the note. */
const RELEASE_NUDGE_SEC = 1e-4;
/** Released keys are forgotten this long after the chain can still use them (ticks: two bars, on top of the chain's own reach). */
const FORGET_AFTER_TICKS = 2 * ticksPerBar({ num: 4, den: 4 });
/** A state with nothing held and nothing sounding is dropped once the chain's reach and this many ticks (a beat) have passed. */
const SETTLE_TICKS = PPQ;

/** What the live effects need from the engine. */
export interface LiveFxHost {
  readonly ctx: { readonly currentTime: number };
  project(): Project | null;
  /** The song's tempo map (live play is at the song's tempo). */
  tempo(): TempoMap;
  /** The song tick heard at a context time, or null while the song does not play. */
  songTickAt(time: number): number | null;
  /** The tick the stopped playhead rests on (the chord track is read there while the song is stopped). */
  restingTick(): number;
  /** Starts a note on the channel's instrument now or at `note.time` (never held back by delay compensation). */
  startNote(channelId: ChannelId, note: NoteOn): void;
  /** Ends a note (a release at or before its start cancels it). */
  endNote(channelId: ChannelId, note: NoteOff): void;
  /** Tells the app a generated note started or ended (note recording can keep these instead of the keys played). */
  report?(output: LiveFxOutput): void;
}

/** A note the effects played, as `LiveFxHost.report` says it: when it started or ended (context time). */
export interface LiveFxOutput {
  channelId: ChannelId;
  kind: 'on' | 'off';
  noteId: number;
  key: number;
  velocity: number;
  time: number;
}

/** A timer that calls back about every 25 ms while it runs (the scheduler's worker clock in the engine). */
export interface LiveFxTimer {
  start(): void;
  stop(): void;
}

/** Maps context time to ticks and back for a stretch of live play: ticks keep counting at the tempo of the moment it began. */
class LiveClock {
  constructor(
    readonly anchorTime: number,
    readonly anchorTick: number,
    readonly secondsPerTick: number,
  ) {}

  tickAt(time: number): number {
    return this.anchorTick + (time - this.anchorTime) / this.secondsPerTick;
  }

  timeAt(tick: number): number {
    return this.anchorTime + (tick - this.anchorTick) * this.secondsPerTick;
  }
}

/** A note the effects made and the instrument was given: until it has both started and been released. */
interface SentNote {
  noteId: number;
  key: number;
  velocity: number;
  /** When the note starts (context time) and at which tick. */
  startTime: number;
  startTick: number;
  /** Where it ends; Infinity while a key holds it (it is released when the key is). */
  endTick: number;
  offSent: boolean;
  /** `report` has been told it started (done once it can no longer be cancelled). */
  reportedOn: boolean;
}

/** The live state of one channel: the notes held, what was sent, and how far the chain has been run. */
interface ChannelState {
  channelId: ChannelId;
  clock: LiveClock;
  /** The chain as last seen, to notice an edit. */
  slots: readonly MidiFxSlot[] | undefined;
  active: ActiveFx[];
  /** Every key pressed lately, held or not (an echo or a latched arpeggio still needs the released ones). */
  inputs: FxNote[];
  /** The keys still down, by the id the preview gave them. */
  held: Map<number, FxNote>;
  /** What was sent, by the id the chain gave the note. */
  sent: Map<string, SentNote>;
  /** The chain has been run for everything before this tick. */
  plannedTo: number;
}

/** Live notes through a channel's MIDI effects: see the file comment. */
export class LiveMidiFx {
  private readonly states = new Map<ChannelId, ChannelState>();
  private nextNoteId = FX_NOTE_ID_BASE;

  constructor(
    private readonly host: LiveFxHost,
    private readonly timer: LiveFxTimer | null,
  ) {}

  /** True when the channel has an effect that does something, so its live notes must come through here. */
  handles(channelId: ChannelId): boolean {
    const channel = this.host.project()?.channels[channelId];
    return channel?.kind === 'instrument' && hasActiveMidiFx(channel);
  }

  /** A key goes down on a channel that `handles` it: the notes to play are worked out and the first ones start at once. */
  noteOn(channelId: ChannelId, pressId: number, key: number, velocity: number): void {
    const state = this.stateFor(channelId);
    if (!state) return;
    const now = this.host.ctx.currentTime;
    const tick = state.clock.tickAt(now);
    const note: FxNote = { id: `k${pressId}`, start: tick, end: Infinity, key, velocity };
    state.inputs.push(note);
    state.held.set(pressId, note);
    this.replan(state, now, tick);
    this.timer?.start();
  }

  /** The key goes up (at `time`, a little after the press when it was a quick tap). */
  noteOff(channelId: ChannelId, pressId: number, time: number): void {
    const state = this.states.get(channelId);
    const note = state?.held.get(pressId);
    if (!state || !note) return;
    state.held.delete(pressId);
    note.end = Math.max(note.start, state.clock.tickAt(Math.max(this.host.ctx.currentTime, time)));
    this.replan(state, this.host.ctx.currentTime, note.end);
  }

  /** The project changed: a chain edited while keys are down or an arpeggio is latched takes effect at once. */
  projectChanged(): void {
    const now = this.host.ctx.currentTime;
    for (const state of [...this.states.values()]) {
      const channel = this.host.project()?.channels[state.channelId];
      if (channel?.kind !== 'instrument' || !hasActiveMidiFx(channel)) {
        this.finish(state, now);
        continue;
      }
      if (channel.midiFx === state.slots) continue;
      state.slots = channel.midiFx;
      state.active = activeEffects(channel.midiFx);
      this.replan(state, now, state.clock.tickAt(now));
    }
  }

  /** Everything the effects are playing stops (stop, panic): held keys, echoes and latched arpeggios. */
  allNotesOff(): void {
    const now = this.host.ctx.currentTime;
    for (const state of [...this.states.values()]) this.finish(state, now);
  }

  /** The number of channels the effects are playing on (diagnostics and tests). */
  get activeChannels(): number {
    return this.states.size;
  }

  dispose(): void {
    this.allNotesOff();
    this.timer?.stop();
  }

  /** One beat of the timer: plans a little further ahead, releases what has run its length and lets finished channels go. */
  tick(): void {
    const now = this.host.ctx.currentTime;
    for (const state of [...this.states.values()]) {
      const to = state.clock.tickAt(now + LOOKAHEAD_SEC);
      if (to > state.plannedTo) this.evaluate(state, now, state.plannedTo, to);
      this.releaseDue(state, now);
      this.forget(state, now);
      if (this.isSettled(state, now)) this.finish(state, now);
    }
    if (this.states.size === 0) this.timer?.stop();
  }

  private stateFor(channelId: ChannelId): ChannelState | null {
    const existing = this.states.get(channelId);
    if (existing) return existing;
    const channel = this.host.project()?.channels[channelId];
    if (channel?.kind !== 'instrument' || !hasActiveMidiFx(channel)) return null;
    const now = this.host.ctx.currentTime;
    const songTick = this.host.songTickAt(now);
    const anchorTick = songTick ?? 0;
    const state: ChannelState = {
      channelId,
      clock: new LiveClock(now, anchorTick, this.host.tempo().secondsPerTick(anchorTick)),
      slots: channel.midiFx,
      active: activeEffects(channel.midiFx),
      inputs: [],
      held: new Map(),
      sent: new Map(),
      plannedTo: anchorTick,
    };
    this.states.set(channelId, state);
    return state;
  }

  /**
   * Something changed at `changeTick` (a key went down or up, the chain was edited): what was sent for later than the audio thread can
   * still change is taken back, and the chain is run again from the change.
   */
  private replan(state: ChannelState, now: number, changeTick: number): void {
    const safeTime = now + SAFETY_SEC;
    for (const [id, sent] of state.sent) {
      if (sent.offSent || sent.startTime < safeTime) continue;
      this.host.endNote(state.channelId, { noteId: sent.noteId, key: sent.key, time: sent.startTime });
      state.sent.delete(id);
    }
    const from = Math.min(changeTick, state.clock.tickAt(safeTime));
    const to = state.clock.tickAt(now + LOOKAHEAD_SEC);
    this.evaluate(state, now, from, to);
    this.releaseDue(state, now);
  }

  /** Runs the chain on the notes held and played lately; starts what is new from `from` on and updates how long sent notes last. */
  private evaluate(state: ChannelState, now: number, from: number, to: number): void {
    const project = this.host.project();
    if (!project) return;
    let lower = from;
    for (const sent of state.sent.values()) if (!sent.offSent) lower = Math.min(lower, sent.startTick - 1);
    const made = runChain(state.active, state.inputs, { from: lower, to }, this.contextFor(state, project));
    for (const note of made) {
      const known = state.sent.get(note.id);
      if (known) {
        if (!known.offSent) known.endTick = note.end;
        continue;
      }
      if (note.start >= from - 1e-6) this.start(state, note, now);
    }
    state.plannedTo = Math.max(state.plannedTo, to);
  }

  private start(state: ChannelState, note: FxNote, now: number): void {
    const startTime = Math.max(now, state.clock.timeAt(note.start));
    const noteId = ++this.nextNoteId;
    const on: NoteOn = { time: startTime, noteId, key: note.key, velocity: note.velocity };
    if (note.pan !== undefined) on.pan = note.pan;
    if (note.fine !== undefined) on.fine = note.fine;
    this.host.startNote(state.channelId, on);
    state.sent.set(note.id, {
      noteId,
      key: note.key,
      velocity: note.velocity,
      startTime,
      startTick: note.start,
      endTick: note.end,
      offSent: false,
      reportedOn: false,
    });
  }

  /** Releases the notes whose length has run out (or is about to, within the lookahead), and tells the app of notes that have started. */
  private releaseDue(state: ChannelState, now: number): void {
    for (const sent of state.sent.values()) {
      if (!sent.reportedOn && sent.startTime < now + SAFETY_SEC) {
        sent.reportedOn = true;
        this.host.report?.({ channelId: state.channelId, kind: 'on', noteId: sent.noteId, key: sent.key, velocity: sent.velocity, time: sent.startTime });
      }
      if (sent.offSent || !Number.isFinite(sent.endTick)) continue;
      const endTime = state.clock.timeAt(sent.endTick);
      if (endTime > now + LOOKAHEAD_SEC) continue;
      const time = Math.max(endTime, sent.startTime + RELEASE_NUDGE_SEC, now);
      sent.offSent = true;
      this.host.endNote(state.channelId, { noteId: sent.noteId, key: sent.key, time });
      if (sent.reportedOn) this.host.report?.({ channelId: state.channelId, kind: 'off', noteId: sent.noteId, key: sent.key, velocity: sent.velocity, time });
    }
  }

  /** Forgets keys released long ago and sent notes that can no longer come up in a run of the chain. */
  private forget(state: ChannelState, now: number): void {
    const nowTick = state.clock.tickAt(now);
    const reach = chainReach(state.active).after;
    const isLatched = state.active.some((effect) => effect.def.id === 'arp' && effect.values.latch === true);
    const groupStart = Math.max(...state.inputs.map((note) => note.start), -Infinity);
    // A latched arpeggio goes on from the notes of its latest group: older ones go once that group began.
    const cutoff = (isLatched ? Math.min(nowTick, groupStart) : nowTick) - reach - FORGET_AFTER_TICKS;
    state.inputs = state.inputs.filter((note) => note.end >= cutoff);
    let oldestOpen = nowTick;
    for (const sent of state.sent.values()) if (!sent.offSent) oldestOpen = Math.min(oldestOpen, sent.startTick);
    const keepFrom = Math.min(nowTick - PPQ, oldestOpen - 1);
    for (const [id, sent] of state.sent) if (sent.offSent && sent.startTick < keepFrom) state.sent.delete(id);
  }

  /** Nothing is held, nothing sounds, no arpeggio is latched and the chain's reach has run out: there is nothing more to play. */
  private isSettled(state: ChannelState, now: number): boolean {
    if (state.held.size > 0) return false;
    for (const sent of state.sent.values()) if (!sent.offSent) return false;
    if (state.active.some((effect) => effect.def.id === 'arp' && effect.values.latch === true) && state.inputs.length > 0) return false;
    const lastEnd = Math.max(...state.inputs.map((note) => note.end), -Infinity);
    return state.clock.tickAt(now) > lastEnd + chainReach(state.active).after + SETTLE_TICKS;
  }

  /** Lets a channel go: everything it still sounds is released at once and what was due later is cancelled. */
  private finish(state: ChannelState, now: number): void {
    for (const sent of state.sent.values()) {
      if (sent.offSent) continue;
      const cancelled = sent.startTime >= now + SAFETY_SEC;
      const time = cancelled ? sent.startTime : Math.max(now, sent.startTime + RELEASE_NUDGE_SEC);
      this.host.endNote(state.channelId, { noteId: sent.noteId, key: sent.key, time });
      if (sent.reportedOn && !cancelled) this.host.report?.({ channelId: state.channelId, kind: 'off', noteId: sent.noteId, key: sent.key, velocity: sent.velocity, time });
    }
    this.states.delete(state.channelId);
    if (this.states.size === 0) this.timer?.stop();
  }

  /** What the chain may look up while it runs live: the song key, the chord track where the song is, the tempo of the moment play began. */
  private contextFor(state: ChannelState, project: Project): FxContext {
    const bpm = this.host.tempo().bpmAt(state.clock.anchorTick);
    return createFxContext({
      project,
      tempo: constantTempo(bpm),
      chordAt: (tick) => {
        const songTick = this.host.songTickAt(state.clock.timeAt(tick)) ?? this.host.restingTick();
        const event = chordAt(project, songTick);
        return event ? symbolOf(event) : null;
      },
      useAutomation: false,
      channelId: state.channelId,
      slots: state.slots ?? [],
      live: true,
    });
  }
}
