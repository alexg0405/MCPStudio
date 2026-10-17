/** The Studio knows the EDM pack: the style enums, the prompt's style map and the song shapes. */
import { describe, expect, it } from 'vitest';
import { STYLES } from '@core/beat/style';
import { ACTION_OPS } from './schema';
import { STUDIO_PROMPT } from './prompt';

const PACK = ['bigroom', 'proghouse', 'futurebass', 'dubstep', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const;

const opSchema = (name: string) => ACTION_OPS.find((o) => o.properties.op.const === name) as unknown as { properties: Record<string, { enum?: string[] }> };

describe('the Studio and the EDM pack', () => {
  it('offers every style in the beat, arrange, develop, transition, vary and mix actions', () => {
    for (const op of ['beat', 'arrange', 'develop', 'transition', 'vary', 'setup_mix', 'level_mix']) {
      const style = opSchema(op).properties.style?.enum ?? [];
      for (const s of PACK) expect(style, `${op} ${s}`).toContain(s);
      expect(style).toHaveLength(STYLES.length);
    }
  });

  it('maps requests to the styles, artist phrasing included, without claiming anyone’s songs', () => {
    for (const s of PACK) expect(STUDIO_PROMPT, s).toContain(`"${s}"`);
    expect(STUDIO_PROMPT).toMatch(/a drop like Martin Garrix[^.]*bigroom/);
    expect(STUDIO_PROMPT).toMatch(/Flume-ish[^.]*futurebass/);
    expect(STUDIO_PROMPT).toMatch(/never anyone's actual melody|never a real song's melody/);
  });

  it('lists the dance styles’ tempos, the usual song of each and the growl and riddim presets', () => {
    expect(STUDIO_PROMPT).toContain('Dubstep and riddim ("dubstep"): 140–150 BPM');
    expect(STUDIO_PROMPT).toContain('Drum & bass ("dnb"): 172–176 BPM');
    expect(STUDIO_PROMPT).toContain('Big room (bigroom):');
    expect(STUDIO_PROMPT).toMatch(/Intro 16 bars energy 1 without bass\/music; Build 8 bars energy 4/);
    expect(STUDIO_PROMPT).toContain('Growl bass');
    expect(STUDIO_PROMPT).toContain('Riddim wobble');
    expect(STUDIO_PROMPT).toContain('Gated supersaw');
  });
});
