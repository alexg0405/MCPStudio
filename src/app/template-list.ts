import type { Services } from './services';

/**
 * The project templates' names (what menus and the welcome page list) without the code that builds them:
 * the beat generator, the arranger and the mix setup load when a template is first used (`startFromTemplate`).
 * See templates.ts for how a template is built.
 */

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

/** Starts a new project from a template (asks about unsaved changes first); loads the template builder on first use. */
export async function startFromTemplate(s: Services, id: string): Promise<boolean> {
  return (await import('./templates')).newFromTemplate(s, id);
}
