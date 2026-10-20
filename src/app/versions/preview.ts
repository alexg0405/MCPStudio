import { encodeWav } from '@core/io/wav';
import type { Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { trimExport } from '../export/export-wav';
import { planExport, planSeconds, type ExportPlan } from '../export/plan';
import type { Services } from '../services';

/** A version is previewed at a low rate: it is for a quick listen, and it renders in a second or two. */
const PREVIEW_RATE = 32000;
/** How much of the song a preview plays. */
export const PREVIEW_SECONDS = 20;
/** Room after the last bar for a reverb or a release to ring out. */
const PREVIEW_TAIL_SECONDS = 0.5;

/** The part of the project a preview renders: the start of the song, else the first pattern; null when there is neither. */
export function previewPlan(project: Project, maxSeconds: number): ExportPlan | null {
  const view = { currentPatternId: project.patternOrder[0] ?? null, loop: null };
  let plan = planExport(project, view, 'song');
  if ('error' in plan) plan = planExport(project, view, 'pattern');
  if ('error' in plan) return null;
  const seconds = planSeconds(project, plan);
  const barSeconds = seconds / Math.max(plan.bars, 1e-9);
  if (seconds > maxSeconds) return { ...plan, bars: Math.max(1, Math.floor(maxSeconds / barSeconds)) };
  return plan;
}

/** What a preview made: a WAV and how long it plays. */
export interface VersionPreview {
  wav: Uint8Array;
  seconds: number;
}

/**
 * Renders the start of a version's song offline, so it can be heard without opening it: the open project is not touched.
 * Null when the version has nothing to play (no clips and no patterns).
 */
export async function renderVersionPreview(s: Services, project: Project): Promise<VersionPreview | null> {
  const plan = previewPlan(project, PREVIEW_SECONDS);
  if (!plan) return null;
  const seconds = planSeconds(project, plan);
  const result = await renderOffline(project, {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: plan.mode, patternId: plan.patternId, loop: null },
    bars: plan.bars,
    fromTick: plan.fromTick,
    sampleRate: PREVIEW_RATE,
    tail: PREVIEW_TAIL_SECONDS,
    limiter: true,
  });
  const channels = trimExport(result, seconds);
  return { wav: encodeWav(channels, PREVIEW_RATE, { bitDepth: 16, dither: true }), seconds: Math.round(seconds * 10) / 10 };
}
