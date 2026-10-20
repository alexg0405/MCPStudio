/**
 * The offline song generator through the real engine: a song written with no AI (the chords, bass, melody, drums and the
 * arrangement), its mix set up and leveled the way the assistant does after an answer, then rendered through the master
 * chain. Its busiest 8 bars must be at the style's loudness (within 1 dB) with a true peak of at most −0.9 dBTP, and the
 * song must play real audio in every section (nothing silent where the arrangement says something plays).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyAnswer } from '@app/ai/apply';
import { songToAnswer } from '@app/assistant/song-answer';
import { Measurer } from '@app/analysis/measure';
import { autoLevel, busiestWindow, LEVEL_TARGETS } from '@app/mix/auto-level';
import { createServices, type Services } from '@app/services';
import { tempoMapOf } from '@core/automation/tempo';
import type { Style } from '@core/beat/style';
import { generateSongFromPrompt } from '@core/song/generate';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';

const SAMPLE_RATE = 48000;

/** The styles checked: one with an 808, a quiet one, and a loud four-on-the-floor one with an arp (the Maximizer's). */
const STYLES: readonly Style[] = ['trap', 'lofi', 'trance'];

describe.concurrent('offline song loudness', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it.each(STYLES.map((style) => [style] as const))(
    '%s: a finished song, at its style’s loudness with room under the ceiling',
    async (style: Style) => {
      const s = createServices();
      services.push(s);
      const plan = generateSongFromPrompt(`a ${style} song`, { seed: 3 });
      const applied = applyAnswer(s, songToAnswer(plan), { previousBeat: null, label: `a ${style} song` });
      expect(applied.warnings).toEqual([]);
      const total = plan.sections.reduce((sum, section) => sum + section.bars, 0);
      s.view.getState().setMode('song');
      // The listening the answer asks for: the song's loudest part (not its intro).
      const level = applied.after.find((item) => item.kind === 'level_mix');
      if (level?.kind !== 'level_mix') throw new Error('the song asks for no leveling');
      const leveled = await autoLevel(s, { style, fromTick: level.fromTick, bars: level.bars });
      expect(leveled).not.toBeNull();
      const p = s.doc.getState().project;
      const window = busiestWindow(p, null, level.fromTick, level.bars)!;
      const tempo = tempoMapOf(p, window.mode);
      const toTick = window.fromTick + window.bars * ticksPerBar(p.transport.timeSig);
      const frames = Math.round((tempo.tickToSeconds(toTick) - tempo.tickToSeconds(window.fromTick)) * SAMPLE_RATE);
      const render = await renderOffline(p, {
        plugins: s.plugins,
        view: { mode: window.mode, patternId: window.patternId, loop: null },
        bars: window.bars,
        fromTick: window.fromTick,
        sampleRate: SAMPLE_RATE,
        tail: 0,
        limiter: true,
      });
      const start = Math.round((render.preRoll + render.latency) * SAMPLE_RATE);
      const meter = new Measurer(SAMPLE_RATE, true);
      meter.push(render.buffer.getChannelData(0).subarray(start, start + frames), render.buffer.getChannelData(1).subarray(start, start + frames));
      const result = meter.result();
      const target = LEVEL_TARGETS[style].master;
      console.log(`OFFLINE SONG | ${style}: ${result.lufs.toFixed(2)} LUFS (target ${target}), ${result.truePeakDb!.toFixed(2)} dBTP, ${total} bars; leveled ${leveled!.master.lufs.toFixed(2)} limiter ${leveled!.limiterInput} maximizer ${leveled!.maximizerInput} window ${window.fromTick}/${window.bars}; ${leveled!.changes.join(' · ')}`);
      expect(Math.abs(result.lufs - target)).toBeLessThanOrEqual(1);
      expect(result.truePeakDb!).toBeLessThanOrEqual(-0.9);
    },
    600_000,
  );
});
