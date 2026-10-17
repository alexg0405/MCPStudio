import { describe, expect, it } from 'vitest';
import { STYLES } from '@core/beat/style';
import { createTestServices } from '../testing';
import { ALTERNATES, drumVolume, KIT_FOR, PALETTE, paletteText, PITCHED_SOUNDS, soundFor } from './palette';

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

  it('plays the EDM pack on its own leads, basses and chords', () => {
    expect(soundFor('bigroom', 'lead')[0]).toMatchObject({ pluginId: 'agstudio.wavetable', preset: 'Big room lead' });
    expect(soundFor('bigroom', 'pad')[0]?.preset).toBe('Supersaw stack');
    expect(soundFor('proghouse', 'bass')[0]?.preset).toBe('Rolling bass');
    expect(soundFor('proghouse', 'keys')[0]).toMatchObject({ pluginId: 'agstudio.fm', preset: 'Soft piano (felt, long decay)' });
    expect(soundFor('futurebass', 'pad')[0]?.preset).toBe('Future bass chord');
    expect(soundFor('futurebass', 'lead')[0]?.preset).toBe('Vocal chop');
    expect(soundFor('dubstep', 'bass')[0]?.preset).toBe('Growl bass');
    expect(soundFor('melodicdub', 'pad')[0]?.preset).toBe('Supersaw stack');
    expect(soundFor('techhouse', 'bass')[0]?.preset).toBe('Tech house bass');
    expect(soundFor('trance', 'pad')[0]?.preset).toBe('Gated supersaw');
    expect(soundFor('trance', 'pluck')[0]?.preset).toBe('Trance pluck');
    expect(soundFor('dnb', 'bass')[0]?.preset).toBe('Reese bass');
  });

  it('gives the EDM pack its own drum kits, each with its drum levels', () => {
    expect(KIT_FOR.bigroom).toBe('edm');
    expect(KIT_FOR.trance).toBe('edm');
    for (const style of ['futurebass', 'dubstep', 'melodicdub'] as const) expect(KIT_FOR[style]).toBe('bass');
    expect(KIT_FOR.dnb).toBe('dnb');
    for (const style of ['proghouse', 'techhouse'] as const) expect(KIT_FOR[style]).toBe('house');
    for (const kit of ['edm', 'bass', 'dnb'] as const)
      for (const sound of ['kick', 'snare', 'clap', 'hat', 'open-hat'] as const) {
        const v = drumVolume(sound, kit);
        expect(v, `${kit} ${sound}`).toBeGreaterThan(0.1);
        expect(v, `${kit} ${sound}`).toBeLessThanOrEqual(1.25);
      }
  });

  it('offers the alternates by preset name, and they are real presets', () => {
    const s = createTestServices();
    expect(ALTERNATES.dubstep?.bass?.preset).toBe('Riddim wobble');
    for (const [style, byStyle] of Object.entries(ALTERNATES))
      for (const c of Object.values(byStyle ?? {})) {
        expect(s.plugins.get(c.pluginId)!.presets?.map((p) => p.name), style).toContain(c.preset);
      }
    expect(paletteText()).toContain('also (set preset): bass Wavetable “Riddim wobble”');
  });
});
