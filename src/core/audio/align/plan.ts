/**
 * What an alignment needs to know about the project, worked out from the clips: which stretch of the clip's sample to
 * render, where the guide's sound lies on the same time axis, the grid lines in that stretch, and a signature of
 * everything the render depends on (to tell a stale render). Pure functions of the project (no audio): the app reads
 * the audio afterwards.
 *
 * Time axes. A clip plays its sample from `offsetSec` at song position `start`; at normal speed (no tempo follow, no
 * pitch change, not reversed) the sample's time and the song's time differ by a constant. The render covers the clip's
 * audible part plus `ALIGN_MARGIN_SEC` each side (so a later trim finds the sound where it was), and everything is
 * measured in seconds from the start of that stretch.
 */
import { tempoMapOf } from '../../automation/tempo';
import type { AlignEdit, AudioClip, AudioClipChannel, ClipId, Project, SampleId } from '../../model/types';
import type { TempoMap } from '../../time/ppq';
import { clipSampleId, clipSourceSampleId, isPlainPlayback, playbackMode } from '../playback';
import { alignPitch, alignStepTicks, alignStrength } from './edit';
import type { AudibleSpan } from './types';

/** Seconds of the clip's sample either side of what it plays that the render covers. */
export const ALIGN_MARGIN_SEC = 0.3;
/** A guide has to be heard at the same time as the clip for at least this long (seconds) to be followed. */
const MIN_OVERLAP_SEC = 0.1;
/** Changes whenever the algorithm does, so renders made by an older one count as out of date. */
export const ALIGN_VERSION = 1;
/** Grid-mode onsets move at most this far (seconds), and at most this share of a grid step. */
const GRID_MAX_MOVE_SEC = 0.12;
const GRID_MAX_MOVE_STEP_SHARE = 0.45;

/** The guide as the render needs it. */
export interface GuidePlan {
  clipId: ClipId;
  /** The sound the guide plays: its channel's sample, or the render of its own alignment or pitch correction. */
  sampleId: SampleId;
  /** Seconds on the guide's sample where its sound is at the start of the rendered stretch (may be negative). */
  startSec: number;
  /** The part of the guide that is audible, in seconds from the start of the stretch. */
  audible: AudibleSpan;
}

/** The grid in the rendered stretch. */
export interface GridPlan {
  /** Grid lines in seconds from the start of the stretch, increasing. */
  linesSec: number[];
  /** Onsets further than this from a line stay where they are (seconds). */
  maxMoveSec: number;
}

/** What to render for one clip. */
export interface AlignPlan {
  clipId: ClipId;
  edit: AlignEdit;
  /** The clip's own sample: the sound that gets aligned. */
  sourceSampleId: SampleId;
  /** The stretch of the sample to render: seconds on the sample (the end may be past its end: the app clips it). */
  region: { fromSec: number; toSec: number };
  /** The part of the stretch the clip plays, in seconds from its start. */
  audible: AudibleSpan;
  guide?: GuidePlan;
  grid?: GridPlan;
  /** Everything the render depends on, as a string: equal strings give the same render. */
  signature: string;
}

/** Why a clip cannot be aligned, or the plan. */
export type AlignPlanResult = { plan: AlignPlan } | { problem: string };

/** The clip and its channel (null when the id is not an audio clip with an audio channel). */
function audioOf(p: Project, id: ClipId): { clip: AudioClip; channel: AudioClipChannel } | null {
  const clip = p.playlist.clips[id];
  if (clip?.kind !== 'audio') return null;
  const channel = p.channels[clip.channelId];
  return channel?.kind === 'audioClip' ? { clip, channel } : null;
}

/** True when following `guide` would lead back to `clipId` (a ring of clips aligned to each other). */
function makesRing(p: Project, clipId: ClipId, guide: ClipId): boolean {
  const seen = new Set<ClipId>();
  let at: ClipId | undefined = guide;
  while (at && !seen.has(at)) {
    if (at === clipId) return true;
    seen.add(at);
    const next: AudioClip | undefined = audioOf(p, at)?.clip;
    at = next?.align?.mode === 'guide' ? next.align.guide : undefined;
  }
  return false;
}

