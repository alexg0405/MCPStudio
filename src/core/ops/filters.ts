/**
 * Draft edits behind "Sound filters" (app/filters): cutting a part of the playlist out (keeping the
 * clips as they were, so it can be put back), changing a part's tempo for a speed filter, and
 * removing a filter again. Call them inside history.transact() recipes.
 */
import type { Draft } from 'immer';
import { TEMPO_RANGE } from '../automation/targets';
import { newId } from '../model/ids';
import {
  MASTER,
  type AudioClipChannel,
  type AutoPoint,
  type ChannelId,
  type Clip,
  type ClipId,
  type InsertId,
  type Project,
  type SoundFilter,
  type Tick,
} from '../model/types';
import { BPM_MAX, BPM_MIN } from '../schema/migrate';
import { TICKS_PER_STEP, type TempoMap } from '../time/ppq';
import { createAutomationClip } from './automation';
import { removeChannel } from './channels';
import { removeInsert } from './mixer';
import { splitClip } from './playlist';

export interface CutResult {
  /** The clips as they were before the cut (whole). */
  originals: Clip[];
  /** The pieces inside [from, to) (still on the playlist: delete or keep them). */
  inside: ClipId[];
  /** New pieces left outside the part (the left piece keeps the clip's id). */
  pieces: ClipId[];
}

/**
 * Cuts the clips that `only` picks and that overlap [from, to) at the part's edges. A clip reaching
 * past an edge is split there (audio keeps its sound, patterns their content offset); the parts
 * outside stay where they are.
 */
export function cutPart(
  d: Draft<Project>,
  from: Tick,
  to: Tick,
  tempo: TempoMap,
  only: (c: Clip) => boolean,
  makeId: () => ClipId = () => newId.clip(),
): CutResult {
  const out: CutResult = { originals: [], inside: [], pieces: [] };
  for (const c of Object.values(d.playlist.clips) as Clip[]) {
    if (c.start >= to || c.start + c.length <= from || !only(c)) continue;
    out.originals.push({ ...c });
    let mid = c.id;
    if (c.start < from) {
      mid = makeId();
      splitClip(d, c.id, from, tempo, mid);
    }
    const m = d.playlist.clips[mid];
    if (m && m.start + m.length > to) {
      const right = makeId();
      splitClip(d, mid, to, tempo, right);
      out.pieces.push(right);
    }
    out.inside.push(mid);
  }
  return out;
}

const isTempoClip = (p: Project, c: Clip) => {
  if (c.kind !== 'automation') return false;
  const ch = p.channels[c.channelId];
  return ch?.kind === 'automation' && ch.target?.kind === 'tempo';
};

/** True when tempo automation clips play anywhere in the song. */
export function hasTempoAutomation(p: Project): boolean {
  return Object.values(p.playlist.clips).some((c) => !c.muted && isTempoClip(p, c));
}

const clampBpm = (v: number) => Math.min(BPM_MAX, Math.max(BPM_MIN, v));

/**
 * Plays [from, to) `factor` times faster (a speed filter): the bars stay where they are, the tempo
 * changes. The whole song without tempo automation just gets a new tempo; otherwise a tempo
 * automation clip over the part plays the old tempo curve times `factor` (tempo clips that start
 * inside the part are cut out: their originals are returned for the filter to keep), and when it
 * ends it holds the tempo the song had there, so everything after plays as before.
 */
