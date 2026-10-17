/**
 * Which of the musician's own patterns play in each section of an arrangement that follows the reference.
 * The reference only says how long each part is and how loud; the notes come from the project. Its
 * existing sections are the palette (what plays in its quiet parts and in its loud parts); a project
 * with no song yet gets its patterns layered from the sparsest to all of them. Pure.
 */
import { rootOf } from '../arrange/apply';
import type { VariantEnv } from '../arrange/fills';
import { inferSections } from '../arrange/infer';
import { isPeak, type SectionRole } from '../arrange/sections';
import type { PatternClip, PatternId, Project } from '../model/types';
import { mutedLanes } from '../query/playlist';
import type { PlannedSection } from './plan';

export interface Material {
  /** Where it comes from, for the chat ("Verse of your song", "3 patterns"). */
  from: string;
  role: SectionRole;
  /** 1–5. */
  energy: number;
  play: PatternId[];
}

/** The groups of patterns the project already plays together, with how full each is. */
export function materialOf(p: Project, env: VariantEnv): Material[] {
  const off = mutedLanes(p.playlist);
  const clips = Object.values(p.playlist.clips).filter(
    (c): c is PatternClip => c.kind === 'pattern' && !c.muted && !off.has(c.laneId) && !!p.patterns[c.patternId],
  );
  const out: Material[] = [];
  if (clips.length) {
    for (const s of inferSections(p, env)) {
      const lanes = new Map<PatternId, number>();
      for (const c of clips) {
        if (c.start >= s.to || c.start + c.length <= s.from) continue;
        const root = rootOf(p, c.patternId).root;
        if (!lanes.has(root)) lanes.set(root, p.playlist.laneOrder.indexOf(c.laneId));
      }
      const play = [...lanes.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      if (!play.length) continue;
      const key = play.slice().sort().join();
      // The same patterns again (a Drop 2): the first one stands for both.
      if (out.some((m) => m.play.slice().sort().join() === key)) continue;
      out.push({ from: `“${s.name}” of your song`, role: s.role, energy: s.energy, play });
    }
    if (out.length) return out;
  }
  // No song yet: the patterns with notes, the sparsest first, layered up.
  const noteCount = (id: PatternId) => Object.values(p.patterns[id]!.notes).reduce((n, byCh) => n + Object.keys(byCh).length, 0);
  const patterns = p.patternOrder
    .filter((id) => p.patterns[id] && !p.patterns[id]!.derived && noteCount(id) > 0)
    .sort((a, b) => noteCount(a) - noteCount(b) || p.patternOrder.indexOf(a) - p.patternOrder.indexOf(b));
  const k = patterns.length;
  for (let j = 1; j <= k; j++) {
    const energy = k === 1 ? 3 : 1 + Math.round((4 * (j - 1)) / (k - 1));
    out.push({
      from: j === 1 ? `“${p.patterns[patterns[0]!]!.name}”` : j === k ? (k === 2 ? 'both patterns' : `all ${k} patterns`) : `${j} patterns`,
      role: energy >= 4 ? 'drop' : energy <= 2 ? 'break' : 'verse',
      energy,
      play: patterns.slice(0, j),
    });
  }
  return out;
}

const family = (r: SectionRole): 'peak' | 'low' | 'mid' => (isPeak(r) ? 'peak' : r === 'intro' || r === 'outro' || r === 'break' || r === 'bridge' ? 'low' : 'mid');

/** The best material for a section: closest energy, and the same kind of part when there is a tie. */
export function pickMaterial(section: Pick<PlannedSection, 'role' | 'energy'>, materials: readonly Material[]): Material | null {
  let best: Material | null = null;
  let bestCost = Infinity;
  for (const m of materials) {
    const cost = Math.abs(m.energy - section.energy) * 2 + (m.role === section.role ? 0 : family(m.role) === family(section.role) ? 0.5 : 1);
    if (cost < bestCost) {
      best = m;
      bestCost = cost;
    }
  }
  return best;
}

export interface AssignedSection extends PlannedSection {
  play: PatternId[];
  /** Where the patterns came from. */
  from: string;
}

/** Each planned section with the patterns that play in it (none when the project has no patterns). */
export function assignMaterial(sections: readonly PlannedSection[], materials: readonly Material[]): AssignedSection[] {
  return sections.flatMap((s) => {
    const m = pickMaterial(s, materials);
    return m ? [{ ...s, play: m.play, from: m.from }] : [];
  });
}
