/**
 * Writes a mix plan (`core/dj/plan.ts`) into the project, as part of one undo step: one audio clip channel per song
 * (time-stretched at its own BPM) with its clips on the "Deck A" / "Deck B" playlist tracks, the mix's tempo curve,
 * the transition curves on "Deck A FX n" / "Deck B FX n" tracks, risers, and a marker per song. `Project.dj`
 * remembers the songs, options and tweaks, and what the mix made: writing again first removes exactly that.
 */
import type { Draft } from 'immer';
import { resolveTarget } from '@core/automation/targets';
import { LaneAllocator } from '@core/arrange/plan';
import { laneNamed } from '@core/arrange/apply';
import type { Deck, DjAutomation, MixPlan, TransitionTweak } from '@core/dj/plan';
import { fxLabel, fxSampleRef } from '@core/model/fx';
import { paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { targetKey } from '@core/model/targets';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type AutomationChannel,
  type AutomationClip,
  type AutoPoint,
  type ChannelId,
  type DjMixOptions,
  type DjMixState,
  type InsertId,
  type MarkerId,
  type ParamTarget,
  type Project,
  type SampleId,
  type SampleRef,
  type SlotId,
} from '@core/model/types';
import { addMarker, removeMarker } from '@core/ops/markers';
import { addClips } from '@core/ops/playlist';
import { removeChannel } from '@core/ops/channels';
import { barSpan } from '@core/time/bars';
import { specsResolver } from '../arrange/env';
import type { Services } from '../services';
import { sampleHash } from './analyzer';
import { DECK_NAMES, ensureDecks } from './mix-mixer';
import type { DeckSlots, MixSong } from './mix-types';

export const TEMPO_LANE = 'Mix tempo';
export const DJ_FX_LANE = 'DJ FX';

/** Ticks per beat (the project's resolution). */
const TICKS_PER_BEAT = 960;
/** Ticks in a bar of 4/4, which the transition names count their length in. */
const TICKS_PER_BAR_4_4 = 3840;
/** A song's channel plays a little under full level, leaving the master limiter room. */
const SONG_CHANNEL_VOLUME = 0.78;
/** The most a song's gain is raised by the plan's loudness match (linear). */
const MAX_SONG_GAIN = 4;
/** A song's gain within this of 1 is left off the clip. */
const NEUTRAL_GAIN_TOLERANCE = 1e-6;
/** A riser sits under the music at half level, straight to the master. */
const RISER_VOLUME = 0.5;
const RISER_COLOR = '#8c9aa8';
/** Palette slots: the tempo curve, and the transition curves of each deck. */
const TEMPO_COLOR_SLOT = 9;
const TRANSITION_COLOR_SLOT = { A: 4, B: 6 } as const;
/** Two curves within this of each other (in normalized value) are the same curve and share a channel. */
const SAME_CURVE_TOLERANCE = 1e-9;

/** What the transition curves are called in the channel list. */
const PURPOSE: Record<DjAutomation['purpose'], string> = {
  'fade-in': 'Fade in',
  'fade-out': 'Fade out',
  'bass-in': 'Bass in',
  'bass-out': 'Bass out',
  'filter-out': 'Filter out',
  'echo-out': 'Echo out',
};

/** The things a write needs all along: the draft, the app, the plan's resolver, and the channels made so far. */
interface WriteContext {
  d: Draft<Project>;
  services: Services;
  /** The draft viewed as a project, for the read-only helpers. */
  project: Project;
  specsOf: ReturnType<typeof specsResolver>;
  /** The channels this write made, so the next write can remove exactly them. */
  made: ChannelId[];
}

/** Puts a new channel in the project and remembers it as made by the mix. */
function addMadeChannel(context: WriteContext, channel: AutomationChannel | AudioClipChannel): void {
  context.d.channels[channel.id] = channel as Draft<typeof channel>;
  context.d.channelOrder.push(channel.id);
  context.made.push(channel.id);
}

