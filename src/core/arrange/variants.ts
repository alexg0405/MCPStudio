/**
 * Variants: a pattern's notes with variant steps applied (a fill at bar 8, an 808 slide, the drums
 * left out). The source stays the editable pattern; a variant records its steps and seed so it can
 * be rebuilt when the source changes, and a hash of the notes it wrote to tell when someone edited
 * it by hand. Variants of one source with the same steps are one pattern ("Drop · fill + slide").
 */
import type { Style } from '../beat/style';
import type { ChannelId, Pattern, PatternId, Project, VariantKind, VariantStep } from '../model/types';
import { applyStep, type VariantEnv } from './fills';
import { cloneSet, setHash, tidySet, toNoteSet, type NoteSet } from './notes';
import { hashString, mulberry32 } from './random';
import { channelRoles, partName, type Role, type RoleHint } from './roles';

/** How high a tom sounds (2 high … 0 low), from its kit sound or its name. */
function tomHeight(p: Project, cid: ChannelId): number | undefined {
  const ch = p.channels[cid];
  if (!ch || ch.kind === 'automation') return undefined;
  const sid = ch.kind === 'instrument' ? ch.plugin.samples?.main : ch.sampleId;
  const src = sid ? p.samples[sid]?.source : undefined;
  const text = `${src?.kind === 'builtin' ? src.generator : ''} ${ch.name}`.toLowerCase();
  if (/high|\bhi\b/.test(text)) return 2;
  if (/mid/.test(text)) return 1;
  if (/low|floor/.test(text)) return 0;
  return undefined;
}

/** What the generators need to know about a project's channels (read with plain loops: drafts are fine). */
export function variantEnv(
  p: Project,
  opts: { style: Style; hint?: RoleHint; scale?: VariantEnv['scale']; roles?: ReadonlyMap<ChannelId, Role> },
): VariantEnv {
  const roles = opts.roles ?? channelRoles(p, opts.hint);
  const channels = new Map<ChannelId, { rootKey: number; order: number; height?: number }>();
  p.channelOrder.forEach((cid, order) => {
    const ch = p.channels[cid];
    if (!ch || ch.kind === 'automation') return;
    const height = roles.get(cid) === 'tom' ? tomHeight(p, cid) : undefined;
    channels.set(cid, { rootKey: ch.kind === 'instrument' ? ch.rootKey : 60, order, ...(height !== undefined ? { height } : {}) });
  });
  return { roles, channels, style: opts.style, scale: opts.scale ?? null };
}

export const KIND_LABEL: Record<VariantKind, string> = {
  'snare-fill': 'fill',
  'tom-fill': 'tom fill',
  'hat-fill': 'hat fill',
  'kick-fill': 'kick fill',
  'snare-build': 'build',
  'hat-roll': 'hat roll',
  'open-hat': 'open hat',
  slide: 'slide',
  gap: 'gap',
  dropout: 'dropout',
  stutter: 'stutter',
  thin: 'thin',
  'double-hats': 'double hats',
  without: 'without',
  'clear-drums': 'room for fill',
};

/** Steps that do the same job: a new one replaces an older one of its family where they overlap. */
export const FAMILY: Record<VariantKind, string> = {
  'snare-fill': 'fill',
  'tom-fill': 'fill',
  'hat-fill': 'fill',
  'kick-fill': 'fill',
  'snare-build': 'fill',
  'hat-roll': 'small',
  'open-hat': 'small',
  slide: 'slide',
  gap: 'gap',
  dropout: 'gap',
  stutter: 'stutter',
  thin: 'thin',
  'double-hats': 'double-hats',
  without: 'without',
  'clear-drums': 'clear',
};

/** Order steps apply in: whole-section changes first, then fills, small changes, slides, gaps. */
const RANK: Record<VariantKind, number> = {
  without: 0,
  thin: 1,
  'double-hats': 2,
  'clear-drums': 3,
  'snare-build': 4,
  'snare-fill': 5,
  'tom-fill': 5,
  'hat-fill': 5,
  'kick-fill': 5,
  'hat-roll': 6,
  'open-hat': 6,
  slide: 7,
  stutter: 8,
  gap: 9,
  dropout: 10,
};

export const FILL_KINDS: ReadonlySet<VariantKind> = new Set(['snare-fill', 'tom-fill', 'hat-fill', 'kick-fill', 'snare-build']);