export function changePartTempo(
  d: Draft<Project>,
  from: Tick,
  to: Tick,
  factor: number,
  before: TempoMap,
  opts: { wholeSong: boolean; name: string; color: string; makeId?: () => ClipId },
): { tempo: NonNullable<SoundFilter['tempo']>; cut: CutResult } {
  const p = d as unknown as Project;
  const none: CutResult = { originals: [], inside: [], pieces: [] };
  if (opts.wholeSong && !hasTempoAutomation(p)) {
    const bpm = d.transport.bpm;
    d.transport.bpm = Math.round(clampBpm(bpm * factor) * 1000) / 1000;
    return { tempo: { bpm }, cut: none };
  }
  // Tempo clips starting inside the part would win over the new one there ("latest start wins").
  const cut = cutPart(d, from, to, before, (c) => isTempoClip(p, c) && c.start >= from, opts.makeId);
  for (const id of cut.inside) delete d.playlist.clips[id];
  const values: { tick: Tick; bpm: number }[] = [];
  for (let t = from; t < to; t += TICKS_PER_STEP) {
    const bpm = clampBpm(before.bpmAt(t) * factor);
    if (values.at(-1)?.bpm !== bpm) values.push({ tick: t - from, bpm });
  }
  const after = before.bpmAt(to);
  const all = [...values.map((v) => v.bpm), after];
  const min = Math.max(BPM_MIN, Math.floor(Math.min(...all)) - 1);
  const max = Math.min(BPM_MAX, Math.ceil(Math.max(...all)) + 1);
  const range = min < max ? { min, max } : { ...TEMPO_RANGE };
  const norm = (bpm: number) => (bpm - range.min) / (range.max - range.min);
  const points: AutoPoint[] = [
    ...values.map((v) => ({ tick: v.tick, value: norm(v.bpm), shape: 'hold' as const })),
    { tick: to - from, value: norm(after) },
  ];
  const made = createAutomationClip(d, {
    target: { kind: 'tempo' },
    name: `Tempo · ${opts.name}`,
    color: opts.color,
    start: from,
    length: to - from,
    points,
    range,
  });
  return { tempo: { channelId: made.channelId }, cut };
}

/**
 * An insert nobody uses that a filter may borrow: named "Insert N", no effects, unity, routed only
 * to the master, nothing playing through or into it.
 */
export function emptyInsert(p: Project): InsertId | null {
  for (const id of p.mixer.order) {
    if (id === MASTER) continue;
    const ins = p.mixer.inserts[id];
    if (!ins || !/^Insert \d+$/.test(ins.name) || ins.fx.length || ins.volume !== 1 || ins.pan !== 0) continue;
    if (ins.muted || ins.solo || ins.routes.length !== 1 || ins.routes[0]!.to !== MASTER) continue;
    const used =
      Object.values(p.channels).some((c) => c.kind !== 'automation' && c.output === id) ||
      Object.values(p.mixer.inserts).some((o) => o.routes.some((r) => r.to === id) || o.fx.some((f) => f.sidechain === id));
    if (!used) return id;
  }
  return null;
}

/** The filtered channel a clip plays, if it is one. */
export function filterChannelOf(p: Project, clip: Clip | undefined): AudioClipChannel | null {
  if (!clip || clip.kind !== 'audio') return null;
  const ch = p.channels[clip.channelId];
  return ch?.kind === 'audioClip' && ch.filter ? ch : null;
}

/** Filters applied later over this filter's audio (they keep its clips as their originals). */
export function filtersOver(p: Project, channelId: ChannelId): AudioClipChannel[] {
  return Object.values(p.channels).filter(
    (c): c is AudioClipChannel =>
      c.kind === 'audioClip' &&
      c.id !== channelId &&
      !!c.filter?.originals.some((o) => o.kind === 'audio' && o.channelId === channelId),
  );
}

/** True when a kept clip can go back: its track and its pattern or channel still exist. */
function restorable(p: Project, c: Clip): boolean {
  if (!p.playlist.lanes[c.laneId]) return false;
  return c.kind === 'pattern' ? !!p.patterns[c.patternId] : !!p.channels[c.channelId];
}

/**
 * Removes a filter: deletes its audio (channel, clips, the tempo change, its mixer track or the
 * effects it put on a borrowed one) and puts the clips it replaced back as they were. Returns
 * false when the channel isn't a filter.
 */
export function removeSoundFilter(d: Draft<Project>, channelId: ChannelId): boolean {
  const ch = d.channels[channelId];
  if (ch?.kind !== 'audioClip' || !ch.filter) return false;
  const f = JSON.parse(JSON.stringify(ch.filter)) as SoundFilter;
  removeChannel(d, channelId);
  for (const id of f.pieces) delete d.playlist.clips[id];
  const p = d as unknown as Project;
  for (const o of f.originals) if (restorable(p, o)) d.playlist.clips[o.id] = { ...o } as Draft<Clip>;
  if (f.tempo && 'bpm' in f.tempo) d.transport.bpm = f.tempo.bpm;
  else if (f.tempo) removeChannel(d, f.tempo.channelId);
  if (f.insert) {
    const ins = d.mixer.inserts[f.insert.id];
    if (ins && f.insert.made) removeInsert(d, f.insert.id);
    else if (ins) {
      const slots = new Set(f.insert.slots);
      ins.fx = ins.fx.filter((x) => !slots.has(x.id));
      if (ins.fx.length === 0) ins.name = f.insert.name;
    }
  }
  return true;
}
