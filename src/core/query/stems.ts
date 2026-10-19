/**
 * Stem export planning: one stem per mixer track that has sound playing into it in the exported
 * range (plus one for channels that play straight into the master). A stem is the full song
 * rendered with only that track's channels heard, through everything downstream of it (its sends
 * and buses, the master), so for linear effects the stems add up to the mix exactly.
 *
 * Other tracks are silenced with their insert mute where possible: the mute gate sits after the
 * effects and the sidechain tap, so a kick muted out of the bass stem still ducks the bass. A track
 * that is downstream of the stem's track (a bus it sends to) can't be muted, so only its own channels
 * are.
 */
import { produce } from 'immer';
import { MASTER, type ChannelId, type InsertId, type PatternId, type Project, type Tick } from '../model/types';
import { effectivelyMutedInserts } from './mixer';
import { audibleClips } from './playlist';
import { effectivelyMuted } from './queries';
import { playableEdges } from './routing';

/** The range a stem export covers: the whole song or one pattern, with its span in ticks. */
export interface StemRange {
  mode: 'song' | 'pattern';
  patternId: PatternId | null;
  fromTick: Tick;
  toTick: Tick;
}

/** One stem to export: the mixer track it is for, a file name for it and the channels heard in it. */
export interface StemPlan {
  /** The mixer track whose sound it is (MASTER: channels that play straight into the master). */
  insertId: InsertId;
  /** File-name friendly label: "03 Drums", "00 Master". */
  name: string;
  channels: ChannelId[];
}

/** The channel's mixer track as the engine plays it (a missing insert plays through the master). */
export function channelTrack(project: Project, channelId: ChannelId): InsertId {
  const ch = project.channels[channelId];
  if (!ch || ch.kind === 'automation') return MASTER;
  return project.mixer.inserts[ch.output] ? ch.output : MASTER;
}

function hasNotes(project: Project, patternId: PatternId, channelId: ChannelId): boolean {
  const notes = project.patterns[patternId]?.notes[channelId];
  return !!notes && Object.values(notes).some((n) => !n.muted);
}

/** Channels that make sound in the range (content there, not muted or left out by a solo). */
export function playingChannels(project: Project, range: StemRange): Set<ChannelId> {
  const out = new Set<ChannelId>();
  const muted = effectivelyMuted(project.channels);
  const add = (id: ChannelId) => {
    const ch = project.channels[id];
    if (ch && ch.kind !== 'automation' && !muted.has(id)) out.add(id);
  };
  if (range.mode === 'pattern') {
    const pid = range.patternId;
    if (pid) for (const id of project.channelOrder) if (hasNotes(project, pid, id)) add(id);
  } else {
    for (const clip of audibleClips(project)) {
      if (clip.start >= range.toTick || clip.start + clip.length <= range.fromTick) continue;
      if (clip.kind === 'audio') add(clip.channelId);
      else if (clip.kind === 'pattern')
        for (const id of project.channelOrder) if (hasNotes(project, clip.patternId, id)) add(id);
    }
  }
  // Tracks that are muted, left out by a solo, or route nowhere audible are silent.
  const silent = silentTracks(project);
  for (const id of [...out]) if (silent.has(channelTrack(project, id))) out.delete(id);
  return out;
}

/** Inserts whose sound doesn't reach the speakers (muted, solo-ed out, or no audible route). */
function silentTracks(project: Project): Set<InsertId> {
  const inserts = project.mixer.inserts;
  const muted = effectivelyMutedInserts(inserts);
  const out = new Set<InsertId>();
  if (inserts[MASTER]?.muted) {
    for (const id of Object.keys(inserts) as InsertId[]) out.add(id);
    return out;
  }
  const routes = playableEdges(project.mixer).filter((e) => e.kind === 'route');
  const reaches = (from: InsertId, seen = new Set<InsertId>()): boolean => {
    if (from === MASTER) return true;
    if (seen.has(from) || muted.has(from)) return false;
    seen.add(from);
    return routes.some((e) => e.from === from && reaches(e.to, seen));
  };
  for (const id of Object.keys(inserts) as InsertId[]) if (id !== MASTER && !reaches(id)) out.add(id);
  return out;
}

const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Track';

/** The stems an export of `range` makes, in mixer order. */
export function planStems(project: Project, range: StemRange): StemPlan[] {
  const byTrack = new Map<InsertId, ChannelId[]>();
  const playing = playingChannels(project, range);
  for (const id of project.channelOrder) {
    if (!playing.has(id)) continue;
    const track = channelTrack(project, id);
    const list = byTrack.get(track);
    if (list) list.push(id);
    else byTrack.set(track, [id]);
  }
  const order = project.mixer.order;
  const stems: StemPlan[] = [];
  for (const [index, id] of order.entries()) {
    const channels = byTrack.get(id);
    if (!channels) continue;
    const ins = project.mixer.inserts[id];
    const label = id === MASTER ? 'Master' : (ins?.name ?? `Insert ${index}`);
    stems.push({ insertId: id, name: `${String(index).padStart(2, '0')} ${fileSafe(label)}`, channels });
  }
  return stems;
}

/** Inserts that `from`'s sound passes through on its way to the master (its sends, buses). */
export function downstreamOf(project: Project, from: InsertId): Set<InsertId> {
  const routes = playableEdges(project.mixer).filter((e) => e.kind === 'route');
  const out = new Set<InsertId>();
  const stack = [from];
  while (stack.length) {
    const at = stack.pop() as InsertId;
    for (const e of routes)
      if (e.from === at && !out.has(e.to)) {
        out.add(e.to);
        stack.push(e.to);
      }
  }
  return out;
}

/** The master insert's effects bypassed and its fader and pan neutral. */
export function withoutMasterChain(project: Project): Project {
  return produce(project, (d) => {
    const m = d.mixer.inserts[MASTER];
    if (!m) return;
    m.volume = 1;
    m.pan = 0;
    for (const slot of m.fx) slot.enabled = false;
  });
}

/** The project as it renders for one stem: only the stem's channels heard (see the file comment). */
export function stemProject(project: Project, stems: readonly StemPlan[], stem: StemPlan): Project {
  const keep = new Set(stem.channels);
  const down = downstreamOf(project, stem.insertId);
  return produce(project, (d) => {
    for (const other of stems) {
      if (other === stem) continue;
      const insert = d.mixer.inserts[other.insertId];
      if (other.insertId !== MASTER && insert && !down.has(other.insertId)) insert.muted = true;
      else
        for (const id of other.channels) {
          const ch = d.channels[id];
          if (ch && !keep.has(id)) ch.muted = true;
        }
    }
  });
}
