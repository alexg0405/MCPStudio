/**
 * Sound filters (Nightcore, Telephone, Lo-fi…; presets in core/filters): a part of the song is
 * rendered to audio (effects, automation and all, like Consolidate) and plays instead of the clips
 * it replaced, through the filter: a speed (a resample: faster is higher), a reverse, and a mixer
 * track with the filter's effects (still editable there). One undo step; the replaced clips are
 * kept in the new channel's `filter` record, so "Remove filter" puts them back exactly.
 *
 * A speed filter changes the tempo of the part instead of moving clips: the bars stay where they
 * are (everything after still starts on its bar), the part simply plays faster or slower, so the
 * song gets shorter or longer. Nothing overlaps and no gap opens.
 */
import { current, produce, type Draft } from 'immer';
import { tempoMapOf } from '@core/automation/tempo';
import { naturalLength, playbackMode } from '@core/audio/playback';
import { findFilter, speedCents, speedOf, type FilterPreset } from '@core/filters/presets';
import { filterPart, targetLabel, type FilterTarget } from '@core/filters/target';
import { makeInsert, makeLane, makePluginInstance, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type ChannelId,
  type Clip,
  type ClipId,
  type InsertId,
  type LaneId,
  type PluginInstance,
  type Project,
  type SlotId,
  type SoundFilter,
  type Tick,
} from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { changePartTempo, cutPart, emptyInsert, filtersOver, removeSoundFilter } from '@core/ops/filters';
import { addFxSlot, addInsert } from '@core/ops/mixer';
import { addClips, addLane } from '@core/ops/playlist';
import { freeLaneRun, laneFree } from '@core/query/lanes';
import { ticksPerBar, type TempoMap } from '@core/time/ppq';
import { defaultValues } from '@agstudio/sdk';
import { audioChannel, renderRange, type Rendered } from '../actions/render-to-audio';
import type { Services } from '../services';

export class FilterError extends Error {}

export interface FilterResult {
  channelId: ChannelId;
  clipId: ClipId;
  /** The part that changed. */
  from: Tick;
  to: Tick;
  /** "Nightcore on bars 5–8: 25 % faster and about 4 semitones higher". */
  message: string;
}

/** The effects of a filter as plugin data (effects that aren't installed are left out). */
function effectsOf(s: Services, f: FilterPreset): { plugin: PluginInstance; mix: number }[] {
  const out: { plugin: PluginInstance; mix: number }[] = [];
  for (const fx of f.fx) {
    const def = s.plugins.get(fx.plugin);
    if (!def || def.kind !== 'effect') continue;
    out.push({
      plugin: makePluginInstance(def.id, def.version, { ...defaultValues(def.params), ...fx.params }),
      mix: fx.mix ?? 1,
    });
  }
  return out;
}

/** The filter's display name and the part's ("Nightcore", "bars 5–8"). */
export function filterTitle(p: Project, f: FilterPreset, target: FilterTarget): string {
  return `${f.name} on ${targetLabel(p, target)}`;
}

/** What the filter's render step settled, before the change to the song is made. */
interface FilterChange {
  preset: FilterPreset;
  target: FilterTarget;
  /** The part of the song it covers, and which clips of it. */
  part: ReturnType<typeof filterPart>;
  /** The speed the preset plays at (1 for none). */
  speed: number;
  /** The rendered audio and the gain that restores its level. */
  ref: Rendered['ref'];
  gain: number;
  /** Seconds of music in the part, before any speed change. */
  musicalSeconds: number;
  effects: { plugin: PluginInstance; mix: number }[];
  /** The song's tempo as it is when the change is made. */
  tempoNow: TempoMap;
  color: string;
  /** The new audio channel's name. */
  name: string;
  channelId: ChannelId;
  clipId: ClipId;
}

/**
 * The project with only the part playing (cut at its edges; automation stays, so it sounds the same), or null when
 * nothing plays there.
 */
function soloPart(p: Project, part: FilterChange['part'], tempo: TempoMap): Project | null {
  let inside = 0;
  const solo = produce(p, (d) => {
    const cut = cutPart(d, part.from, part.to, tempo, part.only);
    inside = cut.inside.length;
    const keep = new Set(cut.inside);
    for (const c of Object.values(d.playlist.clips)) if (c.kind !== 'automation' && !keep.has(c.id)) delete d.playlist.clips[c.id];
  });
  return inside === 0 ? null : solo;
}

