/**
 * Auto-level through the real engine: a song Studio builds in one answer (a beat on the
 * playlist and the role mix), leveled for its style; then measured on its own: every bus within
 * 1.5 dB of its style level around the kick, the master within 0.5 dB of the style's loudness and
 * its true peak at most −0.9 dBTP. And it is one undo step with the answer.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyAnswer } from '@app/ai/apply';
import { autoLevel, LEVEL_TARGETS, type LeveledBus } from '@app/mix/auto-level';
import { createServices, type Services } from '@app/services';
import type { Style } from '@core/beat/style';
import { buildSong, measureSong } from '../helpers/mix-level';

const BARS = 2;

// Concurrent: the tests are long chains of offline renders (on audio threads) that share nothing, so they overlap.
describe.concurrent('auto-level', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it.each([
    ['trap', 140, '808'],
    ['lofi', 80, 'bass'],
    // A loud style: the Limiter takes less than the input it is given, so one correction left it 1.6 dB short.
    ['house', 124, 'bass'],
  ] as const)(
    '%s: every bus at its level around the kick, the master at the style’s loudness, one undo step',
    async (style: Style, bpm, low) => {
      const s = createServices();
      services.push(s);
      const before = s.doc.getState().project;
      const answer = buildSong(s, style, { bpm, low });
      expect(answer.warnings).toEqual([]);
      const entry = s.history.status().cursor;
      const progress: string[] = [];
      const res = await autoLevel(s, { style, bars: BARS, entry, progress: (label) => progress.push(label) });
      expect(res).not.toBeNull();
      const t = LEVEL_TARGETS[style];
      const m = await measureSong(s, BARS);
      const kick = m.buses.kick!.lufs;
      const rel = (role: LeveledBus) => m.buses[role]!.lufs - kick;
      const lines = (['drums', 'bass', 'chords', 'lead'] as const).map(
        (r) => `${r} ${rel(r).toFixed(2)} dB (target ${t[r]})`,
      );
      console.log(
        `${style}: ${lines.join(', ')}; master ${m.master.lufs.toFixed(2)} LUFS (target ${t.master}), true peak ${m.master.truePeakDb!.toFixed(2)} dBTP; limiter input ${res!.limiterInput?.toFixed(2)} dB; ${res!.changes.join(' · ')}`,
      );
      for (const r of ['drums', 'bass', 'chords', 'lead'] as const) expect(Math.abs(rel(r) - t[r]), r).toBeLessThanOrEqual(1.5);
      expect(Math.abs(m.master.lufs - t.master)).toBeLessThanOrEqual(0.5);
      expect(m.master.truePeakDb!).toBeLessThanOrEqual(-0.9);
      expect(progress).toContain('Kick');
      expect(progress).toContain('The mix');
      // The leveling is part of the answer's undo step.
      expect(s.history.status().cursor).toBe(entry);
      s.history.undo();
      expect(s.doc.getState().project).toEqual(before);
    },
    300_000,
  );

  it('a mix built by hand (no role buses): sets only its loudness, keeping the balance', async () => {
    const s = createServices();
    services.push(s);
    buildSong(s, 'trap', { bpm: 140, low: '808', mix: false });
    // Hot: every channel +5 dB straight into a master with a Limiter pushing +6 dB.
    s.history.transact('hot', (d) => {
      for (const ch of Object.values(d.channels)) if (ch.kind !== 'automation') ch.volume = Math.min(1.9, ch.volume * 1.78);
    });
    applyAnswer(s, {
      message: 'limiter',
      actions: [{ op: 'add_effect', insert: 'master', plugin: 'agstudio.limiter', params: [{ name: 'input', value: 6 }] }],
    }, { previousBeat: null });
    const volumes = () => {
      const p = s.doc.getState().project;
      return Object.values(p.channels).flatMap((c) => (c.kind === 'automation' ? [] : [c.volume]));
    };
    const before = volumes();
    const res = await autoLevel(s, { style: 'trap', bars: BARS });
    expect(res).not.toBeNull();
    expect(res!.buses).toEqual([]);
    const m = await measureSong(s, BARS);
    console.log(`hand-built trap: master ${m.master.lufs.toFixed(2)} LUFS, true peak ${m.master.truePeakDb!.toFixed(2)} dBTP; ${res!.changes.join(' · ')}`);
    expect(Math.abs(m.master.lufs - LEVEL_TARGETS.trap.master)).toBeLessThanOrEqual(0.5);
    expect(m.master.truePeakDb!).toBeLessThanOrEqual(-0.9);
    // Every channel moved by the same amount: the balance is the musician's.
    const after = volumes();
    const ratios = after.map((v, i) => v / before[i]!);
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0]!, 6);
    expect(ratios[0]!).toBeLessThan(1);
  }, 300_000);

  it('stops when asked, changing nothing', async () => {
    const s = createServices();
    services.push(s);
    buildSong(s, 'trap', { bpm: 140, low: '808' });
    const leveled = s.doc.getState().project;
    const abort = new AbortController();
    const run = autoLevel(s, { style: 'trap', bars: BARS, signal: abort.signal, progress: () => abort.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.doc.getState().project).toBe(leveled);
  }, 120_000);
});
