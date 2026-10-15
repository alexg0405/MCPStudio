/**
 * Project templates: a new project that already has a beat in a style, at its tempo, arranged as a
 * short song by the arranger (a 4-bar intro without drums and bass, then 8 bars with fills and a
 * transition) on a mix set up by role. Built offline: no AI needed.
 */
import { produce } from 'immer';
import { generateLocalBeat } from '@core/beat/local';
import type { SectionSpec } from '@core/arrange/sections';
import type { PatternId, Project } from '@core/model/types';
import { arrangeInDraft } from './arrange/run';
import { planBeat, writeBeat } from './assistant/apply';
import { createDefaultProject } from './default-project';
import type { Services } from './services';

export interface ProjectTemplate {
  id: string;
  name: string;
  /** What you get, in a few words. */
  description: string;
  prompt: string;
  bpm: number;
}

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'trap',
    name: 'Trap',
    description: '140 BPM half-time drums, hat rolls and a sliding 808',
    prompt: 'dark trap with 808s and hat rolls',
    bpm: 140,
  },
  {
    id: 'boom-bap',
    name: 'Boom bap',
    description: '90 BPM swung drums with a dusty bass line',
    prompt: 'boom bap with a bass line',
    bpm: 90,
  },
  {
    id: 'house',
    name: 'House',
    description: '124 BPM four on the floor, offbeat hats and a bass',
    prompt: 'house with a bass line',
    bpm: 124,
  },
  { id: 'lofi', name: 'Lo-fi', description: '80 BPM soft, swung drums and mellow keys', prompt: 'lofi chill with keys', bpm: 80 },
  {
    id: 'drill',
    name: 'Drill',
    description: '142 BPM syncopated kicks and sliding 808s',
    prompt: 'uk drill with sliding 808s',
    bpm: 142,
  },
];

/** The template's starting project: its beat, arranged as an intro and a main section. */
export function templateProject(s: Services, t: ProjectTemplate): { project: Project; patternId: PatternId } {
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
  });
  return { project, patternId };
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
