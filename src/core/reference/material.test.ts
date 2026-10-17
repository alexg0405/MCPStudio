import { describe, expect, it } from 'vitest';
import { variantEnv } from '../arrange/variants';
import type { PatternId } from '../model/types';
import { assignMaterial, materialOf, pickMaterial, type Material } from './material';
import { planReferenceSections } from './plan';
import { fakeReference } from './fixtures';
import { HINT, kitProject, notes, trapGroove } from '../../../test/helpers/arrange';

const mat = (energy: number, role: Material['role'], id: string): Material => ({ from: id, role, energy, play: [id as PatternId] });

describe('which of your patterns play in each section', () => {
  it('picks the material with the closest energy, the same part when it is a tie', () => {
    const palette = [mat(1, 'intro', 'a'), mat(3, 'verse', 'b'), mat(5, 'drop', 'c')];
    expect(pickMaterial({ role: 'intro', energy: 2 }, palette)?.from).toBe('a');
    expect(pickMaterial({ role: 'drop', energy: 5 }, palette)?.from).toBe('c');
    expect(pickMaterial({ role: 'break', energy: 2 }, palette)?.from).toBe('a');
    expect(pickMaterial({ role: 'verse', energy: 4 }, [mat(3, 'verse', 'b'), mat(5, 'drop', 'c')])?.from).toBe('b');
    expect(pickMaterial({ role: 'drop', energy: 5 }, [])).toBeNull();
  });

  it('with no song yet, layers the patterns from the sparsest to all of them', () => {
    const { project } = kitProject((k) => ({
      Pad: { notes: { [k.pad]: trapGroove(k)[k.pad]! } },
      Beat: { notes: trapGroove(k) },
      Lead: { notes: { [k.lead]: notes([[0, 65], [4, 68]]) } },
    }));
    const m = materialOf(project, variantEnv(project, { style: 'trap', hint: HINT }));
    expect(m.map((x) => x.play.length)).toEqual([1, 2, 3]);
    // Lead (2 notes) is the sparsest; the energy rises with every pattern added.
    expect(m.map((x) => x.energy)).toEqual([1, 3, 5]);
    const sections = assignMaterial(planReferenceSections(fakeReference(), 240 / 128).sections, m);
    expect(sections.map((s) => s.play.length)).toEqual([1, 3, 1, 3]);
    expect(sections.every((s) => s.play.every((id) => project.patterns[id]))).toBe(true);
  });

  it('a project with nothing to play gives no sections', () => {
    const { project } = kitProject(() => ({}));
    expect(materialOf(project, variantEnv(project, { style: 'trap', hint: HINT }))).toEqual([]);
    expect(assignMaterial(planReferenceSections(fakeReference(), 2).sections, [])).toEqual([]);
  });
});
