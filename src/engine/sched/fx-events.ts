/**
 * A channel's MIDI effects in the schedule. Where a channel has an effect that does something, its notes do not go out as the
 * pattern holds them: the chain (`core/midi-fx`) turns them into the notes the instrument plays, and those are what the transport
 * collects, so a generated note is as sample-accurate as any other note and a re-plan sends the same ones.
 *
 * The chain is run on a block of whole pattern repetitions of a clip at a time (about 32 bars, at fixed places in the clip), with
 * a repetition of notes on either side so held notes, echoes and an arpeggio that began before the block are all seen. Because
 * a block is always evaluated the same way, a window of the song asked for in pieces, or planned again after an edit, gives the
 * same notes. The result of a block is kept until the notes, the chain, the key, the chords, the tempo or the swing change.
 */
import { activeEffects, chainReach, runChain } from '@core/midi-fx/chain';
import { createFxContext, NO_CHORDS, type ChordLookup } from '@core/midi-fx/context';
import type { FxNote } from '@core/midi-fx/types';
import type { ChannelId, InstrumentChannel, MidiFxSlot, Note, Pattern, Project } from '@core/model/types';
import { symbolOf } from '@core/ops/chords';
import { chordAt, patternChordAt, patternChords } from '@core/query/chords';
import { notesSorted, patternLength } from '@core/query/queries';
import { automationModelOf } from '@core/automation/model';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar, type TempoMap } from '@core/time/ppq';
import { swingDelay } from '@core/time/swing';
import type { EventSource, NoteEvent, PlayClip } from './events';

/** A block covers at least this many ticks of a clip (32 bars of 4/4), rounded up to whole pattern repetitions. */
const BLOCK_MIN_TICKS = 32 * ticksPerBar({ num: 4, den: 4 });
/** Rounding slack when deciding which repetition a position falls in (ticks). */
const REPETITION_EPSILON = 1e-9;
/** A pattern keeps at most this many evaluated blocks per channel (moving a clip around makes new ones); past it the oldest go. */
const MAX_BLOCKS_PER_CHANNEL = 64;
/** The id of the virtual clip pattern mode plays (see `patternModeSource`) and the prefix of the clip launcher's. */
const PATTERN_MODE_CLIP = 'pattern';
const LAUNCH_CLIP_PREFIX = 'launch:';

/** What a block's result was made from: when any of these differ the block is evaluated again. */
type BlockInputs = readonly unknown[];

interface Block {
  inputs: BlockInputs;
  events: NoteEvent[];
}

const blocks = new WeakMap<object, Map<string, Block>>();

/** True when a channel has an effect that changes its notes (one that is on, and known to this version). */
export function hasActiveFx(channel: InstrumentChannel): boolean {
  return (channel.midiFx?.length ?? 0) > 0 && activeEffects(channel.midiFx).length > 0;
}

/**
 * The events of a channel whose notes go through its effect chain, for the part [spanStart, spanEnd) of a clip: those whose start
 * (before swing) lies in it. Appends to `out`.
 */
export function collectFxNotes(
  source: EventSource,
  clip: PlayClip,
  pattern: Pattern,
  channel: InstrumentChannel,
  spanStart: number,
  spanEnd: number,
  out: NoteEvent[],
): void {
  const project = source.project;
  const patternTicks = patternLength(pattern, project.transport.timeSig);
  const repsPerBlock = Math.max(1, Math.ceil(BLOCK_MIN_TICKS / patternTicks));
  const contentStart = spanStart - clip.start + clip.offset;
  const contentEnd = spanEnd - clip.start + clip.offset;
  const firstBlock = Math.floor(Math.floor(contentStart / patternTicks) / repsPerBlock);
  const lastBlock = Math.floor(Math.floor((contentEnd - REPETITION_EPSILON) / patternTicks) / repsPerBlock);
  for (let block = firstBlock; block <= lastBlock; block++) {
    const events = blockEvents(source, clip, pattern, channel, block, repsPerBlock, patternTicks);
    for (let i = firstStartingAt(events, spanStart); i < events.length; i++) {
      const event = events[i] as NoteEvent;
      if (event.rawStart >= spanEnd) break;
      out.push(event);
    }
  }
}

/**
 * Where the note that an effect chain made, and that a transport is sounding, ends now (the project may have changed since it
 * was sent): null when the chain no longer makes it, where it was, so it must be released.
 */
