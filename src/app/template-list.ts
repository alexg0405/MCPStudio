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
  /** Where the welcome page lists it: the beat styles, or dance and bass music. */
  group: 'beats' | 'dance';
}

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'trap',
    name: 'Trap',
    description: '140 BPM half-time drums, hat rolls and a sliding 808',
    prompt: 'dark trap with 808s and hat rolls',
    bpm: 140,
    group: 'beats',
  },
  {
    id: 'boom-bap',
    name: 'Boom bap',
    description: '90 BPM swung drums with a dusty bass line',
    prompt: 'boom bap with a bass line',
    bpm: 90,
    group: 'beats',
  },
  {
    id: 'house',
    name: 'House',
    description: '124 BPM four on the floor, offbeat hats and a bass',
    prompt: 'house with a bass line',
    bpm: 124,
    group: 'beats',
  },
  { id: 'lofi', name: 'Lo-fi', description: '80 BPM soft, swung drums and mellow keys', prompt: 'lofi chill with keys', bpm: 80, group: 'beats' },
  {
    id: 'drill',
    name: 'Drill',
    description: '142 BPM syncopated kicks and sliding 808s',
    prompt: 'uk drill with sliding 808s',
    bpm: 142,
    group: 'beats',
  },
  {
    id: 'big-room',
    name: 'Big room',
    description: '128 BPM festival drop: four on the floor, a mono lead over sidechained supersaw pads',
    prompt: 'big room festival drop with a mono lead',
    bpm: 128,
    group: 'dance',
  },
  {
    id: 'progressive-house',
    name: 'Progressive house',
    description: '126 BPM rolling bass, piano chords and a pluck arp for long builds',
    prompt: 'progressive house with a rolling bass',
    bpm: 126,
    group: 'dance',
  },
  {
    id: 'future-bass',
    name: 'Future bass',
    description: '150 BPM half-time drums, wobbling supersaw chords and a vocal-chop lead',
    prompt: 'future bass with supersaw chords',
    bpm: 150,
    group: 'dance',
  },
  {
    id: 'dubstep',
    name: 'Dubstep',
    description: '140 BPM half-time, a sub and a growling bass, the snare on beat 3',
    prompt: 'dubstep with a growl bass',
    bpm: 140,
    group: 'dance',
  },
  {
    id: 'melodic-dubstep',
    name: 'Melodic dubstep',
    description: '145 BPM half-time with big emotional supersaws and piano',
    prompt: 'melodic dubstep with piano',
    bpm: 145,
    group: 'dance',
  },
  {
    id: 'tech-house',
    name: 'Tech house',
    description: '126 BPM shuffled hats, a groovy bassline and minimal stabs',
    prompt: 'tech house with a groovy bass',
    bpm: 126,
    group: 'dance',
  },
  {
    id: 'trance',
    name: 'Trance',
    description: '138 BPM offbeat bass, gated supersaws and a 16th arp',
    prompt: 'trance with gated supersaws',
    bpm: 138,
    group: 'dance',
  },
  {
    id: 'drum-and-bass',
    name: 'Drum & bass',
    description: '174 BPM two-step breaks with a reese bass, liquid chords on top',
    prompt: 'liquid drum and bass with a reese bass',
    bpm: 174,
    group: 'dance',
  },
];

/** Starts a new project from a template (asks about unsaved changes first); loads the template builder on first use. */
export async function startFromTemplate(s: Services, id: string): Promise<boolean> {
  return (await import('./templates')).newFromTemplate(s, id);
}