/** The step with its fields in a fixed order and no empty ones (equal steps print equal). */
export function normalizeStep(s: VariantStep): VariantStep {
  const out: VariantStep = { kind: s.kind, from: Math.round(s.from), to: Math.round(s.to) };
  if (s.offset) out.offset = Math.round(s.offset);
  if (s.total !== undefined && s.total !== s.to - s.from) out.total = Math.round(s.total);
  if (s.energy !== undefined) out.energy = Math.min(5, Math.max(1, Math.round(s.energy)));
  if (s.level !== undefined) out.level = s.level >= 2 ? 2 : 1;
  if (s.parts?.length) out.parts = [...new Set(s.parts.map((p) => partName(p) ?? p))].sort();
  return out;
}

/** Steps in the order they apply. */
export function sortSteps(steps: readonly VariantStep[]): VariantStep[] {
  return [...steps].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.from - b.from || a.to - b.to);
}

/**
 * Steps merged: a new step replaces older steps of its family that overlap it (a tom fill where a
 * snare fill was), identical steps appear once.
 */
export function mergeSteps(existing: readonly VariantStep[], added: readonly VariantStep[]): VariantStep[] {
  let out = existing.map(normalizeStep);
  for (const raw of added) {
    const s = normalizeStep(raw);
    out = out.filter((o) => !(FAMILY[o.kind] === FAMILY[s.kind] && o.from < s.to && s.from < o.to && FAMILY[s.kind] !== 'without'));
    if (!out.some((o) => JSON.stringify(o) === JSON.stringify(s))) out.push(s);
  }
  return sortSteps(out);
}

/** Identifies a variant: its source and its steps. */
export function variantKey(from: PatternId, steps: readonly VariantStep[]): string {
  return `${from}|${JSON.stringify(sortSteps(steps.map(normalizeStep)))}`;
}

/** The seed of a new variant: from the source's name and the steps (the same variation sounds the same). */
export function variantSeed(sourceName: string, steps: readonly VariantStep[]): number {
  return hashString(`${sourceName}|${JSON.stringify(sortSteps(steps.map(normalizeStep)))}`);
}

/** One step in words: "fill", "slide", "no 808 or hats" (channels by name when `channelName` knows them). */
export function stepLabel(s: VariantStep, channelName?: (id: string) => string | undefined): string {
  if (s.kind === 'without') {
    const parts = (s.parts ?? []).map((p) => (partName(p) ? p : (channelName?.(p) ?? 'a channel')));
    const list = [...new Set(parts)];
    // "no drums or bass" (the words read in the pattern list, after a "·" between steps).
    return list.length ? `no ${list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`}` : 'without';
  }
  if (s.kind === 'thin') return (s.level ?? 1) >= 2 ? 'sparse' : 'thin';
  return KIND_LABEL[s.kind];
}

/** "Drop · fill + slide" (each kind of change once). */
export function variantName(
  sourceName: string,
  steps: readonly VariantStep[],
  channelName?: (id: string) => string | undefined,
): string {
  const labels = [...new Set(sortSteps(steps).map((s) => stepLabel(s, channelName)))];
  return labels.length ? `${sourceName} · ${labels.join(' + ')}` : sourceName;
}

/**
 * The source's notes with the steps applied, and the steps that changed something (a fill on a
 * pattern with no drums does nothing and is left out). Each step draws from its own seeded
 * generator, so leaving a no-op out changes nothing else.
 */
export function applySteps(
  source: Pattern['notes'] | NoteSet,
  steps: readonly VariantStep[],
  env: VariantEnv,
  opts: { seed: number; length: number },
): { set: NoteSet; effective: VariantStep[] } {
  const set = source instanceof Map ? cloneSet(source) : toNoteSet(source);
  const effective: VariantStep[] = [];
  let hash = setHash(set);
  for (const raw of sortSteps(steps.map(normalizeStep))) {
    const step = { ...raw, to: Math.min(raw.to, opts.length) };
    if (step.to <= step.from) continue;
    const rand = mulberry32(opts.seed ^ hashString(JSON.stringify(raw)));
    applyStep(set, step, { env, rand, length: opts.length });
    tidySet(set);
    const next = setHash(set);
    if (next !== hash) effective.push(raw);
    hash = next;
  }
  return { set, effective };
}