export function fxNoteEnd(source: EventSource, event: NoteEvent): number | null {
  const project = source.project;
  const clip = source.clips.find((candidate) => candidate.clipId === event.clipId);
  const pattern = event.patternId ? project.patterns[event.patternId] : undefined;
  const channel = project.channels[event.channelId];
  if (!clip || !pattern || channel?.kind !== 'instrument') return null;
  const found: NoteEvent[] = [];
  collectFxNotes(source, clip, pattern, channel, event.rawStart - 1, event.rawStart + 1, found);
  const same = found.find((candidate) => candidate.fx === event.fx && Math.abs(candidate.rawStart - event.rawStart) < 1e-6);
  return same ? same.end : null;
}

/** The index of the first event starting at or after `tick` (binary search; events are sorted by start). */
function firstStartingAt(events: readonly NoteEvent[], tick: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((events[middle] as NoteEvent).rawStart < tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** One block of a clip's events for a channel, from the cache while nothing it depends on has changed. */
function blockEvents(
  source: EventSource,
  clip: PlayClip,
  pattern: Pattern,
  channel: InstrumentChannel,
  block: number,
  repsPerBlock: number,
  patternTicks: number,
): NoteEvent[] {
  const project = source.project;
  const notes = pattern.notes[channel.id];
  const tempo = source.tempo ?? tempoMapOf(project, source.mode === 'song' ? 'song' : 'pattern');
  const useAutomation = source.mode === 'song' && !clip.clipId.startsWith(LAUNCH_CLIP_PREFIX);
  const inputs: BlockInputs = [
    channel.midiFx,
    project.transport.key,
    project.transport.swing,
    project.transport.timeSig,
    project.chords,
    clip.clipId === PATTERN_MODE_CLIP ? project.playlist : null,
    tempo,
    useAutomation ? automationSignature(project, channel.id) : null,
    useAutomation,
  ];
  const cacheKey = `${clip.clipId}:${clip.start}:${clip.length}:${clip.offset}:${patternTicks}:${block}`;
  let perChannel = notes ? blocks.get(notes) : undefined;
  const cached = perChannel?.get(cacheKey);
  if (cached && sameInputs(cached.inputs, inputs)) return cached.events;
  const events = computeBlock({ source, clip, pattern, channel, block, repsPerBlock, patternTicks, tempo, useAutomation });
  if (notes) {
    if (!perChannel) blocks.set(notes, (perChannel = new Map()));
    if (perChannel.size >= MAX_BLOCKS_PER_CHANNEL) perChannel.clear();
    perChannel.set(cacheKey, { inputs, events });
  }
  return events;
}

const sameInputs = (a: BlockInputs, b: BlockInputs) => a.length === b.length && a.every((value, i) => value === b[i]);

/** The automation of this channel's effect knobs, as the things the evaluation reads (the same objects while nothing changes). */
function automationSignature(project: Project, channelId: ChannelId): unknown {
  const prefix = `mfx:${channelId}:`;
  const parts: unknown[] = [];
  for (const [key, automation] of automationModelOf(project).targets) if (key.startsWith(prefix)) parts.push(automation);
  return parts.length === 0 ? null : parts;
}

interface BlockJob {
  source: EventSource;
  clip: PlayClip;
  pattern: Pattern;
  channel: InstrumentChannel;
  block: number;
  repsPerBlock: number;
  patternTicks: number;
  tempo: TempoMap;
  useAutomation: boolean;
}

/** Runs the chain on one block and turns the result into scheduler events (swing applied last, like for every note). */
function computeBlock(job: BlockJob): NoteEvent[] {
  const { source, clip, pattern, channel, block, repsPerBlock, patternTicks } = job;
  const project = source.project;
  const active = activeEffects(channel.midiFx);
  const reach = chainReach(active);
  const clipEnd = clip.start + clip.length;
  const origin = clip.start - clip.offset;
  const firstRep = Math.floor(clip.offset / patternTicks);
  const lastRep = Math.floor((clip.length + clip.offset - REPETITION_EPSILON) / patternTicks);
  const blockFirstRep = block * repsPerBlock;
  const blockLastRep = blockFirstRep + repsPerBlock - 1;
  const lookbackReps = Math.ceil(reach.after / patternTicks) + 1;
  const lookaheadReps = Math.ceil(reach.before / patternTicks) + 1;
  const input = fxInput(project, clip, channel.id, pattern, {
    origin,
    clipEnd,
    patternTicks,
    from: Math.max(firstRep, blockFirstRep - lookbackReps),
    to: Math.min(lastRep, blockLastRep + lookaheadReps),
  });
  // The first block also wants notes a humanize moved a little before the clip's start; they are put back on it below.
  const span = {
    from: blockFirstRep <= firstRep ? clip.start - reach.before - 1 : origin + blockFirstRep * patternTicks,
    to: Math.min(clipEnd, origin + (blockLastRep + 1) * patternTicks),
  };
  const context = createFxContext({
    project,
    tempo: job.tempo,
    chordAt: chordLookupFor(project, clip, pattern, patternTicks),
    useAutomation: job.useAutomation,
    channelId: channel.id,
    slots: channel.midiFx as readonly MidiFxSlot[],
  });
  return runChain(active, input, span, context).map((note) => eventFor(note, { project, clip, pattern, channel, origin, patternTicks, clipEnd }));
}

/** The channel's notes of the repetitions [from, to] of the pattern as notes on the clip's timeline (unswung, cut at the clip's end). */
function fxInput(
  project: Project,
  clip: PlayClip,
  channelId: ChannelId,
  pattern: Pattern,
  where: { origin: number; clipEnd: number; patternTicks: number; from: number; to: number },
): FxNote[] {
  const notes = notesSorted(pattern.notes[channelId]);
  const input: FxNote[] = [];
  for (let rep = where.from; rep <= where.to; rep++) {
    for (const note of notes) {
      if (note.muted) continue;
      const start = where.origin + rep * where.patternTicks + note.tick;
      // The same notes the plain path plays: none before the clip's start, none at or after its end.
      if (start < clip.start || start >= where.clipEnd) continue;
      input.push(fxNoteOf(note, `${note.id}:${rep}`, start, Math.min(start + note.length, where.clipEnd)));
    }
  }
  return input;
}

function fxNoteOf(note: Note, id: string, start: number, end: number): FxNote {
  const fx: FxNote = { id, start, end, key: note.key, velocity: note.velocity };
  if (note.pan !== undefined) fx.pan = note.pan;
  if (note.fine !== undefined) fx.fine = note.fine;
  if (note.release !== undefined) fx.release = note.release;
  return fx;
}

/** Where the effects find the chord track for a clip: song ticks for a song clip, the pattern's own place for pattern mode, none for the launcher. */
function chordLookupFor(project: Project, clip: PlayClip, pattern: Pattern, patternTicks: number): ChordLookup {
  if (clip.clipId.startsWith(LAUNCH_CLIP_PREFIX)) return NO_CHORDS;
  if (clip.clipId === PATTERN_MODE_CLIP) {
    const chords = patternChords(project, pattern.id, patternTicks);
    return (tick) => patternChordAt(chords, ((tick % patternTicks) + patternTicks) % patternTicks)?.chord ?? null;
  }
  return (tick) => {
    const event = chordAt(project, tick);
    return event ? symbolOf(event) : null;
  };
}

interface EventPlace {
  project: Project;
  clip: PlayClip;
  pattern: Pattern;
  channel: InstrumentChannel;
  origin: number;
  patternTicks: number;
  clipEnd: number;
}

/** The scheduler event for a note the chain made: a note that started before the clip is moved onto its start, the swing is added last. */
function eventFor(note: FxNote, place: EventPlace): NoteEvent {
  const { project, clip, pattern, channel, origin, patternTicks, clipEnd } = place;
  const rawStart = Math.max(note.start, clip.start);
  const length = Math.max(1, note.end - note.start);
  const positionInPattern = (((rawStart - origin) % patternTicks) + patternTicks) % patternTicks;
  const start = rawStart + swingDelay(positionInPattern, project.transport.swing);
  const event: NoteEvent = {
    kind: 'note',
    key: `${clip.clipId}:fx:${note.id}`,
    clipId: clip.clipId,
    channelId: channel.id,
    patternId: pattern.id,
    noteId: null,
    fx: note.id,
    clipEnd,
    rawStart,
    start,
    end: Math.min(start + length, clipEnd),
    pitch: note.key,
    velocity: note.velocity,
  };
  if (note.pan !== undefined) event.pan = note.pan;
  if (note.fine !== undefined) event.fine = note.fine;
  if (note.release !== undefined) event.release = note.release;
  return event;
}
