/**
 * One style of the loudness stage test (`test/browser/loudness-stage-<style>.test.ts`, one file per style so the four styles render
 * in separate pages side by side: in one page their renders and measurements queue up on the same thread).
 *
 * The song is built as the Studio builds it (a beat, the mix set up, auto-level), then its mix before the Limiter and Maximizer is
 * rendered once and run through three master chains in the page (the real kernels): the Limiter alone, as the master was before;
 * the Maximizer and the Limiter; and a hard-clipping Saturator as the negative control. At equal loudness the objective measures
 * (true peak, distortion, kick punch and weight, test/helpers/loudness-quality.ts) must be no worse for the new chain than for the old
 * one, the control must be clearly worse, and at the loud targets only the new chain gets there. The auto-level result itself is
 * checked against the real engine: within 0.5 dB of the target, true peak at most −1 dBTP.
 *
 * Big room, dubstep and drum & bass are also three of the EDM pack's eight styles (`edm-pack-<style>.test.ts` hold the other five),
 * so these also make the pack's checks (the beat applies without warnings, the master is audible, within 0.5 dB of its loudness,
 * true peak at most −0.9 dBTP: the −0.95 here is the stricter) on the same renders instead of building each twice.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyAnswer } from '@app/ai/apply';
import type { AiAction } from '@app/ai/schema';
import { autoLevel, LEVEL_TARGETS } from '@app/mix/auto-level';
import { createServices, type Services } from '@app/services';
import { generateLocalBeat } from '@core/beat/local';
import { STYLE_LABELS, type Style } from '@core/beat/style';
import { MASTER } from '@core/model/types';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import {
  describeQuality,
  hardClipped,
  kickOnsets,
  limiterOnly,
  maximized,
  quality,
  reachLoudness,
  viaOversampler,
  type Stereo,
} from '../helpers/loudness-quality';
import { buildSong, measureMaster } from '../helpers/mix-level';

const BARS = 8;
const SR = 48000;
/** The styles with a loudness stage file of their own. */
export const LOUDNESS_STYLES = ['bigroom', 'dubstep', 'dnb', 'house'] as const satisfies readonly Style[];
export type LoudnessStyle = (typeof LOUDNESS_STYLES)[number];

/** The mix as it reaches the master Limiter, rendered once: the master's Limiter and Maximizer taken out. */
async function mixBeforeLimiter(s: Services): Promise<Stereo> {
  const project = structuredClone(s.doc.getState().project);
  const master = project.mixer.inserts[MASTER]!;
  master.fx = master.fx.filter(
    (f) => f.plugin.pluginId !== 'agstudio.limiter' && f.plugin.pluginId !== 'agstudio.maximizer',
  );
  const tempo = tempoMapOf(project, 'song');
  const frames = Math.round(
    (tempo.tickToSeconds(BARS * ticksPerBar(project.transport.timeSig)) - tempo.tickToSeconds(0)) * SR,
  );
  const r = await renderOffline(project, {
    plugins: s.plugins,
    view: { mode: 'song', patternId: null, loop: null },
    bars: BARS,
    sampleRate: SR,
    tail: 0,
    limiter: false,
  });
  const start = Math.round((r.preRoll + r.latency) * SR);
  return [
    r.buffer.getChannelData(0).slice(start, start + frames),
    r.buffer.getChannelData(1).slice(start, start + frames),
  ];
}

