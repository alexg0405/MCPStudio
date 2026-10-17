/** The EDM style pack in the offline generator: tempo, kick and snare placement, swing, and the style tables. */
import { describe, expect, it } from 'vitest';
import { generateLocalBeat, mergeOfflinePrompt, parsePrompt } from './local';
import { DRUM_SOUNDS, validateBeatSpec, type BeatSpec } from './spec';
import { FOUR_FLOOR, GROOVE, guessStyle, HALF_TIME, PHRASE, STYLE_LABELS, STYLES, TEMPO, type Style } from './style';

const PACK = ['bigroom', 'proghouse', 'futurebass', 'dubstep', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const satisfies readonly Style[];

/** What each style's tempo range must be (BPM), from the genre conventions. */
const RANGE: Record<(typeof PACK)[number], [number, number]> = {
  bigroom: [126, 128],
  proghouse: [124, 128],
  futurebass: [140, 160],
  dubstep: [140, 150],
  melodicdub: [140, 150],
  techhouse: [124, 128],
  trance: [136, 140],
  dnb: [172, 176],
};

const PROMPT: Record<(typeof PACK)[number], string> = {
  bigroom: 'big room festival drop',
  proghouse: 'progressive house',
  futurebass: 'future bass',
  dubstep: 'dubstep with a growl',
  melodicdub: 'melodic dubstep',
  techhouse: 'tech house',
  trance: 'trance',
  dnb: 'drum and bass',
};

const stepsOf = (spec: BeatSpec, sound: string) => spec.tracks.filter((t) => t.sound === sound).flatMap((t) => t.notes.map((n) => n.step));
const inBar = (steps: number[], bar: number) => steps.filter((s) => s >= bar * 16 && s < bar * 16 + 16).map((s) => s - bar * 16);

describe('EDM pack: the style tables', () => {
  it('lists every style with a label, a groove, a tempo range and phrasing', () => {
    for (const style of PACK) {
      expect(STYLES).toContain(style);
      expect(STYLE_LABELS[style]).toBeTruthy();
      const [min, max] = RANGE[style];
      expect(TEMPO[style].min).toBe(min);
      expect(TEMPO[style].max).toBe(max);
      expect(TEMPO[style].default).toBeGreaterThanOrEqual(min);
      expect(TEMPO[style].default).toBeLessThanOrEqual(max);
      expect(GROOVE[style].hat).toHaveLength(4);
      expect([4, 8]).toContain(PHRASE[style].small);
      expect([8, 16]).toContain(PHRASE[style].fill);
    }
  });

  it('knows which styles are four on the floor and which are half-time', () => {
    for (const style of ['bigroom', 'proghouse', 'techhouse', 'trance'] as const) expect(FOUR_FLOOR.has(style)).toBe(true);
    for (const style of ['futurebass', 'dubstep', 'melodicdub'] as const) expect(HALF_TIME.has(style)).toBe(true);
    expect(FOUR_FLOOR.has('dnb')).toBe(false);
    expect(HALF_TIME.has('dnb')).toBe(false);
  });

  it('swings the shuffled style and keeps the festival ones straight', () => {
    expect(GROOVE.techhouse.swing).toBeGreaterThanOrEqual(0.25);
    expect(GROOVE.bigroom.swing).toBe(0);
    expect(GROOVE.trance.swing).toBe(0);
    expect(GROOVE.dubstep.swing).toBe(0);
  });

  it('guesses drum & bass from a tempo no other style reaches', () => {
    expect(guessStyle(174, 0, false)).toBe('dnb');
    expect(guessStyle(150, 0, false)).toBe('trap');
  });
});

describe('EDM pack: the offline generator', () => {
  it.each(PACK.map((s) => [s] as const))('%s: its name finds it, at a tempo in range with its swing and a valid beat', (style) => {
    expect(parsePrompt(PROMPT[style]).style).toBe(style);
    const spec = generateLocalBeat({ prompt: PROMPT[style], bpm: 100 });
    expect(spec.style).toBe(style);
    const [min, max] = RANGE[style];
    expect(spec.bpm).toBeGreaterThanOrEqual(min);
    expect(spec.bpm).toBeLessThanOrEqual(max);
    expect(spec.swing).toBe(GROOVE[style].swing);
    const checked = validateBeatSpec(spec);
    expect(checked).not.toHaveProperty('error');
    for (const t of spec.tracks) for (const n of t.notes) expect(n.vel, `${style} ${t.name}`).toBeDefined();
    expect(spec.tracks.length).toBeGreaterThanOrEqual(5);
    expect(spec.tracks.some((t) => !DRUM_SOUNDS.has(t.sound))).toBe(true);
  });

  it.each(['bigroom', 'proghouse', 'techhouse', 'trance'] as const)('%s: a kick on every beat, the clap on 2 and 4', (style) => {
    const spec = generateLocalBeat({ prompt: PROMPT[style], bpm: 100 });
    for (let bar = 0; bar < spec.bars; bar++) {
      expect(inBar(stepsOf(spec, 'kick'), bar)).toEqual([0, 4, 8, 12]);
      expect(inBar(stepsOf(spec, 'clap'), bar)).toEqual([4, 12]);
    }
  });

  it.each(['futurebass', 'dubstep', 'melodicdub'] as const)('%s: half-time, the snare on beat 3 and none on 2 or 4', (style) => {
    const spec = generateLocalBeat({ prompt: PROMPT[style], bpm: 100 });
    for (let bar = 0; bar < spec.bars; bar++) {
      const snare = inBar(stepsOf(spec, 'snare'), bar);
      expect(snare).toContain(8);
      expect(snare).not.toContain(4);
      expect(snare).not.toContain(12);
      expect(inBar(stepsOf(spec, 'kick'), bar)).toContain(0);
      expect(inBar(stepsOf(spec, 'kick'), bar)).not.toContain(4);
    }
  });

  it('drum & bass: a two-step, kick on 1 and the "and" of 3, snares on 2 and 4', () => {
    const spec = generateLocalBeat({ prompt: PROMPT.dnb, bpm: 100 });
    for (let bar = 0; bar < spec.bars; bar++) {
      expect(inBar(stepsOf(spec, 'kick'), bar)).toEqual([0, 10]);
      const snare = inBar(stepsOf(spec, 'snare'), bar);
      expect(snare).toContain(4);
      expect(snare).toContain(12);
    }
  });

  it('dubstep has a sub and a growl, tech house a vocal shot, trance an arp, future bass a vocal-chop lead', () => {
    const names = (style: (typeof PACK)[number]) => generateLocalBeat({ prompt: PROMPT[style], bpm: 100 }).tracks.map((t) => t.name);
    expect(names('dubstep')).toEqual(expect.arrayContaining(['Sub', 'Growl']));
    expect(names('techhouse')).toContain('Vox');
    expect(names('trance')).toContain('Arp');
    expect(names('futurebass')).toEqual(expect.arrayContaining(['Chords', 'Lead']));
    expect(names('proghouse')).toEqual(expect.arrayContaining(['Bass', 'Keys']));
  });

  it('a prog house bass rolls between the kicks: never on a kick step', () => {
    const spec = generateLocalBeat({ prompt: PROMPT.proghouse, bpm: 100 });
    const bass = spec.tracks.find((t) => t.name === 'Bass')!;
    expect(bass.notes.length).toBeGreaterThanOrEqual(spec.bars * 8);
    for (const n of bass.notes) expect(n.step % 4, `step ${n.step}`).not.toBe(0);
  });

  it('trance and big room put the bass on the offbeat', () => {
    for (const style of ['trance', 'bigroom'] as const) {
      const spec = generateLocalBeat({ prompt: PROMPT[style], bpm: 100 });
      const bass = spec.tracks.find((t) => t.name === 'Bass')!;
      for (const n of bass.notes) expect(n.step % 4, `${style} step ${n.step}`).toBe(2);
    }
  });

  it('drum & bass: neuro keeps the bass alone, liquid adds chords', () => {
    const liquid = generateLocalBeat({ prompt: 'liquid drum and bass', bpm: 100 }).tracks.map((t) => t.name);
    const neuro = generateLocalBeat({ prompt: 'neurofunk drum and bass', bpm: 100 }).tracks.map((t) => t.name);
    expect(liquid).toContain('Pad');
    expect(neuro).not.toContain('Pad');
    expect(neuro).toContain('Reese');
  });

  it('keeps the older styles where they were', () => {
    expect(parsePrompt('house').style).toBe('house');
    expect(parsePrompt('edm festival').style).toBe('edm');
    expect(parsePrompt('trap').style).toBe('trap');
    expect(parsePrompt('chill').style).toBe('lofi');
    expect(parsePrompt('four on the floor').style).toBe('house');
  });

  it('a later request in the conversation changes the style, the tempo and the key (the Studio keeps the earlier ones)', () => {
    let prompt = mergeOfflinePrompt('', 'make a trance beat');
    expect(parsePrompt(prompt).style).toBe('trance');
    prompt = mergeOfflinePrompt(prompt, 'now make it drum and bass');
    expect(parsePrompt(prompt).style).toBe('dnb');
    expect(generateLocalBeat({ prompt, bpm: 120 }).bpm).toBe(174);
    prompt = mergeOfflinePrompt(prompt, 'no hats');
    expect(parsePrompt(prompt).style).toBe('dnb');
    expect(parsePrompt(prompt).noHats).toBe(true);
    prompt = mergeOfflinePrompt(prompt, 'a house beat');
    expect(parsePrompt(prompt).style).toBe('house');
    expect(parsePrompt(prompt).noHats).toBe(true);
    expect(parsePrompt(mergeOfflinePrompt('make it 100 bpm in D minor', 'make it 120 bpm in E minor')).bpm).toBe(120);
    expect(parsePrompt(mergeOfflinePrompt('make it 100 bpm in D minor', 'make it 120 bpm in E minor')).key).toEqual({ root: 4, minor: true });
  });
});
