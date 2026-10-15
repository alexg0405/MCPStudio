import { describe, expect, it } from 'vitest';
import { STYLES } from '@core/beat/style';
import { createTestServices } from '../testing';
import { KIT_FOR, PALETTE, paletteText, PITCHED_SOUNDS, soundFor } from './palette';

describe('sound palette', () => {
  it('plays each style on its own sounds', () => {
    expect(soundFor('trap', '808')[0]).toMatchObject({
      pluginId: 'agstudio.bass808',
      preset: 'Classic 808',
      params: { drive: 0.35, glide: 0.1 },
    });
    expect(soundFor('trap', 'pad')[0]).toMatchObject({ pluginId: 'agstudio.wavetable', preset: 'Warm supersaw pad' });
    expect(soundFor('trap', 'keys')[0]).toMatchObject({ pluginId: 'agstudio.fm', preset: 'Electric piano (DX-style tine)' });
    expect(soundFor('trap', 'lead')[0]).toMatchObject({ pluginId: 'agstudio.wavetable', preset: 'Glassy pluck' });
    expect(soundFor('trap', 'bell')[0]).toMatchObject({ pluginId: 'agstudio.fm', preset: 'Glassy FM bell' });
    expect(soundFor('trap', 'strings')[0]).toMatchObject({ pluginId: 'agstudio.wavetable', preset: 'PWM strings' });
    expect(soundFor('drill', '808')[0]?.preset).toBe('Drill slide');
    expect(soundFor('boombap', 'bass')[0]).toMatchObject({ pluginId: 'agstudio.wavetable', preset: 'Deep sub bass' });
    expect(soundFor('boombap', 'keys')[0]?.pluginId).toBe('agstudio.fm');
    expect(soundFor('house', 'keys')[0]?.preset).toBe('Drawbar organ (additive)');
    expect(soundFor('house', 'bass')[0]).toMatchObject({ pluginId: 'agstudio.3xosc', preset: 'Pluck bass' });
    expect(soundFor('edm', 'lead')[0]?.preset).toBe('Sync scream lead');
    expect(soundFor('edm', 'keys')[0]?.preset).toBe('Brass stab');
    expect(soundFor('reggaeton', 'lead')[0]?.preset).toBe('Marimba');
    expect(soundFor('afro', 'lead')[0]?.preset).toBe('Marimba');
    expect(KIT_FOR.boombap).toBe('boombap');
    expect(KIT_FOR.edm).toBe('house');
  });

  it('has a 3xOsc backup for every pitched sound and nothing for drums', () => {
    for (const style of STYLES)
      for (const sound of PITCHED_SOUNDS) {
        const choices = soundFor(style, sound);
        expect(choices.at(-1)!.pluginId, `${style} ${sound}`).toBe('agstudio.3xosc');
      }
    expect(soundFor('trap', 'kick')).toEqual([]);
    expect(soundFor(null, 'pad')[0]).toEqual(PALETTE.pop.pad);
  });

  it('names only presets the plugins really have', () => {
    const s = createTestServices();
    for (const style of STYLES)
      for (const sound of PITCHED_SOUNDS)
        for (const c of soundFor(style, sound)) {
          const def = s.plugins.get(c.pluginId);
          expect(def, c.pluginId).toBeDefined();
          if (c.preset) expect(def!.presets?.map((p) => p.name), `${style} ${sound}`).toContain(c.preset);
          for (const k of Object.keys(c.params ?? {})) expect(def!.params[k], `${c.pluginId}.${k}`).toBeDefined();
          expect(c.volume).toBeGreaterThan(0.2);
          expect(c.volume).toBeLessThanOrEqual(1);
        }
  });

  it('describes every style for the prompt', () => {
    const text = paletteText();
    for (const style of STYLES) expect(text).toContain(`(${style})`);
    expect(text).toContain('808 808 Bass “Classic 808”');
  });
});
