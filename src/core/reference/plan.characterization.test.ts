/**
 * Characterization of the reference plan: the sections (names, roles, bars, energies, seconds) and the notes for
 * hundreds of seeded references and tempos, including references with tiny parts, huge parts and too many sections.
 * It exists so the planner can be reorganised without changing what it plans.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import type { ReferenceSection, ReferenceTrack } from '../model/types';
import { mulberry32 } from '../voice/test-signals';
import { planReferenceSections } from './plan';

const KINDS: ReferenceSection['kind'][] = ['intro', 'build', 'drop', 'break', 'verse', 'outro', 'body'];

function reference(seed: number, count: number, longest: number): Pick<ReferenceTrack, 'sections'> {
  const rand = mulberry32(seed);
  const sections: ReferenceSection[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const length = 0.5 + rand() * rand() * longest;
    sections.push({
      kind: KINDS[Math.floor(rand() * KINDS.length)] as ReferenceSection['kind'],
      startSec: at,
      endSec: at + length,
      bars: Math.max(1, Math.round(length / 1.875)),
      energy: rand(),
      bands: [],
      width: 0,
    });
    at += length;
  }
  return { sections };
}

describe('reference plan characterization', () => {
  it('plans the same sections for every reference', async () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const count = [1, 2, 4, 7, 12, 30, 45][seed % 7] as number;
      const longest = [20, 60, 200, 900][seed % 4] as number;
      const ref = reference(seed, count, longest);
      for (const barSeconds of [1.5, 1.875, 3.75]) {
        const plan = planReferenceSections(ref, barSeconds);
        const sections = plan.sections.map(
          (s) =>
            `${s.name}/${s.role}/${s.bars}/${s.energy}/${s.refEnergy.toFixed(6)}/${s.fromSec.toFixed(4)}-${s.toSec.toFixed(4)}`,
        );
        lines.push(`#${seed} ${count} sections at ${barSeconds} s: ${sections.join(' ')} | ${plan.notes.join(' ')}`);
      }
    }
    lines.push(`empty: ${JSON.stringify(planReferenceSections({ sections: [] }, 2))}`);
    lines.push(`bad bar: ${JSON.stringify(planReferenceSections(reference(1, 3, 20), 0))}`);
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/reference-plan.txt');
  });
});