/**
 * Applies a filter to a target (see core/filters/target.ts). Renders first (it takes a moment), then
 * makes the change as one undo step (`amend`: folded into that undo entry, e.g. the Studio answer's).
 * Rejects with FilterError when the filter is unknown or nothing plays there.
 */
export async function applyFilter(
  s: Services,
  filterId: string,
  target: FilterTarget,
  opts: { amend?: number; signal?: AbortSignal } = {},
): Promise<FilterResult> {
  const f = findFilter(filterId);
  if (!f) throw new FilterError(`There is no filter called “${filterId}”.`);
  const p = s.doc.getState().project;
  const speed = speedOf(f);
  const part = filterPart(p, target, speed !== 1);
  const label = targetLabel(p, target);
  const before = tempoMapOf(p, 'song');
  const solo = soloPart(p, part, before);
  if (!solo) throw new FilterError(`Nothing plays in ${label} to filter.`);
  const name = `${f.name} (${label})`.slice(0, 64);
  const { ref, gain } = await renderRange(s, solo, part.from, part.to, name, opts.signal);
  const musicalSeconds = before.tickToSeconds(part.to) - before.tickToSeconds(part.from);
  const effects = effectsOf(s, f);

  const now = s.doc.getState().project;
  // Another project was opened while it rendered: the render belongs to the old one.
  if (now.projectId !== p.projectId) throw new FilterError('Another project was opened while the filter rendered, so nothing was filtered.');
  const change: FilterChange = {
    preset: f,
    target,
    part,
    speed,
    ref,
    gain,
    musicalSeconds,
    effects,
    tempoNow: tempoMapOf(now, 'song'),
    color: paletteColor(now.channelOrder.length),
    name,
    channelId: newId.channel(),
    clipId: newId.clip(),
  };
  s.history.transact(filterTitle(p, f, target), (d) => makeFilterChange(d, change), opts.amend !== undefined ? { amend: opts.amend } : {});
  s.editor.getState().selectClips([change.clipId]);
  return { channelId: change.channelId, clipId: change.clipId, from: part.from, to: part.to, message: `${filterTitle(p, f, target)}: ${f.description}` };
}

/** Replaces the part's clips with the filtered audio on a mixer track of its own, keeping what is needed to undo it. */
function makeFilterChange(d: Draft<Project>, c: FilterChange): void {
  addSample(d, c.ref);
  const cut = cutPart(d, c.part.from, c.part.to, c.tempoNow, c.part.only);
  const lanesUsed = new Set(cut.originals.map((clip) => clip.laneId));
  for (const id of cut.inside) delete d.playlist.clips[id];
  const record: SoundFilter = { preset: c.preset.id, from: c.part.from, to: c.part.to, originals: cut.originals, pieces: cut.pieces };
  if (c.speed !== 1) addTempoChange(d, c, record);
  const output = c.effects.length ? addFilterInsert(d, c, record) : MASTER;
  const channel = filterChannel(c, output, record);
  addChannel(d, channel);
  const tempo = tempoMapOf(current(d) as Project, 'song');
  const tempoClip = liftTempoClip(d, record);
  const after = current(d) as Project;
  const duration = c.ref.durationSec;
  // Reversed, the tail would come first: the clip starts where the part's (reversed) music does.
  const offsetSec = c.preset.reverse ? Math.max(0, duration - c.musicalSeconds) : 0;
  const length = naturalLength({ start: c.part.from, offsetSec }, playbackMode(channel), tempo, duration);
  const laneId = laneForAudio(d, after, lanesUsed, c.part.from, c.part.from + length);
  const clip: AudioClip = {
    kind: 'audio',
    id: c.clipId,
    laneId,
    start: c.part.from,
    length,
    channelId: c.channelId,
    offsetSec,
    ...(c.gain > 1 ? { gain: c.gain } : {}),
  };
  addClips(d, [clip]);
  if (tempoClip) putTempoClipBack(d, tempoClip);
}

/** A speed filter changes the tempo of the part (its clips keep their bars); the cut clips go into the record. */
function addTempoChange(d: Draft<Project>, c: FilterChange, record: SoundFilter): void {
  const change = changePartTempo(d, c.part.from, c.part.to, c.speed, c.tempoNow, {
    wholeSong: c.target.kind === 'song',
    name: c.preset.name,
    color: c.color,
  });
  record.tempo = change.tempo;
  record.originals.push(...change.cut.originals);
  record.pieces.push(...change.cut.pieces);
}

/**
 * The mixer track that carries the filter's effects: an empty one is borrowed (and renamed), else a new one is
 * made. The record keeps what is needed to put the name back or remove the track. Returns the track's id.
 */
