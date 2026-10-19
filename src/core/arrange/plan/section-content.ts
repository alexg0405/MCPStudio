import type { ChannelId, PatternId, Project, VariantStep } from '../../model/types';
import { capabilities, type VariantEnv } from '../fills';
import { lengthOfPattern, type NoteSet } from '../notes';
import type { SectionCaps } from '../phrases';
import { inPart, isBassRole, isDrumRole, noteRole } from '../roles';
import type { SectionSpan, SectionSpec } from '../sections';
import { applySteps, variantSeed } from '../variants';

/** What a pattern holds once its section's changes are applied: note counts by kind, and what it can play. */
export interface Content {
  drums: number;
  hats: number;
  bass808: number;
  bassAny: number;
  caps: SectionCaps;
}

/** How many drum, hat and bass notes a note set holds, and what it can play. */
export function contentOf(set: NoteSet, env: VariantEnv): Content {
  let drums = 0;
  let hats = 0;
  let bass808 = 0;
  let bassAny = 0;
  for (const [channelId, list] of set) {
    const channelRole = env.roles.get(channelId) ?? 'other';
    for (const note of list) {
      const role = noteRole(channelRole, note.key);
      if (isDrumRole(role)) drums++;
      if (role === 'hat') hats++;
      if (channelRole === '808') bass808++;
      if (isBassRole(channelRole)) bassAny++;
    }
  }
  return { drums, hats, bass808, bassAny, caps: capabilities(set, env) };
}

/** Parts that may go when a section would otherwise be silent: the hats and percussion stay. */
const KEPT_WHEN_LIGHTENING = ['drums', 'hats', 'perc', 'toms', 'open-hat'];

/** Energy this far under a pattern's home energy thins it (2 → light, 3 → sparse). */
const THIN_ENERGY_GAP = 2;
const SPARSE_ENERGY_GAP = 3;

/** How thin a section plays a beat whose loudest section is `home`: 2 energy below thins it, 3 makes it sparse. */
export function thinLevel(s: Pick<SectionSpec, 'energy' | 'vary'>, home: number): number {
  if (s.vary === 'none') return 0;
  const gap = home - s.energy;
  if (gap >= SPARSE_ENERGY_GAP) return 2;
  if (gap >= THIN_ENERGY_GAP) return 1;
  return 0;
}

const cleanedParts = (parts: readonly string[]) => parts.filter((x) => x.trim()).map((x) => x.trim());

/**
 * What each section's patterns hold once the section's own changes are applied (parts left out,
 * thinner drums), and what follows from that: what a section can play (so phrase rules only ask for
 * fills it can make), and the loop length the "no long repeats" rule works with.
 */
export class SectionContent {
  /** Each source's "home" energy: the loudest section that plays it. Quieter sections play it thinner. */
  private readonly home = new Map<PatternId, number>();
  private readonly cache = new Map<string, Content>();

  constructor(
    private readonly project: Project,
    private readonly env: VariantEnv,
    private readonly barTicks: number,
    sections: readonly SectionSpan[],
  ) {
    for (const s of sections) for (const pid of s.play) this.home.set(pid, Math.max(this.home.get(pid) ?? 0, s.energy));
  }

  /** The whole-section steps (left-out parts, thinner drums) for one of the section's patterns. */
  wideSteps(s: SectionSpan, pid: PatternId): VariantStep[] {
    const length = lengthOfPattern(this.project, pid);
    const steps: VariantStep[] = [];
    const without = this.withoutOf(s);
    if (without.length) steps.push({ kind: 'without', from: 0, to: length, parts: without });
    const thin = thinLevel(s, this.home.get(pid) ?? s.energy);
    if (thin) steps.push({ kind: 'thin', from: 0, to: length, level: thin });
    return steps;
  }

  /** One pattern's content in a section (computed once per pattern and set of whole-section steps). */
  content(s: SectionSpan, pid: PatternId): Content {
    const steps = this.wideSteps(s, pid);
    const key = `${pid}|${JSON.stringify(steps)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pattern = this.project.patterns[pid];
    const set = pattern
      ? applySteps(pattern.notes, steps, this.env, {
          seed: variantSeed(pattern.name, steps),
          length: lengthOfPattern(this.project, pid),
        }).set
      : new Map();
    const content = contentOf(set, this.env);
    this.cache.set(key, content);
    return content;
  }

  /** What any of the section's patterns can play. */
  caps(s: SectionSpan): SectionCaps {
    const caps: SectionCaps = { drums: false, hats: false, openHat: false, slide: false };
    for (const pid of s.play) {
      const c = this.content(s, pid).caps;
      caps.drums ||= c.drums;
      caps.hats ||= c.hats;
      caps.openHat ||= c.openHat;
      caps.slide ||= c.slide;
    }
    return caps;
  }

  /** The shortest drum or bass loop playing in the section, in bars (0: none). */
  loopBars(s: SectionSpan): number {
    let best = 0;
    for (const pid of s.play) {
      const c = this.content(s, pid);
      if (!c.drums && !c.bassAny) continue;
      const bars = lengthOfPattern(this.project, pid) / this.barTicks;
      if (bars > 0 && (best === 0 || bars < best)) best = bars;
    }
    return best;
  }

  /**
   * The parts a section leaves out. Leaving out every part that plays would make the section silent
   * (the music seems to stop): keep the hats and percussion then, or failing that leave nothing out.
   */
  private withoutOf(s: SectionSpan): string[] {
    const asked = cleanedParts(s.without);
    if (!asked.length || this.hasSound(s, asked)) return asked;
    const lighter = [...asked.filter((x) => !KEPT_WHEN_LIGHTENING.includes(x)), 'kick', 'snare', 'crash'];
    return this.hasSound(s, lighter) ? [...new Set(lighter)] : [];
  }

  /** Whether anything but effects still plays in a section with these parts left out. */
  private hasSound(s: SectionSpan, parts: readonly string[]): boolean {
    return s.play.some((pid) =>
      Object.entries(this.project.patterns[pid]?.notes ?? {}).some(
        ([channelId, notes]) =>
          this.env.roles.get(channelId as ChannelId) !== 'fx' &&
          Object.values(notes).some((n) => !this.isLeftOut(parts, channelId as ChannelId, n.key)),
      ),
    );
  }

  private isLeftOut(parts: readonly string[], channelId: ChannelId, key: number): boolean {
    return parts.some((part) => part === channelId || inPart(part, this.env.roles.get(channelId) ?? 'other', key));
  }
}
