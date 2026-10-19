import type { PatternId, Tick, VariantKind, VariantStep } from '../../model/types';
import { normalizeStep, sortSteps } from '../variants';
import type { Content } from './section-content';
import { eventSpan, type SongEvent } from './types';

/** Kinds that add notes on one instrument: they go to one clip; the drums of the others make room. */
export const ADDS: ReadonlySet<VariantKind> = new Set([
  'snare-fill',
  'tom-fill',
  'hat-fill',
  'kick-fill',
  'snare-build',
  'hat-roll',
  'open-hat',
]);
/** Kinds that add drum notes (never under a fill playing from its own clip). */
export const ADDS_DRUMS: ReadonlySet<VariantKind> = new Set([...ADDS, 'double-hats', 'stutter']);

/** A clip as the step planner sees it. */
export interface ClipForSteps {
  start: Tick;
  length: Tick;
  content: Content;
  section: number;
  /** Clips of the same source play the same pattern. */
  source: PatternId | string;
}

/** A clip under an event, with its index in the clip list. */
interface ClipUnder {
  clip: ClipForSteps;
  index: number;
}

/**
 * Song events → each clip's steps. Fills, builds, rolls and open hats go to the clip with the most
 * drums (or hats) where they land; the other clips' drums make room for a fill. Slides go to clips
 * with an 808; gaps, dropouts, stutters and the whole-section changes go to every clip under them.
 */
export function stepsForClips(events: readonly SongEvent[], clips: readonly ClipForSteps[]): VariantStep[][] {
  const out: VariantStep[][] = clips.map(() => []);
  for (const event of events) {
    const span = eventSpan(event);
    if (span.to <= span.from) continue;
    const under = clips
      .map((clip, index) => ({ clip, index }))
      .filter(
        ({ clip }) => clip.section === event.section && clip.start < span.to && clip.start + clip.length > span.from,
      );
    if (!under.length) continue;
    const give = (index: number, kind: VariantKind) => {
      out[index]!.push(stepForClip(event, span, clips[index]!, kind));
    };
    if (ADDS.has(event.kind)) {
      giveToBestClip(event, under, give);
    } else if (event.kind === 'slide') {
      for (const u of under) if (u.clip.content.bass808 > 0) give(u.index, 'slide');
    } else {
      for (const u of under) give(u.index, event.kind);
    }
  }
  return out.map(sortSteps);
}

/** The part of an event a clip plays, in the clip's own ticks. */
function stepForClip(
  event: SongEvent,
  span: { from: Tick; to: Tick },
  clip: ClipForSteps,
  kind: VariantKind,
): VariantStep {
  const from = Math.max(span.from, clip.start);
  const to = Math.min(span.to, clip.start + clip.length);
  const step: VariantStep = { kind, from: from - clip.start, to: to - clip.start, energy: event.energy };
  if (event.level !== undefined) step.level = event.level;
  if (event.parts?.length) step.parts = [...event.parts];
  const total = event.total ?? event.to - event.from;
  // A snare build that this clip plays only part of needs to know where it sits in the whole build.
  if (kind === 'snare-build' && (from > event.from || to < event.from + total)) {
    step.offset = from - event.from;
    step.total = total;
  }
  return normalizeStep(step);
}

/**
 * One source plays an added change (every clip of that source under it, for a build over several
 * loops): the one with the most drums, or hats for rolls and open hats. For a fill the other
 * sources' drums make room.
 */
function giveToBestClip(event: SongEvent, under: ClipUnder[], give: (index: number, kind: VariantKind) => void): void {
  const isFill = event.kind !== 'hat-roll' && event.kind !== 'open-hat';
  const score = (content: Content) => (isFill ? content.drums : content.hats);
  const best = [...under].sort((a, b) => score(b.clip.content) - score(a.clip.content) || a.index - b.index)[0]!;
  if (score(best.clip.content) === 0) return;
  for (const u of under) {
    if (u.clip.source === best.clip.source) give(u.index, event.kind);
    else if (isFill && u.clip.content.drums > 0) give(u.index, 'clear-drums');
  }
}