/** Why a clip cannot be aligned at all (null when it can): it must be audio that plays at its own speed, forwards. */
export function alignProblem(p: Project, id: ClipId): string | null {
  const found = audioOf(p, id);
  if (!found) return 'That is not an audio clip.';
  if (!p.samples[found.channel.sampleId]) return 'This clip’s audio is missing.';
  if (!isPlainPlayback(playbackMode(found.channel))) {
    return 'Alignment needs a clip that plays at its own speed: turn off Reverse, Pitch and Follow tempo on this audio first.';
  }
  return null;
}

/** Why a guide cannot be followed by this clip (null when it can). */
export function guideProblem(p: Project, clipId: ClipId, guideId: ClipId | undefined): string | null {
  if (!guideId) return 'Choose the clip to follow (the lead).';
  if (guideId === clipId) return 'A clip cannot follow itself: choose another clip as the guide.';
  const guide = audioOf(p, guideId);
  if (!guide) return 'The guide has to be an audio clip.';
  if (!p.samples[clipSampleId(guide.channel, guide.clip)] && !p.samples[guide.channel.sampleId]) return 'The guide’s audio is missing.';
  if (!isPlainPlayback(playbackMode(guide.channel))) return 'The guide has to play at its own speed (no Reverse, Pitch or Follow tempo).';
  if (makesRing(p, clipId, guideId)) return 'That guide follows this clip already: choose a different guide.';
  return null;
}

/** Seconds a clip plays on the song's clock (from its start to its end). */
function spanSeconds(clip: AudioClip, tempo: TempoMap): number {
  return Math.max(0, tempo.tickToSeconds(clip.start + clip.length) - tempo.tickToSeconds(clip.start));
}

const rounded = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** The guide's place on the clip's stretch. */
function planGuide(p: Project, clip: AudioClip, guideId: ClipId, region: AlignPlan['region'], tempo: TempoMap): GuidePlan | null {
  const guide = audioOf(p, guideId);
  if (!guide) return null;
  // Song time t is at sample time t − startSec + offsetSec on each clip, so the guide's sample time is the clip's plus a constant.
  const clipShift = tempo.tickToSeconds(clip.start) - clip.offsetSec;
  const guideShift = tempo.tickToSeconds(guide.clip.start) - guide.clip.offsetSec;
  const delta = clipShift - guideShift;
  const span = spanSeconds(guide.clip, tempo);
  const audible = {
    fromSec: guide.clip.offsetSec - delta - region.fromSec,
    toSec: guide.clip.offsetSec + span - delta - region.fromSec,
  };
  return { clipId: guideId, sampleId: clipSampleId(guide.channel, guide.clip), startSec: region.fromSec + delta, audible };
}

/** The grid lines (seconds from the start of the stretch) that fall within the stretch, a margin either side. */
function planGrid(clip: AudioClip, edit: AlignEdit, region: AlignPlan['region'], tempo: TempoMap): GridPlan {
  const step = alignStepTicks(edit);
  const clipStartSec = tempo.tickToSeconds(clip.start);
  const stretchStartSong = clipStartSec + (region.fromSec - clip.offsetSec);
  const stretchEndSong = clipStartSec + (region.toSec - clip.offsetSec);
  const firstTick = Math.max(0, Math.floor(tempo.secondsToTick(stretchStartSong) / step) * step);
  const lines: number[] = [];
  for (let tick = firstTick; tempo.tickToSeconds(tick) <= stretchEndSong + 0.5 && lines.length < 100_000; tick += step) {
    lines.push(tempo.tickToSeconds(tick) - stretchStartSong);
  }
  const stepSec = tempo.tickToSeconds(clip.start + step) - clipStartSec;
  return { linesSec: lines, maxMoveSec: Math.min(GRID_MAX_MOVE_SEC, GRID_MAX_MOVE_STEP_SHARE * stepSec) };
}