function addFilterInsert(d: Draft<Project>, c: FilterChange, record: SoundFilter): InsertId {
  const borrowed = emptyInsert(current(d) as Project);
  const id = borrowed ?? newId.insert();
  const previousName = borrowed ? (d.mixer.inserts[borrowed]?.name ?? '') : c.preset.name;
  if (borrowed) d.mixer.inserts[borrowed]!.name = c.preset.name;
  else addInsert(d, makeInsert(id, c.preset.name));
  const slots: SlotId[] = [];
  for (const fx of c.effects) {
    const slot = addFxSlot(d, id, fx.plugin);
    if (!slot) continue;
    slots.push(slot);
    const added = d.mixer.inserts[id]!.fx.find((y) => y.id === slot);
    if (added) added.mix = fx.mix;
  }
  record.insert = { id, made: !borrowed, name: previousName, slots };
  return id;
}

/** The audio channel for the rendered part: the speed's pitch change, the reverse, and the filter record. */
function filterChannel(c: FilterChange, output: InsertId, record: SoundFilter): AudioClipChannel {
  return {
    ...audioChannel(c.name, c.color, c.ref.id, output),
    id: c.channelId,
    ...(c.speed !== 1 ? { pitch: Math.round(speedCents(c.speed) * 1000) / 1000 } : {}),
    ...(c.preset.reverse ? { reverse: true } : {}),
    filter: record,
  };
}

/** Takes the tempo clip a speed filter made (if any) off the playlist for now, so the audio gets the part's track first. */
function liftTempoClip(d: Draft<Project>, record: SoundFilter): Clip | null {
  const tempoChannel = record.tempo && 'channelId' in record.tempo ? record.tempo.channelId : null;
  const tempoClip = Object.values(d.playlist.clips).find((c) => c.kind === 'automation' && c.channelId === tempoChannel);
  if (!tempoClip) return null;
  const lifted = { ...tempoClip } as Clip;
  delete d.playlist.clips[lifted.id];
  return lifted;
}

/** Puts the tempo clip back, on the first track that is free for it. */
function putTempoClipBack(d: Draft<Project>, lifted: Clip): void {
  const now = current(d) as Project;
  const index = freeLaneRun(now, lifted.start, lifted.start + lifted.length);
  const laneId = (now.playlist.laneOrder[index] as LaneId | undefined) ?? addTrack(d, now.playlist.laneOrder.length);
  addClips(d, [{ ...lifted, laneId }]);
}

/**
 * The track for the filtered audio: the top-most one the part was on, if it is free now; else the first free one
 * below it (a new track when none is).
 */
function laneForAudio(d: Draft<Project>, after: Project, lanesUsed: ReadonlySet<LaneId>, from: Tick, end: Tick): LaneId {
  const order = after.playlist.laneOrder;
  const top = order.findIndex((id) => lanesUsed.has(id));
  const index = top >= 0 && laneFree(after, top, from, end) ? top : freeLaneRun(after, from, end, 1, Math.max(0, top));
  return (order[index] as LaneId | undefined) ?? addTrack(d, order.length);
}

/** Adds a track named after its place ("Track 12") and returns its id. */
function addTrack(d: Draft<Project>, existingTracks: number): LaneId {
  const lane = makeLane(`Track ${existingTracks + 1}`);
  addLane(d, lane);
  return lane.id as LaneId;
}

/**
 * Removes a filter (by its channel): its audio goes and the clips it replaced come back, as one
 * undo step. Refuses (with a message) when a later filter was made over its audio.
 */
export function removeFilter(s: Services, channelId: ChannelId): { ok: boolean; message: string } {
  const p = s.doc.getState().project;
  const ch = p.channels[channelId];
  if (ch?.kind !== 'audioClip' || !ch.filter) return { ok: false, message: 'That clip has no filter to remove.' };
  const name = findFilter(ch.filter.preset)?.name ?? 'filter';
  const over = filtersOver(p, channelId);
  if (over.length)
    return {
      ok: false,
      message: `“${over[0]!.name}” was made over this part after it: remove that filter first.`,
    };
  s.history.transact(`Remove ${name}`, (d) => {
    removeSoundFilter(d, channelId);
  });
  return { ok: true, message: `Removed ${name}: the part plays as it was before (Undo brings the filter back).` };
}

/** Plays the song from a bar before `from` (how the Studio lets you hear a change). */
export function playFrom(s: Services, from: Tick): void {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  s.view.getState().setMode('song');
  s.engine.play(Math.max(0, from - bar));
}