/** Removes what the previous mix made (its channels with their clips, its markers). Returns how many songs it had. */
export function removeMixInDraft(d: Draft<Project>): number {
  const previous = d.dj;
  if (!previous) return 0;
  for (const id of previous.made.channels) removeChannel(d, id as ChannelId);
  for (const id of previous.made.markers) removeMarker(d, id as MarkerId);
  delete d.dj;
  return previous.songs.length;
}

/** The parameter a transition curve moves. */
function targetOf(automation: DjAutomation, deck: DeckSlots, echo: InsertId): ParamTarget {
  const fx = (slotId: SlotId, paramId: string): ParamTarget => ({
    kind: 'plugin',
    owner: { kind: 'fx', insertId: deck.insertId, slotId },
    paramId,
  });
  switch (automation.control) {
    case 'volume':
      return { kind: 'insert', insertId: deck.insertId, param: 'volume' };
    case 'low-cut':
      return fx(deck.eq, 'b1Freq');
    case 'high-cut':
      return fx(deck.eq, 'b8Freq');
    case 'filter':
      return fx(deck.filter, 'cutoff');
    case 'echo':
      return { kind: 'route', insertId: deck.insertId, to: echo };
  }
}

const samePoints = (a: readonly AutoPoint[], b: readonly AutoPoint[]) =>
  a.length === b.length &&
  a.every((x, i) => x.tick === b[i]!.tick && Math.abs(x.value - b[i]!.value) < SAME_CURVE_TOLERANCE && (x.shape ?? 'curve') === (b[i]!.shape ?? 'curve'));

/** Sets the project tempo, and for a mix whose tempo moves, makes the "Mix tempo" curve on its own lane. */
function writeTempo(context: WriteContext, plan: MixPlan): void {
  const { d } = context;
  if (plan.fixedTempo !== null || plan.tempoCurve.length === 1) {
    d.transport.bpm = plan.fixedTempo ?? plan.tempoCurve[0]!.bpm;
    return;
  }
  d.transport.bpm = plan.tempoCurve[0]!.bpm;
  const bpms = plan.tempoCurve.map((t) => t.bpm);
  const range = { min: Math.floor(Math.min(...bpms)) - 1, max: Math.ceil(Math.max(...bpms)) + 1 };
  const resolved = resolveTarget(context.project, { kind: 'tempo' }, context.specsOf, range)!;
  const channel: AutomationChannel = {
    kind: 'automation',
    id: newId.channel(),
    name: 'Mix tempo',
    color: paletteColor(TEMPO_COLOR_SLOT),
    muted: false,
    solo: false,
    target: { kind: 'tempo' },
    // Holds, and straight glides through the transitions.
    points: plan.tempoCurve.map((t) => ({ tick: t.tick, value: resolved.toNormalized(t.bpm), ...(t.ramp ? {} : { shape: 'hold' as const }) })),
    range,
  };
  addMadeChannel(context, channel);
  const clip: AutomationClip = {
    kind: 'automation',
    id: newId.clip(),
    laneId: laneNamed(d, TEMPO_LANE),
    start: 0,
    length: Math.max(1, plan.totalTicks),
    channelId: channel.id,
    offset: 0,
  };
  addClips(d, [clip]);
}

/** The project's samples by content hash, so a song that is already in the project is not added twice. */
function sampleIdsByHash(d: Draft<Project>): Map<string, SampleId> {
  const byHash = new Map<string, SampleId>();
  for (const sampleId of Object.keys(d.samples) as SampleId[]) {
    const source = d.samples[sampleId]!.source;
    if (source.kind === 'embedded') byHash.set(source.hash, sampleId);
  }
  return byHash;
}