/** A hash-like short string of the grid lines (so a tempo change shows in the signature). */
function gridSignature(grid: GridPlan): string {
  let sum = 0;
  grid.linesSec.forEach((t, i) => (sum += Math.round(t * 1000) * ((i % 7) + 1)));
  return `${grid.linesSec.length}:${sum}:${rounded(grid.maxMoveSec)}`;
}

/** The signature of a plan's inputs. */
function signatureOf(plan: Omit<AlignPlan, 'signature'>): string {
  const { edit, guide, grid } = plan;
  const parts = [
    `v${ALIGN_VERSION}`,
    edit.mode,
    String(Math.round(edit.tightness)),
    plan.sourceSampleId,
    rounded(plan.region.fromSec),
    rounded(plan.region.toSec),
    rounded(plan.audible.fromSec),
    rounded(plan.audible.toSec),
  ];
  if (guide) {
    parts.push(
      guide.clipId,
      guide.sampleId,
      rounded(guide.startSec),
      rounded(guide.audible.fromSec),
      rounded(guide.audible.toSec),
      String(Math.round(alignPitch(edit))),
    );
  }
  if (grid) parts.push(String(Math.round(alignStrength(edit))), gridSignature(grid));
  return parts.join('|');
}

/**
 * The plan for the clip's alignment as it is now (`edit` overrides the clip's own, for a preview of settings the clip
 * does not have yet). A problem in plain words when it cannot be made.
 */
export function planAlignment(p: Project, id: ClipId, edit?: AlignEdit): AlignPlanResult {
  const problem = alignProblem(p, id);
  if (problem) return { problem };
  const { clip, channel } = audioOf(p, id) as NonNullable<ReturnType<typeof audioOf>>;
  const own = edit ?? clip.align;
  if (!own) return { problem: 'This clip is not aligned.' };
  const tempo = tempoMapOf(p, 'song');
  const span = spanSeconds(clip, tempo);
  const from = Math.max(0, clip.offsetSec - ALIGN_MARGIN_SEC);
  const region = { fromSec: from, toSec: clip.offsetSec + span + ALIGN_MARGIN_SEC };
  const audible = { fromSec: clip.offsetSec - from, toSec: clip.offsetSec + span - from };
  // The alignment reads the sound its stage gets in the clip edit chain (the cleaned-up vocal when there is one).
  const sourceSampleId = clipSourceSampleId(channel, clip, 'align');
  const base = { clipId: id, edit: own, sourceSampleId, region, audible };
  if (own.mode === 'guide') {
    const guideProblemText = guideProblem(p, id, own.guide);
    if (guideProblemText) return { problem: guideProblemText };
    const guide = planGuide(p, clip, own.guide as ClipId, region, tempo);
    if (!guide) return { problem: 'The guide has to be an audio clip.' };
    const overlap = Math.min(audible.toSec, guide.audible.toSec) - Math.max(audible.fromSec, guide.audible.fromSec);
    if (overlap < MIN_OVERLAP_SEC) return { problem: 'This clip and the guide are not heard at the same time: place them over each other first.' };
    const plan = { ...base, guide };
    return { plan: { ...plan, signature: signatureOf(plan) } };
  }
  const plan = { ...base, grid: planGrid(clip, own, region, tempo) };
  return { plan: { ...plan, signature: signatureOf(plan) } };
}

/** The grid line nearest to `sec` (a function over the plan's sorted lines). */
export function nearestLine(linesSec: readonly number[]): (sec: number) => number {
  return (sec) => {
    if (linesSec.length === 0) return sec;
    let lo = 0;
    let hi = linesSec.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((linesSec[mid] as number) <= sec) lo = mid;
      else hi = mid;
    }
    const a = linesSec[lo] as number;
    const b = linesSec[hi] as number;
    return Math.abs(sec - a) <= Math.abs(b - sec) ? a : b;
  };
}
