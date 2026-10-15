/**
 * Notes as the arranger works on them: a pattern's notes as plain sorted arrays per channel (no ids,
 * so a variant can be compared with what it was built from), a content hash, and the notes the
 * playlist actually plays in song mode. Plain loops only: these run on drafts inside edits.
 */
import { newId } from '../model/ids';
import type { ChannelId, ClipId, LaneId, Note, NoteId, Pattern, PatternId, Project, Tick } from '../model/types';
import { mutedLanes } from '../query/playlist';
import { patternLength } from '../query/queries';
import { hashString } from './random';

/** A note without its id. */
export type WorkNote = Omit<Note, 'id'>;

/** A pattern's notes by channel, each list sorted by tick then key. */
export type NoteSet = Map<ChannelId, WorkNote[]>;

const byTime = (a: WorkNote, b: WorkNote) => a.tick - b.tick || a.key - b.key || a.length - b.length;

/** A copy of a pattern's notes as a NoteSet. */
export function toNoteSet(notes: Pattern['notes']): NoteSet {
  const set: NoteSet = new Map();
  for (const cid of Object.keys(notes).sort()) {
    const byId = notes[cid as ChannelId];
    if (!byId) continue;
    const list: WorkNote[] = [];
    for (const n of Object.values(byId) as Note[]) {
      const { id: _id, ...rest } = n;
      list.push({ ...rest });
    }
    if (list.length) set.set(cid as ChannelId, list.sort(byTime));
  }
  return set;
}

/** A NoteSet as pattern notes, with fresh note ids (channels without notes are left out). */
export function toNoteMap(set: NoteSet): Pattern['notes'] {
  const out: Pattern['notes'] = {};
  for (const [cid, list] of set) {
    if (!list.length) continue;
    const byId: Record<NoteId, Note> = {};
    for (const n of [...list].sort(byTime)) {
      const id = newId.note();
      byId[id] = { id, ...n };
    }
    out[cid] = byId;
  }
  return out;
}

export function cloneSet(set: NoteSet): NoteSet {
  const out: NoteSet = new Map();
  for (const [cid, list] of set) out.set(cid, list.map((n) => ({ ...n })));
  return out;
}

/** The notes of a channel in the set (created when missing). */
export function listOf(set: NoteSet, cid: ChannelId): WorkNote[] {
  let list = set.get(cid);
  if (!list) set.set(cid, (list = []));
  return list;
}

/** Sorts every list and drops empty ones. */
export function tidySet(set: NoteSet): NoteSet {
  for (const [cid, list] of [...set]) {
    if (!list.length) set.delete(cid);
    else list.sort(byTime);
  }
  return set;
}

const noteText = (n: WorkNote) =>
  `${n.tick},${n.length},${n.key},${Math.round(n.velocity * 10000)},${n.muted ? 1 : 0},${n.pan ?? ''},${n.fine ?? ''},${n.release ?? ''}`;

/** A content hash of a NoteSet (ids don't count). */
export function setHash(set: NoteSet): string {
  const parts: string[] = [];
  let count = 0;
  for (const cid of [...set.keys()].sort()) {
    const list = [...(set.get(cid) ?? [])].sort(byTime);
    if (!list.length) continue;
    count += list.length;
    parts.push(`${cid}:${list.map(noteText).join(';')}`);
  }
  const text = parts.join('|');
  return `${hashString(text).toString(36)}${hashString(`${text}#`).toString(36)}-${count}`;
}

/** A content hash of a pattern's notes (ids don't count). */
export function notesHash(notes: Pattern['notes']): string {
  return setHash(toNoteSet(notes));
}

/** Notes starting in [from, to). */
export const startsIn = (n: WorkNote, from: Tick, to: Tick): boolean => n.tick >= from && n.tick < to;

/** Removes the notes matching `drop`; returns how many went. */
export function removeWhere(list: WorkNote[], drop: (n: WorkNote) => boolean): number {
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (!drop(n)) list[w++] = n;
  }
  const removed = list.length - w;
  list.length = w;
  return removed;
}

/** Notes that started before `at` and still sound there end at `at`. */
export function cutHeldAt(list: WorkNote[], at: Tick, which: (n: WorkNote) => boolean = () => true): void {
  for (const n of list) if (n.tick < at && n.tick + n.length > at && which(n)) n.length = Math.max(1, at - n.tick);
}

/** A pattern's length, safe on drafts (the memoized query would keep a stale answer). */
export const lengthOfPattern = (p: Project, pid: PatternId): Tick =>
  p.patterns[pid] ? patternLength({ ...p.patterns[pid]! }, p.transport.timeSig) : 0;

/** A note as the playlist plays it in song mode. */
export interface PlayedNote {
  /** Song tick. */
  tick: Tick;
  /** Cut where the clip ends or the pattern loops. */
  length: Tick;
  channelId: ChannelId;
  key: number;
  velocity: number;
  clipId: ClipId;
  laneId: LaneId;
  patternId: PatternId;
}

/** Channels that make no sound: muted, or left out by a solo (automation channels don't count). */
export function silentChannels(p: Project): Set<ChannelId> {
  const out = new Set<ChannelId>();
  let anySolo = false;
  for (const ch of Object.values(p.channels)) if (ch.kind !== 'automation' && ch.solo) anySolo = true;
  for (const ch of Object.values(p.channels)) if (ch.kind !== 'automation' && (ch.muted || (anySolo && !ch.solo))) out.add(ch.id);
  return out;
}

/**
 * The notes song mode plays that start in [from, to) (muted clips, tracks and channels left out),
 * in song order.
 */
export function playedNotes(p: Project, from: Tick = 0, to: Tick = Infinity): PlayedNote[] {
  const out: PlayedNote[] = [];
  const lanesOff = mutedLanes(p.playlist);
  const silent = silentChannels(p);
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || c.muted || lanesOff.has(c.laneId)) continue;
    const pat = p.patterns[c.patternId];
    if (!pat) continue;
    if (c.start >= to || c.start + c.length <= from) continue;
    const len = lengthOfPattern(p, c.patternId);
    if (len <= 0) continue;
    for (const [cid, byId] of Object.entries(pat.notes) as [ChannelId, Record<NoteId, Note>][]) {
      if (!byId || silent.has(cid) || !p.channels[cid]) continue;
      for (const n of Object.values(byId)) {
        if (n.muted || n.tick >= len) continue;
        // Local clip times where this note plays: n.tick - offset + k·len, inside the clip.
        let t = n.tick - (c.offset % len);
        while (t < 0) t += len;
        for (; t < c.length; t += len) {
          const tick = c.start + t;
          if (tick < from) continue;
          if (tick >= to) break;
          const length = Math.max(1, Math.min(n.length, len - n.tick, c.length - t));
          out.push({ tick, length, channelId: cid, key: n.key, velocity: n.velocity, clipId: c.id, laneId: c.laneId, patternId: c.patternId });
        }
      }
    }
  }
  return out.sort((a, b) => a.tick - b.tick || a.key - b.key || (a.channelId < b.channelId ? -1 : 1));
}
