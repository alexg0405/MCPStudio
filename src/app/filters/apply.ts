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
import { current } from 'immer';
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
import { ticksPerBar } from '@core/time/ppq';
import { defaultValues } from '@agstudio/sdk';
import { produce } from 'immer';
import { audioChannel, renderRange } from '../actions/render-to-audio';
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
  // Only the part plays in the render (cut at its edges); automation stays, so it sounds the same.
  let inside = 0;
  const solo = produce(p, (d) => {
    const cut = cutPart(d, part.from, part.to, before, part.only);
    inside = cut.inside.length;
    const keep = new Set(cut.inside);
    for (const c of Object.values(d.playlist.clips)) if (c.kind !== 'automation' && !keep.has(c.id)) delete d.playlist.clips[c.id];
  });
  if (inside === 0) throw new FilterError(`Nothing plays in ${label} to filter.`);
  const name = `${f.name} (${label})`.slice(0, 64);
  const { ref, gain } = await renderRange(s, solo, part.from, part.to, name, opts.signal);
  const musical = before.tickToSeconds(part.to) - before.tickToSeconds(part.from);
  const effects = effectsOf(s, f);

  const now = s.doc.getState().project;
  const tempoNow = tempoMapOf(now, 'song');
  const color = paletteColor(now.channelOrder.length);
  const channelId = newId.channel();
  const clipId = newId.clip();
  s.history.transact(
    filterTitle(p, f, target),
    (d) => {
      addSample(d, ref);
      const cut = cutPart(d, part.from, part.to, tempoNow, part.only);
      const lanesUsed = new Set(cut.originals.map((c) => c.laneId));
      for (const id of cut.inside) delete d.playlist.clips[id];
      const record: SoundFilter = { preset: f.id, from: part.from, to: part.to, originals: cut.originals, pieces: cut.pieces };
      if (speed !== 1) {
        const t = changePartTempo(d, part.from, part.to, speed, tempoNow, {
          wholeSong: target.kind === 'song',
          name: f.name,
          color,
        });
        record.tempo = t.tempo;
        record.originals.push(...t.cut.originals);
        record.pieces.push(...t.cut.pieces);
      }
      let output: InsertId = MASTER;
      if (effects.length) {
        const borrowed = emptyInsert(current(d) as Project);
        const id = borrowed ?? newId.insert();
        const prevName = borrowed ? (d.mixer.inserts[borrowed]?.name ?? '') : f.name;
        if (borrowed) d.mixer.inserts[borrowed]!.name = f.name;
        else addInsert(d, makeInsert(id, f.name));
        const slots: SlotId[] = [];
        for (const fx of effects) {
          const slot = addFxSlot(d, id, fx.plugin);
          if (!slot) continue;
          slots.push(slot);
          const x = d.mixer.inserts[id]!.fx.find((y) => y.id === slot);
          if (x) x.mix = fx.mix;
        }
        record.insert = { id, made: !borrowed, name: prevName, slots };
        output = id;
      }
      const ch: AudioClipChannel = {
        ...audioChannel(name, color, ref.id, output),
        id: channelId,
        ...(speed !== 1 ? { pitch: Math.round(speedCents(speed) * 1000) / 1000 } : {}),
        ...(f.reverse ? { reverse: true } : {}),
        filter: record,
      };
      addChannel(d, ch);
      const after = current(d) as Project;
      const tempo = tempoMapOf(after, 'song');
      const dur = ref.durationSec;
      // Reversed, the tail would come first: the clip starts where the part's (reversed) music does.
      const offsetSec = f.reverse ? Math.max(0, dur - musical) : 0;
      const length = naturalLength({ start: part.from, offsetSec }, playbackMode(ch), tempo, dur);
      const end = part.from + length;
      // The top-most track the part was on, if it is free now; else the first free one below it.
      const order = after.playlist.laneOrder;
      const top = order.findIndex((id) => lanesUsed.has(id));
      const index = top >= 0 && laneFree(after, top, part.from, end) ? top : freeLaneRun(after, part.from, end, 1, Math.max(0, top));
      let laneId = order[index] as LaneId | undefined;
      if (!laneId) {
        const lane = makeLane(`Track ${order.length + 1}`);
        addLane(d, lane);
        laneId = lane.id as LaneId;
      }
      const clip: AudioClip = {
        kind: 'audio',
        id: clipId,
        laneId,
        start: part.from,
        length,
        channelId,
        offsetSec,
        ...(gain > 1 ? { gain } : {}),
      };
      addClips(d, [clip]);
    },
    opts.amend !== undefined ? { amend: opts.amend } : {},
  );
  s.editor.getState().selectClips([clipId]);
  return { channelId, clipId, from: part.from, to: part.to, message: `${filterTitle(p, f, target)}: ${f.description}` };
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
