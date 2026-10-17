/** The EDM pack's mix: bus balance, master loudness, the sidechained pads and wobble, reverb and delay by style. */
import { describe, expect, it } from 'vitest';
import type { Style } from '@core/beat/style';
import { LEVEL_TARGETS, limiterInput, levelMoves, LEVELED, PRE_LIMITER_LUFS } from './auto-level';
import { busRecipe } from './recipes';

const PACK = ['bigroom', 'proghouse', 'futurebass', 'dubstep', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const satisfies readonly Style[];

describe('EDM pack: leveling', () => {
  it('has a balance and a loud master for every style, within what the Limiter can make up', () => {
    for (const style of PACK) {
      const t = LEVEL_TARGETS[style];
      expect(t.master, style).toBeLessThanOrEqual(-8.5);
      expect(t.master, style).toBeGreaterThanOrEqual(-10);
      // The Limiter's input (−16 LUFS to the master) stays inside its 0…10 dB range without clamping.
      expect(limiterInput(style), style).toBe(t.master - PRE_LIMITER_LUFS);
      for (const k of ['drums', 'bass', 'chords', 'lead', 'fx'] as const) expect(Math.abs(t[k]), `${style} ${k}`).toBeLessThanOrEqual(12);
    }
  });

  it('puts the lead on top in big room and the bass level with the kick in dubstep', () => {
    expect(LEVEL_TARGETS.bigroom.lead).toBeGreaterThan(LEVEL_TARGETS.bigroom.chords);
    expect(LEVEL_TARGETS.bigroom.lead).toBeGreaterThan(LEVEL_TARGETS.bigroom.bass);
    expect(LEVEL_TARGETS.dubstep.bass).toBeGreaterThanOrEqual(0);
    expect(LEVEL_TARGETS.dubstep.master).toBeGreaterThan(LEVEL_TARGETS.proghouse.master);
    expect(LEVEL_TARGETS.dnb.drums).toBeGreaterThan(LEVEL_TARGETS.techhouse.chords);
  });

  it('moves the buses of a pack style to its balance around the kick and sums them to −16 LUFS', () => {
    for (const style of PACK) {
      const plan = levelMoves(
        LEVELED.map((role) => ({ role, lufs: -20, gain: 1 })),
        style,
      );
      const by = (role: string) => plan.moves.find((m) => m.role === role)!;
      for (const k of ['drums', 'bass', 'chords', 'lead', 'fx'] as const) {
        // Moves are clamped to −12…+6 dB, so every target here is reachable.
        expect(by(k).lufs - by('kick').lufs, `${style} ${k}`).toBeCloseTo(LEVEL_TARGETS[style][k], 6);
      }
    }
  });
});

describe('EDM pack: the Chords bus and the returns', () => {
  const chordDuck = (style: Style) => busRecipe('chords', style).fx.find((f) => f.pluginId === 'agstudio.ducker')!;

  it('big room and trance pads are sidechained to the kick, deeper than the old EDM pump', () => {
    for (const style of ['bigroom', 'trance'] as const) {
      const duck = chordDuck(style);
      expect(duck.sidechain).toBe('kick');
      expect(Number(duck.params!.depth)).toBeGreaterThanOrEqual(0.6);
      expect(duck.label).toContain('sidechained pads');
    }
    expect(Number(chordDuck('bigroom').params!.depth)).toBeGreaterThan(Number(chordDuck('edm').params!.depth));
  });

  it('future bass chords wobble on a 1/8 tempo pump', () => {
    const duck = chordDuck('futurebass');
    expect(duck.params).toMatchObject({ mode: 'tempo', rate: '1/8' });
    expect(Number(duck.params!.depth)).toBeGreaterThanOrEqual(0.6);
  });

  it('every pack style ducks its chords under the kick and has its own reverb', () => {
    for (const style of PACK) {
      expect(chordDuck(style).sidechain, style).toBe('kick');
      expect(busRecipe('reverb', style).fx.some((f) => f.pluginId === 'agstudio.reverb' && !!f.preset), style).toBe(true);
      expect(busRecipe('delay', style).fx[0]!.preset, style).toBeTruthy();
    }
    expect(busRecipe('reverb', 'melodicdub').fx[1]!.preset).toBe('Hall');
    expect(busRecipe('delay', 'dubstep').fx[0]!.preset).toBe('Dub');
    expect(busRecipe('delay', 'futurebass').fx[0]!.preset).toBe('Triplet bounce');
  });

  it('melodic dubstep lives in the reverb: its chords and lead send more than the standard', () => {
    expect(busRecipe('chords', 'melodicdub').sends.reverb!).toBeGreaterThan(busRecipe('chords', 'trap').sends.reverb!);
    expect(busRecipe('lead', 'melodicdub').sends.reverb!).toBeGreaterThan(busRecipe('lead', 'trap').sends.reverb!);
  });
});