/** Songs: one stretched channel each, its pieces on its deck's track. Returns what `Project.dj` remembers of them. */
function writeSongs(
  context: WriteContext,
  plan: MixPlan,
  songs: ReadonlyMap<string, MixSong>,
  decks: Record<Deck, DeckSlots | null>,
  laneOf: Record<Deck, ReturnType<typeof laneNamed>>,
): DjMixState['songs'] {
  const { d } = context;
  const sampleIdByHash = sampleIdsByHash(d);
  const written: DjMixState['songs'] = [];
  for (const song of plan.songs) {
    const input = songs.get(song.id);
    const deck = decks[song.deck];
    if (!input || !deck) continue;
    const hash = sampleHash(input.ref);
    let sampleId = hash ? sampleIdByHash.get(hash) : undefined;
    if (!sampleId) {
      sampleId = input.ref.id;
      d.samples[sampleId] = { ...input.ref } as Draft<SampleRef>;
      if (hash) sampleIdByHash.set(hash, sampleId);
    }
    const channel: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: song.title.slice(0, 64),
      color: paletteColor(song.index * 3 + (song.deck === 'A' ? 0 : 1)),
      muted: false,
      solo: false,
      volume: SONG_CHANNEL_VOLUME,
      pan: 0,
      output: deck.insertId,
      sampleId,
      ...(song.follow !== 'off' ? { stretch: song.follow, sourceBpm: song.bpm } : {}),
    };
    addMadeChannel(context, channel);
    const gain = Math.min(MAX_SONG_GAIN, Math.pow(10, song.gainDb / 20));
    const lastClip = song.clips.length - 1;
    const clips: AudioClip[] = song.clips.map((piece, k) => ({
      kind: 'audio',
      id: newId.clip(),
      laneId: laneOf[song.deck],
      start: piece.start,
      length: piece.length,
      channelId: channel.id,
      offsetSec: piece.offsetSec,
      ...(Math.abs(gain - 1) > NEUTRAL_GAIN_TOLERANCE ? { gain } : {}),
      ...(k === lastClip && song.fadeOutSec ? { fadeOut: song.fadeOutSec } : {}),
    }));
    addClips(d, clips);
    written.push({
      sampleId,
      title: song.title,
      bpm: song.nativeBpm,
      camelot: song.key,
      deck: song.deck,
      start: song.start,
      end: song.end,
      ...(input.pinned ? { pinned: true } : {}),
    });
  }
  return written;
}

/** The name of a transition curve: what it does, on which deck, and how long it is. */
function transitionCurveName(automation: DjAutomation): string {
  const bars = Math.round((automation.length / TICKS_PER_BAR_4_4) * 100) / 100;
  const length = automation.control === 'echo' ? '' : ` (${bars} bar${bars === 1 ? '' : 's'})`;
  return `${PURPOSE[automation.purpose]} · ${DECK_NAMES[automation.deck]}${length}`;
}

/** Transition curves, one automation channel per control and shape (reused), on free FX tracks. */
function writeTransitionCurves(context: WriteContext, plan: MixPlan, decks: Record<Deck, DeckSlots | null>, echo: InsertId): void {
  const { d, project, specsOf } = context;
  const lanes = new LaneAllocator(new Set([`${DECK_NAMES.A} FX`, `${DECK_NAMES.B} FX`]));
  const laneNames = new Map(d.playlist.laneOrder.map((id) => [id, d.playlist.lanes[id]?.name ?? '']));
  for (const clip of Object.values(d.playlist.clips)) lanes.occupy(laneNames.get(clip.laneId) ?? '', clip.start, clip.start + clip.length);
  for (const automation of plan.automation) {
    const deck = decks[automation.deck];
    if (!deck) continue;
    const target = targetOf(automation, deck, echo);
    const resolved = resolveTarget(project, target, specsOf);
    if (!resolved) continue;
    const neutral = resolved.base;
    const plainValue = (v: number | 'neutral') => (v === 'neutral' ? neutral : automation.control === 'volume' ? neutral * v : v);
    const points: AutoPoint[] = automation.points.map((point) => ({
      tick: Math.round(point.at),
      value: Math.min(1, Math.max(0, resolved.toNormalized(plainValue(point.value)))),
    }));
    const key = targetKey(target);
    let channelId = context.made.find((id) => {
      const existing = d.channels[id];
      return existing?.kind === 'automation' && existing.target && targetKey(existing.target) === key && samePoints(existing.points, points);
    });
    if (!channelId) {
      const channel: AutomationChannel = {
        kind: 'automation',
        id: newId.channel(),
        name: transitionCurveName(automation),
        color: paletteColor(TRANSITION_COLOR_SLOT[automation.deck]),
        muted: false,
        solo: false,
        target,
        points,
      };
      addMadeChannel(context, channel);
      channelId = channel.id;
    }
    const laneId = laneNamed(d, lanes.place(`${DECK_NAMES[automation.deck]} FX`, automation.start, automation.start + automation.length));
    addClips(d, [{ kind: 'automation', id: newId.clip(), laneId, start: automation.start, length: automation.length, channelId, offset: 0 }]);
  }
}

