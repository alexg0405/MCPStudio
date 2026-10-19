import type { Draft } from 'immer';
import { newId } from '../../model/ids';
import type { ChannelId, Pattern, PatternId, Project, VariantStep } from '../../model/types';
import { addPattern } from '../../ops/playlist';
import type { VariantEnv } from '../fills';
import { lengthOfPattern, notesHash, setHash, toNoteMap } from '../notes';
import { applySteps, normalizeStep, variantKey, variantName, variantSeed } from '../variants';

/** A variant whose notes still match what the arranger made (nobody edited it by hand). */
export const isUnmodified = (pat: Pattern): boolean => !!pat.derived && notesHash(pat.notes) === pat.derived.hash;

/** The pattern a clip's pattern varies (an unmodified variant's source), and the steps it already has. */
export function rootOf(p: Project, pid: PatternId): { root: PatternId; steps: VariantStep[] } {
  const pat = p.patterns[pid];
  if (pat?.derived && p.patterns[pat.derived.from] && isUnmodified(pat)) {
    return { root: pat.derived.from, steps: pat.derived.steps.map(normalizeStep) };
  }
  return { root: pid, steps: [] };
}

/** The name, or "name 2", "name 3"… when a pattern (other than `except`) already has it. */
function uniqueName(d: Draft<Project>, name: string, except?: PatternId): string {
  const taken = new Set(
    Object.values(d.patterns)
      .filter((x) => x.id !== except)
      .map((x) => x.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

const channelNamer = (d: Draft<Project>) => (id: string) => d.channels[id as ChannelId]?.name;

/**
 * The variant of `sourceId` with `steps`: an existing one (rebuilt if its source changed since),
 * else a new pattern after the source. Steps that change nothing are left out; with none left the
 * source itself is the answer.
 */
export function deriveVariant(
  d: Draft<Project>,
  sourceId: PatternId,
  steps: readonly VariantStep[],
  env: VariantEnv,
): PatternId {
  const p = d as unknown as Project;
  const source = p.patterns[sourceId];
  if (!source || steps.length === 0) return sourceId;
  const length = lengthOfPattern(p, sourceId);
  const firstSeed = variantSeed(source.name, steps);
  const { effective } = applySteps(source.notes, steps, env, { seed: firstSeed, length });
  if (!effective.length) return sourceId;
  const existing = findVariant(d, sourceId, effective);
  if (existing) {
    rebuild(d, existing, env);
    return existing;
  }
  const seed = variantSeed(source.name, effective);
  const { set } = applySteps(source.notes, effective, env, { seed, length });
  const id = newId.pattern();
  const pattern: Pattern = {
    id,
    name: uniqueName(d, variantName(source.name, effective, channelNamer(d))),
    color: source.color,
    stepCount: source.stepCount,
    length,
    notes: toNoteMap(set),
    derived: { from: sourceId, steps: effective.map(normalizeStep), seed, hash: setHash(set) },
  };
  addPattern(d, pattern, indexAfterVariants(d, sourceId));
  return id;
}

/** An unmodified variant of the source that already has these effective steps. */
function findVariant(d: Draft<Project>, sourceId: PatternId, effective: readonly VariantStep[]): PatternId | null {
  const p = d as unknown as Project;
  const key = variantKey(sourceId, effective);
  for (const pid of d.patternOrder) {
    const pat = p.patterns[pid];
    if (!pat?.derived || pat.derived.from !== sourceId || !isUnmodified(pat)) continue;
    if (variantKey(sourceId, pat.derived.steps) === key) return pid;
  }
  return null;
}

/** Where a new variant goes: after the source and its other variants. */
function indexAfterVariants(d: Draft<Project>, sourceId: PatternId): number {
  const p = d as unknown as Project;
  let at = d.patternOrder.indexOf(sourceId) + 1;
  while (at < d.patternOrder.length && p.patterns[d.patternOrder[at]!]?.derived?.from === sourceId) at++;
  return at;
}

/** Rebuilds an unmodified variant from its source's current notes; true when its notes changed. */
function rebuild(d: Draft<Project>, pid: PatternId, env: VariantEnv): boolean {
  const p = d as unknown as Project;
  const pat = d.patterns[pid];
  const derived = pat?.derived;
  const source = derived ? p.patterns[derived.from] : undefined;
  if (!pat || !derived || !source) return false;
  const length = lengthOfPattern(p, derived.from);
  const { set } = applySteps(source.notes, derived.steps, env, { seed: derived.seed, length });
  const hash = setHash(set);
  if (pat.length !== length) pat.length = length;
  if (pat.stepCount !== source.stepCount) pat.stepCount = source.stepCount;
  if (hash === derived.hash) return false;
  pat.notes = toNoteMap(set) as never;
  derived.hash = hash;
  return true;
}

/**
 * Rebuilds the variants of `sources` (default: every source) from their sources' notes. Variants
 * edited by hand (notes no longer match their hash) are left alone and reported.
 */
export function refreshVariants(
  d: Draft<Project>,
  env: VariantEnv,
  sources?: ReadonlySet<PatternId>,
): { rebuilt: PatternId[]; handEdited: PatternId[] } {
  const p = d as unknown as Project;
  const rebuilt: PatternId[] = [];
  const handEdited: PatternId[] = [];
  for (const pid of [...d.patternOrder]) {
    const pat = p.patterns[pid];
    if (!pat?.derived || !p.patterns[pat.derived.from]) continue;
    if (sources && !sources.has(pat.derived.from)) continue;
    if (!isUnmodified(pat)) {
      handEdited.push(pid);
      continue;
    }
    if (rebuild(d, pid, env)) rebuilt.push(pid);
  }
  return { rebuilt, handEdited };
}
