/**
 * The EDM style pack through the real engine: the offline generator's beat in each new style, eight bars
 * on the playlist with the mix set up and leveled for its style. It must sound (not silent), keep the true
 * peak at most −0.9 dBTP and land within 1.5 dB of the style's loudness.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyAnswer } from '@app/ai/apply';
import type { AiAction } from '@app/ai/schema';
import { autoLevel, LEVEL_TARGETS } from '@app/mix/auto-level';
import { createServices, type Services } from '@app/services';
import { generateLocalBeat } from '@core/beat/local';
import { STYLE_LABELS, type Style } from '@core/beat/style';
import { measureSong } from '../helpers/mix-level';

const NEW_STYLES = ['bigroom', 'proghouse', 'futurebass', 'dubstep', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const satisfies readonly Style[];
const BARS = 8;

describe.concurrent('EDM style pack', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it.each(NEW_STYLES.map((s) => [s] as const))(
    '%s: eight bars are audible, leveled to the style’s loudness, true peak at most −0.9 dBTP',
    async (style) => {
      const s = createServices();
      services.push(s);
      const spec = generateLocalBeat({ prompt: STYLE_LABELS[style], bpm: 120 });
      const { message: _m, ...beat } = spec;
      const actions: AiAction[] = [
        { op: 'beat', ref: '@main', ...beat } as AiAction,
        { op: 'place_pattern', pattern: '@main', bar: 1, track: 1, times: BARS / spec.bars },
        { op: 'setup_mix', style, mode: 'rebuild' },
      ];
      const res = applyAnswer(s, { message: 'A beat', actions }, { previousBeat: null, label: 'song' });
      expect(res.warnings).toEqual([]);
      s.view.getState().setMode('song');
      const result = await autoLevel(s, { style, bars: BARS, entry: s.history.status().cursor });
      expect(result).not.toBeNull();
      const m = await measureSong(s, BARS);
      const t = LEVEL_TARGETS[style];
      console.log(
        `${style}: ${spec.bpm ?? 120} BPM, master ${m.master.lufs.toFixed(2)} LUFS (target ${t.master}), true peak ${m.master.truePeakDb!.toFixed(2)} dBTP, limiter input ${result!.limiterInput?.toFixed(2)} dB`,
      );
      expect(m.master.silent).toBe(false);
      expect(m.master.truePeakDb!).toBeLessThanOrEqual(-0.9);
      expect(Math.abs(m.master.lufs - t.master)).toBeLessThanOrEqual(1.5);
    },
    300_000,
  );
});