/** Risers into the swap: a generated riser sound on the "DJ FX" track, straight to the master. */
function writeRisers(context: WriteContext, plan: MixPlan): void {
  const { d } = context;
  for (const riser of plan.risers) {
    const ref = fxSampleRef('riser', riser.beats, riser.bpm);
    d.samples[ref.id] = ref;
    const channel: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name: fxLabel('riser', riser.beats),
      color: RISER_COLOR,
      muted: false,
      solo: false,
      volume: RISER_VOLUME,
      pan: 0,
      output: MASTER,
      sampleId: ref.id,
      stretch: 'resample',
      sourceBpm: riser.bpm,
    };
    addMadeChannel(context, channel);
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId: laneNamed(d, DJ_FX_LANE),
      start: riser.start,
      length: riser.beats * TICKS_PER_BEAT,
      channelId: channel.id,
      offsetSec: 0,
    };
    addClips(d, [clip]);
  }
}

/** The line that says what a finished mix is ("Made a 5-song mix (32 min, bars 1–160): 4 transitions at 124 BPM"). */
function summaryLine(d: Draft<Project>, plan: MixPlan): string {
  const span = barSpan(0, plan.totalTicks, d.transport.timeSig);
  const tempo = plan.fixedTempo ? ` at ${plan.fixedTempo} BPM` : '';
  return `Made a ${plan.songs.length}-song mix (${Math.round(plan.durationSec / 60)} min, ${span}): ${plan.transitions.length} transitions${tempo}`;
}

/** Writes a plan (after removing the previous mix). Returns change lines. */
export function writeMixInDraft(
  d: Draft<Project>,
  services: Services,
  plan: MixPlan,
  songs: ReadonlyMap<string, MixSong>,
  options: DjMixOptions,
  tweaks: Record<string, TransitionTweak>,
): string[] {
  const changes: string[] = [];
  const replaced = removeMixInDraft(d);
  if (replaced) changes.push(`Replaced the previous mix (${replaced} songs)`);
  if (plan.songs.length === 0) return changes;
  const { decks, echo } = ensureDecks(d, services, changes);
  const context: WriteContext = { d, services, project: d as unknown as Project, specsOf: specsResolver(services), made: [] };

  // Lanes in a fixed order: the decks first, then the tempo, then the curves.
  const laneOf: Record<Deck, ReturnType<typeof laneNamed>> = { A: laneNamed(d, DECK_NAMES.A), B: laneNamed(d, DECK_NAMES.B) };

  writeTempo(context, plan);
  const written = writeSongs(context, plan, songs, decks, laneOf);
  writeTransitionCurves(context, plan, decks, echo);
  writeRisers(context, plan);
  const markers: MarkerId[] = plan.markers.map((marker) => addMarker(d, marker.tick, marker.name));

  d.dj = { songs: written, options: { ...options }, tweaks: { ...tweaks }, made: { channels: context.made, markers } } as Draft<DjMixState>;
  changes.push(summaryLine(d, plan));
  return changes;
}
