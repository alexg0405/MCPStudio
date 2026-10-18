/**
 * Every project template, built the way the app builds it, rendered through the master chain: its busiest 8 bars must be at its style's
 * loudness (within 1 dB, the table is baked from a listening that landed within 0.5), true peak at most −0.95 dBTP. Opening a template
 * does no rendering: the levels are the baked table in src/app/template-levels.ts, and this test is what notices when it has gone stale.
 *
 * `VITE_BAKE_TEMPLATE_LEVELS=1` runs the real leveling on each template instead and prints the table rows (`TEMPLATE_LEVELS |`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Measurer } from '@app/analysis/measure';
import { autoLevel, busiestWindow, LEVEL_TARGETS } from '@app/mix/auto-level';
import { createServices, type Services } from '@app/services';
import { templateProject, TEMPLATES } from '@app/templates';
import { generateLocalBeat } from '@core/beat/local';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';

const BAKE = import.meta.env.VITE_BAKE_TEMPLATE_LEVELS === '1';

describe.concurrent('template levels', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s: opens at its style’s loudness',
    async (_id, t) => {
      const s = createServices();
      services.push(s);
      const style = generateLocalBeat({ prompt: t.prompt, bpm: t.bpm }).style ?? 'house';
      const t0 = performance.now();
      const { project, patternId } = templateProject(s, t, { levels: !BAKE });
      const built = performance.now() - t0;
      expect(await s.files.newProject(project)).toBe(true);
      s.view.getState().setCurrentPattern(patternId);
      s.view.getState().setMode('song');
      if (BAKE) {
        const res = await autoLevel(s, { style });
        const faders = Object.fromEntries(res!.buses.map((b) => [b.role, Math.round(b.toDb * 100) / 100]));
        const row = { faders, limiter: Math.round((res!.limiterInput ?? 0) * 100) / 100, maximizer: res!.maximizerInput === null ? null : Math.round(res!.maximizerInput * 100) / 100 };
        console.log(`TEMPLATE_LEVELS | ${JSON.stringify(t.id)}: ${JSON.stringify(row)}, // ${res!.master.lufs.toFixed(2)} LUFS (target ${LEVEL_TARGETS[style].master})`);
        return;
      }
      const p = s.doc.getState().project;
      // No empty default pattern left over.
      expect(Object.values(p.patterns).map((x) => x.name)).not.toContain('Pattern 1');
      const w = busiestWindow(p, patternId)!;
      const tempo = tempoMapOf(p, w.mode);
      const toTick = w.fromTick + w.bars * ticksPerBar(p.transport.timeSig);
      const rate = 48000;
      const frames = Math.round((tempo.tickToSeconds(toTick) - tempo.tickToSeconds(w.fromTick)) * rate);
      const r = await renderOffline(p, { plugins: s.plugins, view: { mode: w.mode, patternId: w.patternId, loop: null }, bars: w.bars, fromTick: w.fromTick, sampleRate: rate, tail: 0, limiter: true });
      const start = Math.round((r.preRoll + r.latency) * rate);
      const m = new Measurer(rate, true);
      m.push(r.buffer.getChannelData(0).subarray(start, start + frames), r.buffer.getChannelData(1).subarray(start, start + frames));
      const res = m.result();
      const target = LEVEL_TARGETS[style].master;
      console.log(`TEMPLATE | ${t.id}: ${res.lufs.toFixed(2)} LUFS (target ${target}), ${res.truePeakDb!.toFixed(2)} dBTP, built in ${built.toFixed(0)} ms`);
      expect(Math.abs(res.lufs - target)).toBeLessThanOrEqual(1);
      expect(res.truePeakDb!).toBeLessThanOrEqual(-0.95);
    },
    600_000,
  );
});
