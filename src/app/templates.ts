/**
 * Project templates: a new project that already has a beat in a style, at its tempo, laid out on
 * the playlist, ready to change. Built with the offline beat writer (no AI needed).
 */
import { produce } from 'immer';
import { generateLocalBeat } from '@core/beat/local';
import { newId } from '@core/model/ids';
import type { LaneId, PatternClip, PatternId, Project } from '@core/model/types';
import { addMarker } from '@core/ops/markers';
import { addClips } from '@core/ops/playlist';
import { patternLength } from '@core/query/queries';
import { ticksPerBar } from '@core/time/ppq';
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

/** The template's starting project: its beat as "Pattern 1", repeated over 8 bars of the playlist. */
export function templateProject(s: Services, t: ProjectTemplate): { project: Project; patternId: PatternId } {
  const spec = generateLocalBeat({ prompt: t.prompt, bpm: t.bpm });
  spec.bpm = t.bpm;
  spec.title = `${t.name} beat`;
  let patternId = '' as PatternId;
  const project = produce(createDefaultProject(s.plugins), (d) => {
    const plan = planBeat(s, d as Project, spec, null);
    writeBeat(s, d, spec, plan);
    patternId = plan.patternId;
    const pattern = d.patterns[patternId];
    const lane = d.playlist.laneOrder[0] as LaneId | undefined;
    if (!pattern || !lane) return;
    const len = patternLength(pattern as never, d.transport.timeSig);
    const end = 8 * ticksPerBar(d.transport.timeSig);
    const clips: PatternClip[] = [];
    for (let start = 0; start < end; start += len)
      clips.push({ kind: 'pattern', id: newId.clip(), laneId: lane, start, length: len, patternId, offset: 0 });
    addClips(d, clips);
    addMarker(d, 0, t.name);
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
