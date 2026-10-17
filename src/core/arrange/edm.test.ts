/** The EDM pack's arrangement tables: fills, transitions, endings, energy defaults and song shapes. */
import { describe, expect, it } from 'vitest';
import { BAR, BEAT } from '../../../test/helpers/arrange';
import { STYLES, type Style } from '../beat/style';
import { FILL_ROTATION, phraseEvents, type PhraseInput, type SectionCaps } from './phrases';
import { DEFAULT_ENERGY, SECTION_ROLES, type FillChoice, type SectionRole } from './sections';
import { defaultEnergy, shapeText, SONG_SHAPES } from './shapes';
import { boundaryRecipe, defaultEnding, gapBeats, traitsOf } from './transitions';

const PACK = ['bigroom', 'proghouse', 'futurebass', 'dubstep', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const satisfies readonly Style[];

const caps: SectionCaps = { drums: true, hats: true, openHat: true, slide: true };
const side = (role: SectionRole, energy: number, bars = 8, fill: FillChoice = 'auto') => ({ role, energy, bars, fill, caps });
const ctx = (style: Style, bpm = 128) => ({ bpm, beatsPerBar: 4, barTicks: BAR, style, fx: 'auto' as const });

describe('EDM pack: fills and phrasing', () => {
  it('every style rotates through fills it can play, led by snare rolls where the style builds on them', () => {
    for (const style of PACK) expect(FILL_ROTATION[style].length, style).toBeGreaterThanOrEqual(3);
    expect(FILL_ROTATION.bigroom[0]).toBe('snare-fill');
    expect(FILL_ROTATION.trance[0]).toBe('snare-fill');
    expect(FILL_ROTATION.dubstep).toContain('kick-fill');
  });

  it('big room fills every 16 bars and changes every 8; dubstep fills every 8 and changes every 4', () => {
    const input = (style: Style): PhraseInput => ({
      bars: 16,
      barTicks: BAR,
      energy: 3,
      style,
      vary: 'auto',
      fill: 'auto',
      caps,
      loopBars: 4,
      index: 0,
    });
    const at = (style: Style, why: string) => phraseEvents(input(style), [], { fill: 0 }).events.filter((e) => e.why === why).map((e) => e.to / BAR);
    expect(at('bigroom', 'phrase')).toEqual([16]);
    expect(at('bigroom', 'small')).toEqual([8]);
    expect(at('dubstep', 'phrase')).toEqual([8, 16]);
    expect(at('dubstep', 'small')).toEqual([4, 12]);
  });
});

describe('EDM pack: transitions', () => {
  it('a big room build is a snare roll over 8 bars, trance too; the others keep 4', () => {
    const build = (style: Style) => boundaryRecipe('rise', 24 * BAR, side('build', 4, 16), side('drop', 5), ctx(style), { fill: 0 }).end.find((e) => e.kind === 'snare-build')!;
    expect(build('bigroom')).toMatchObject({ from: 8 * BAR, to: 16 * BAR - BEAT });
    expect(build('trance')).toMatchObject({ from: 8 * BAR });
    expect(build('dubstep')).toMatchObject({ from: 12 * BAR });
    // Never longer than the build itself.
    const short = boundaryRecipe('rise', 24 * BAR, side('build', 4, 4), side('drop', 5), ctx('bigroom'), { fill: 0 }).end.find((e) => e.kind === 'snare-build')!;
    expect(short.from).toBe(0);
  });

  it('the bass styles and drum & bass leave the big silence before the drop already at an energy jump of 2', () => {
    for (const style of ['dubstep', 'futurebass', 'melodicdub', 'dnb'] as const) expect(gapBeats('rise', 2, style), style).toEqual({ gap: 2, stop: 1 });
    for (const style of ['bigroom', 'trance', 'proghouse'] as const) {
      expect(gapBeats('rise', 2, style), style).toEqual({ gap: 1, stop: 0 });
      expect(gapBeats('rise', 3, style), style).toEqual({ gap: 2, stop: 1 });
    }
    const r = boundaryRecipe('rise', 16 * BAR, side('build', 3, 4), side('drop', 5), ctx('dubstep', 140), { fill: 0 });
    expect(r.end.map((e) => e.kind)).toEqual(['snare-build', 'gap', 'dropout']);
  });

  it('a drop gets a riser, a reverse crash and an impact, and a sub drop (at a jump of 3) in the bass styles', () => {
    for (const style of PACK) {
      const r = boundaryRecipe('rise', 24 * BAR, side('build', 2, 8), side('drop', 5), ctx(style), { fill: 0 });
      const kinds = r.fx.map((f) => f.kind);
      expect(kinds, style).toEqual(expect.arrayContaining(['riser', 'reverse-crash', 'impact']));
      expect(kinds.includes('sub-drop'), style).toBe(['bigroom', 'futurebass', 'dubstep', 'melodicdub', 'dnb'].includes(style));
      expect(r.crash, style).toBe(1);
    }
  });

  it('big room hits the riser harder than progressive house', () => {
    const riser = (style: Style) =>
      boundaryRecipe('rise', 24 * BAR, side('build', 4, 8), side('drop', 5), ctx(style), { fill: 0 }).fx.find((f) => f.kind === 'riser')!.gainDb;
    expect(riser('bigroom')).toBeGreaterThan(riser('proghouse'));
    expect(traitsOf('trap').riserDb).toBe(-4);
  });

  it('progressive house and trance sweep the filter over the whole build (up to 8 bars)', () => {
    const sweep = (style: Style, bars: number) =>
      boundaryRecipe('rise', 24 * BAR, side('build', 4, bars), side('drop', 5), ctx(style), { fill: 0 }).automation.find(
        (a) => a.purpose === 'sweep-up' && a.target.kind === 'eq' && a.target.bus === 'chords',
      )!;
    expect(sweep('proghouse', 16).length).toBe(8 * BAR);
    expect(sweep('proghouse', 16).start + sweep('proghouse', 16).length).toBe(24 * BAR);
    expect(sweep('trance', 4).length).toBe(4 * BAR);
    // The others sweep across the riser (4 bars at this tempo).
    expect(sweep('bigroom', 16).length).toBeLessThanOrEqual(4 * BAR);
    for (const style of PACK) {
      const s = sweep(style, 8);
      expect(s.points.at(-1)!.value, style).toBe('neutral');
    }
  });

  it('dubstep and future bass end on a stop, the others on a fade', () => {
    for (const style of ['dubstep', 'futurebass'] as const) expect(defaultEnding(style)).toBe('stop');
    for (const style of ['bigroom', 'proghouse', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const) expect(defaultEnding(style)).toBe('fade');
  });
});

describe('EDM pack: energy and song shapes', () => {
  it('keeps the old defaults for the old styles and bends them for the dance ones', () => {
    for (const style of STYLES)
      if (!(PACK as readonly string[]).includes(style)) for (const role of SECTION_ROLES) expect(defaultEnergy(style, role)).toBe(DEFAULT_ENERGY[role]);
    expect(defaultEnergy('trance', 'break')).toBe(1);
    expect(defaultEnergy('proghouse', 'intro')).toBe(2);
    expect(defaultEnergy('dubstep', 'drop')).toBe(5);
    for (const style of PACK) for (const role of SECTION_ROLES) expect(defaultEnergy(style, role)).toBeGreaterThanOrEqual(1);
    expect(defaultEnergy(null, 'drop')).toBe(5);
  });

  it('every style has a shape that builds to a drop, breaks down and stays within the arranger’s limits', () => {
    for (const style of PACK) {
      const shape = SONG_SHAPES[style]!;
      expect(shape, style).toBeDefined();
      expect(shape.length).toBeLessThanOrEqual(24);
      expect(shape.reduce((n, x) => n + x.bars, 0)).toBeLessThanOrEqual(512);
      for (const x of shape) {
        expect(x.bars).toBeGreaterThanOrEqual(4);
        expect(x.bars).toBeLessThanOrEqual(64);
        expect(x.bars % 4).toBe(0);
        expect(x.energy).toBeGreaterThanOrEqual(1);
        expect(x.energy).toBeLessThanOrEqual(5);
      }
      // A build leads into a drop, and some part of it is quiet (a breakdown or a groove-first intro).
      const roles = shape.map((x) => x.role);
      expect(roles.indexOf('build'), style).toBeGreaterThanOrEqual(0);
      expect(roles.includes('drop'), style).toBe(true);
      const drop = shape.findIndex((x) => x.role === 'drop');
      expect(shape[drop - 1]!.role === 'build' || style === 'techhouse' || style === 'proghouse', style).toBe(true);
      expect(Math.min(...shape.map((x) => x.energy)), style).toBeLessThanOrEqual(2);
      expect(shape.at(-1)!.role).toBe('outro');
      expect(shapeText(style)).toContain('Drop');
    }
    expect(shapeText('trap')).toBeNull();
  });
});
