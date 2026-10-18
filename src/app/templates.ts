/**
 * Project templates: a new project that already has a beat in a style, at its tempo, arranged as a
 * short song by the arranger (a 4-bar intro without drums and bass, then 8 bars with fills and a
 * transition) on a mix set up by role. Built offline: no AI needed.
 */
import { produce } from 'immer';
import { generateLocalBeat } from '@core/beat/local';
import { removePattern } from '@core/ops/playlist';
import type { SectionSpec } from '@core/arrange/sections';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import type { PatternId, Project } from '@core/model/types';
import { arrangeInDraft } from './arrange/run';
import { applyLoudness } from './mix/auto-level';
import { findMixLayout } from './mix/layout';
import { TEMPLATE_LEVELS } from './template-levels';
import { planBeat, writeBeat } from './assistant/apply';
import { createDefaultProject } from './default-project';
import { TEMPLATES, type ProjectTemplate } from './template-list';
import type { Services } from './services';

export { TEMPLATES, type ProjectTemplate };

/**
 * The template's starting project: its beat, arranged as an intro and a main section, the mix leveled to its style's loudness with the
 * measured settings of `template-levels.ts` (`levels: false` leaves the faders and the master as the mix setup made them: what the
 * measuring starts from).
 */
export function templateProject(s: Services, t: ProjectTemplate, opts: { levels?: boolean } = {}): { project: Project; patternId: PatternId } {
  const spec = generateLocalBeat({ prompt: t.prompt, bpm: t.bpm });
  spec.bpm = t.bpm;
  spec.title = `${t.name} beat`;
  let patternId = '' as PatternId;
  const empty = createDefaultProject(s.plugins);
  const project = produce(empty, (d) => {
    const plan = planBeat(s, d as Project, spec, null);
    writeBeat(s, d, spec, plan);
    patternId = plan.patternId;
    const section = (name: string, role: SectionSpec['role'], bars: number, energy: number, without: string[]): SectionSpec => ({
      name,
      role,
      bars,
      energy,
      play: [patternId],
      without,
      vary: 'auto',
      transitionIn: 'auto',
      fill: 'auto',
    });
    arrangeInDraft(d, s, empty, {
      replace: true,
      ...(spec.style ? { style: spec.style } : {}),
      sections: [section('Intro', 'intro', 4, 2, ['drums', 'bass']), section(t.name, 'drop', 8, 4, [])],
      fx: 'auto',
      mix: 'auto',
      ending: 'auto',
    });
    // The default project's empty first pattern: the beat went into a new one, so nothing plays or needs it.
    const first = empty.patternOrder[0];
    if (first && first !== patternId && d.patterns[first] && Object.keys(d.patterns[first]!.notes).length === 0 && !referenced(d as Project, first))
      removePattern(d, first);
    const levels = TEMPLATE_LEVELS[t.id];
    if (levels && opts.levels !== false) {
      const layout = findMixLayout(d as Project);
      for (const [role, db] of Object.entries(levels.faders) as [keyof typeof layout.buses, number][]) {
        const id = layout.buses[role];
        if (id && d.mixer.inserts[id]) d.mixer.inserts[id]!.volume = Math.min(MAX_INSERT_VOLUME, Math.pow(10, db / 20));
      }
      applyLoudness(d, s, layout.limiter, { limiter: levels.limiter, maximizer: levels.maximizer });
    }
  });
  return { project, patternId };
}

/** Whether a clip plays the pattern, or another pattern is a variant of it. */
function referenced(p: Project, id: PatternId): boolean {
  return (
    Object.values(p.playlist.clips).some((c) => c.kind === 'pattern' && c.patternId === id) ||
    Object.values(p.patterns).some((x) => x.derived?.from === id)
  );
}

/** Starts a new project from a template (asks about unsaved changes first). */
export async function newFromTemplate(s: Services, id: string): Promise<boolean> {
  const t = TEMPLATES.find((x) => x.id === id || x.name.toLowerCase() === id.trim().toLowerCase());
  if (!t) {
    s.session.getState().toast(`There is no template called “${id}”.`, 'error');
    return false;
  }
  const { project, patternId } = templateProject(s, t);
  if (!(await s.files.newProject(project))) return false;
  s.view.getState().setCurrentPattern(patternId);
  s.session.getState().toast(`New ${t.name} project: press Space to hear it, then make it yours.`);
  return true;
}