/** The test of one style: registers the suite in the file that calls it. */
export function describeLoudnessStage(style: LoudnessStyle): void {
  describe('loudness stage', () => {
    const services: Services[] = [];
    afterAll(async () => {
      for (const s of services) await s.engine.dispose();
    });

    it(`${style}: reaches its loudness within 0.5 dB, and at equal loudness is no worse than the Limiter alone`, async () => {
      const s = createServices();
      services.push(s);
      if (style === 'house') buildSong(s, 'house', { bpm: 124, low: 'bass' });
      else {
        const spec = generateLocalBeat({ prompt: STYLE_LABELS[style], bpm: 120 });
        const { message: _m, ...beat } = spec;
        const actions: AiAction[] = [
          { op: 'beat', ref: '@main', ...beat } as AiAction,
          { op: 'place_pattern', pattern: '@main', bar: 1, track: 1, times: BARS / spec.bars },
          { op: 'setup_mix', style, mode: 'rebuild' },
        ];
        const applied = applyAnswer(s, { message: 'A beat', actions }, { previousBeat: null, label: 'song' });
        expect(applied.warnings).toEqual([]);
      }
      s.view.getState().setMode('song');
      const target = LEVEL_TARGETS[style].master;
      const result = await autoLevel(s, { style, bars: BARS, entry: s.history.status().cursor });
      expect(result).not.toBeNull();
      const master = await measureMaster(s, BARS);
      const stages =
        result!.maximizerInput === null ? 'Limiter alone' : `Maximizer +${result!.maximizerInput.toFixed(1)} dB`;
      console.log(
        `LOUD | ${style} | auto-level: ${master.lufs.toFixed(2)} LUFS (target ${target}), ${master.truePeakDb!.toFixed(2)} dBTP, ${stages}`,
      );
      expect(master.silent).toBe(false);
      expect(Math.abs(master.lufs - target)).toBeLessThanOrEqual(0.5);
      expect(master.truePeakDb!).toBeLessThanOrEqual(-0.95);

      // The same mix through each chain, in the page.
      const x = await mixBeforeLimiter(s);
      const xo = viaOversampler(x);
      const onsets = kickOnsets(x);
      for (const level of [-9.5, -8.5, -8]) {
        const old = reachLoudness(x, level, limiterOnly, 24, 0.08);
        const oldReached = Math.abs(old.lufs - level) <= 0.1;
        const next = reachLoudness(x, level, (xx, g) => maximized(xx, g), 16, 0.08);
        const qOld = quality(old.y, x, onsets);
        const qNew = quality(next.y, xo, onsets);
        console.log(
          `LOUD | ${style} | @${level} limiter+${old.input.toFixed(1)}${oldReached ? '' : ' (cannot reach)'}: ${describeQuality(qOld)}`,
        );
        console.log(`LOUD | ${style} | @${level} maximizer+${next.input.toFixed(1)}: ${describeQuality(qNew)}`);
        // The control is measured at −8.5 only (it costs as much as the other two chains together).
        const hard = level === -8.5 ? reachLoudness(x, level, (xx, g) => hardClipped(xx, g), 16, 0.08) : null;
        const qHard = hard ? quality(hard.y, x, onsets) : null;
        if (hard && qHard)
          console.log(`LOUD | ${style} | @${level} hard clipper+${hard.input.toFixed(1)}: ${describeQuality(qHard)}`);

        // The limits. A loudness the Maximizer's input range cannot reach (16 dB here) is only reported.
        if (next.input < 15.9)
          expect(Math.abs(qNew.lufs - level), `${style} @${level}: loudness`).toBeLessThanOrEqual(0.15);
        expect(qNew.truePeakDb, `${style} @${level}: true peak`).toBeLessThanOrEqual(-1 + 0.01);
        expect(qNew.distortion, `${style} @${level}: distortion`).toBeLessThanOrEqual(-18);
        expect(qNew.distortionHigh, `${style} @${level}: distortion in the highs`).toBeLessThanOrEqual(-17);
        expect(qNew.punch, `${style} @${level}: kick punch`).toBeGreaterThanOrEqual(4.3);
        // The hard clipper that crushed a song, at the same loudness: the measures must see it.
        if (hard && qHard && Math.abs(hard.lufs - level) <= 0.15)
          expect(qNew.distortion, `${style} @${level}: against the hard clipper`).toBeLessThan(qHard.distortion - 6);
        // Where the Limiter alone gets there too: the new chain is no more distorted, and keeps the kick.
        if (oldReached) {
          expect(qNew.distortion, `${style} @${level}: against the Limiter`).toBeLessThanOrEqual(qOld.distortion + 1);
          expect(qNew.punch, `${style} @${level}: kick punch against the Limiter`).toBeGreaterThanOrEqual(
            qOld.punch - 1,
          );
          expect(qNew.weight, `${style} @${level}: kick weight against the Limiter`).toBeGreaterThanOrEqual(
            qOld.weight - 0.5,
          );
          // The cost, measured: a soft clip puts more in the highs than a slow limiter does (up to 8 dB more here: 6.2 dB for dubstep at −8.5).
          expect(qNew.distortionHigh, `${style} @${level}: highs against the Limiter`).toBeLessThanOrEqual(
            qOld.distortionHigh + 8,
          );
        }
      }
    }, 900_000); // a timeout is for a hang, not a speed check
  });
}
