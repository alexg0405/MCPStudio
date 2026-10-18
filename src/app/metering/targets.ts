/**
 * Which loudness the Meters window draws as its target line: the song's own (a reference song's, else its style's from
 * auto-level) or a streaming preset the musician picked.
 */
import { inferStyle, STYLE_LABELS } from '@core/beat/style';
import type { Project } from '@core/model/types';
import { STREAMING_TARGETS } from '@core/metering/targets';
import { loudnessTarget } from '@core/reference/track';
import { LEVEL_TARGETS } from '../mix/auto-level';

/** What the musician chose: automatic, one of the song's own targets, a streaming preset, or no line. */
export type TargetChoice = 'auto' | 'reference' | 'style' | 'streaming' | 'apple' | 'broadcast' | 'none';

export const TARGET_CHOICES: readonly TargetChoice[] = ['auto', 'reference', 'style', 'streaming', 'apple', 'broadcast', 'none'];

export interface ResolvedTarget {
  choice: TargetChoice;
  /** Where the number comes from, in words: "Reference song", "House style", "Streaming (−14 LUFS)". */
  label: string;
  /** The line to draw (LUFS), null for none. */
  lufs: number | null;
}

/** What each choice means for this project. A choice that cannot apply (no reference song) falls back to the style's. */
export function resolveTarget(choice: TargetChoice, project: Project): ResolvedTarget {
  const style = inferStyle(project);
  const styleTarget: ResolvedTarget = { choice: 'style', label: `${STYLE_LABELS[style]} style`, lufs: LEVEL_TARGETS[style].master };
  const reference = project.reference;
  const referenceTarget: ResolvedTarget | null = reference
    ? { choice: 'reference', label: 'Reference song', lufs: loudnessTarget(reference) }
    : null;
  if (choice === 'none') return { choice, label: 'No target', lufs: null };
  if (choice === 'reference') return referenceTarget ?? styleTarget;
  if (choice === 'style') return styleTarget;
  if (choice === 'auto') return referenceTarget ?? styleTarget;
  const preset = STREAMING_TARGETS.find((t) => t.id === choice);
  return preset ? { choice, label: preset.label, lufs: preset.lufs } : styleTarget;
}
