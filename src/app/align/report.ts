/**
 * What the AI (and the MCP server) can read about vocal alignment: which clips are aligned, to what, with which settings,
 * whether the aligned audio is ready, and how far the sound was moved. Synchronous: it reads the document and what the
 * last renders measured.
 */
import { alignPitch, alignStepTicks, alignStrength, describeAlign } from '@core/audio/align/edit';
import { moveAt } from '@core/audio/align';
import { planAlignment } from '@core/audio/align/plan';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';
import { alignState } from './state';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The clip's place the way the AI numbers it: 1-based track and bar. */
function placeOf(p: Project, clip: AudioClip): { track: number; bar: number } {
  return { track: p.playlist.laneOrder.indexOf(clip.laneId) + 1, bar: r2(clip.start / ticksPerBar(p.transport.timeSig) + 1) };
}

/** Median and largest move (milliseconds) of an overlay's points; null without a warp. */
function movesOf(warp: readonly number[] | undefined): { median_ms: number; max_ms: number } | null {
  if (!warp || warp.length < 4) return null;
  const moves: number[] = [];
  const first = warp[0] as number;
  const last = warp[warp.length - 2] as number;
  for (let t = first; t <= last; t += 0.02) moves.push(Math.abs(moveAt(warp, t)));
  moves.sort((a, b) => a - b);
  return { median_ms: r1(moves[moves.length >> 1] as number), max_ms: r1(moves[moves.length - 1] as number) };
}

/** One aligned clip, in the units the actions take. */
function describeClip(s: Services, p: Project, clip: AudioClip): Record<string, unknown> {
  const align = clip.align;
  if (!align) return { clip: clip.id };
  const view = alignState.getState();
  const planned = planAlignment(p, clip.id);
  const problem = 'problem' in planned ? planned.problem : (view.problems[clip.id] ?? null);
  const rendering = view.rendering[clip.id];
  const current = 'plan' in planned && !!align.renderedSampleId && align.renderedFor === planned.plan.signature;
  const state = problem ? 'problem' : rendering !== undefined ? 'rendering' : current ? 'ready' : 'out of date';
  const guide = align.guide ? p.playlist.clips[align.guide] : undefined;
  const channel = p.channels[clip.channelId];
  return {
    clip: clip.id,
    name: channel?.name,
    ...placeOf(p, clip),
    mode: align.mode === 'guide' ? 'guide' : 'grid',
    summary: describeAlign(align),
    ...(align.mode === 'guide'
      ? {
          guide: align.guide,
          ...(guide?.kind === 'audio' ? { guide_track: placeOf(p, guide).track, guide_bar: placeOf(p, guide).bar } : { guide_missing: true }),
          tightness: Math.round(align.tightness),
          pitch_percent: Math.round(alignPitch(align)),
        }
      : { strength_percent: Math.round(alignStrength(align)), grid_ticks: alignStepTicks(align) }),
    state,
    ...(rendering !== undefined ? { progress_percent: Math.round(rendering * 100) } : {}),
    ...(problem ? { problem } : {}),
    moved: movesOf(align.warp),
    ...(view.lastStats[clip.id]
      ? {
          last_run: {
            median_move_ms: r1(view.lastStats[clip.id]!.medianMoveMs),
            max_move_ms: r1(view.lastStats[clip.id]!.maxMoveMs),
            ...(view.lastStats[clip.id]!.pitchCentsBefore !== undefined
              ? {
                  pitch_deviation_cents_before: r1(view.lastStats[clip.id]!.pitchCentsBefore as number),
                  pitch_deviation_cents_after: r1(view.lastStats[clip.id]!.pitchCentsAfter as number),
                }
              : {}),
          },
        }
      : {}),
    hearing: s.editor.getState().alignOriginal.includes(clip.id) ? 'original recording' : 'aligned sound',
  };
}

/** The alignment state of the given clip, or of every aligned clip when none is given. */
export function alignReport(s: Services, args: { clip?: unknown }): unknown {
  const p = s.doc.getState().project;
  if (typeof args.clip === 'string' && args.clip) {
    const clip = p.playlist.clips[args.clip as ClipId];
    if (clip?.kind !== 'audio') return { error: `there is no audio clip "${args.clip}"` };
    return clip.align ? describeClip(s, p, clip) : { clip: clip.id, aligned: false, message: 'This clip is not aligned. The align_clips action follows a guide; tighten_timing snaps to the grid.' };
  }
  const aligned = Object.values(p.playlist.clips)
    .filter((c): c is AudioClip => c.kind === 'audio' && !!c.align)
    .sort((a, b) => a.start - b.start);
  return {
    aligned: aligned.map((c) => describeClip(s, p, c)),
    message: aligned.length
      ? undefined
      : 'No clip is aligned. align_clips lines doubles, backing vocals and ad-libs up with a lead clip; tighten_timing snaps a vocal to the grid.',
  };
}
