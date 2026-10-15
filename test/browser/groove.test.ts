/**
 * Groove through the real engine, offline: the Sampler's velocity tone, swing timing (including
 * humanized notes) and the 808 slide the beat writer sets up.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { applyBeatSpec } from '@app/assistant/apply';
import { createServices, type Services } from '@app/services';
import type { InstrumentChannel } from '@core/model/types';
import { swingTick } from '@core/time/swing';
import { renderOffline } from '@engine/render-offline';
import sampler from '../../src/plugins/builtin/sampler';
import { clickOnsets, highShare, peakIn, zeroCrossingHz } from '../helpers/groove';
import { instrumentProject, renderNotes, SR, START } from '../helpers/instruments';
import { resolver } from '../helpers/fixtures';

/** Frames of one hit after the music starts. */
const HIT = Math.round(0.4 * SR);

describe('Sampler velocity tone', () => {
  const snare = (velocity: number, velTone: number) =>
    renderNotes(sampler, [{ at: 0, len: 1, key: 60, velocity }], {
      samples: { main: 'kit/snare' },
      params: { velTone },
      tail: 0,
    });

  it('makes a soft hit darker, not just quieter, and leaves full hits alone', async () => {
    const plain = await snare(0.3, 0);
    const toned = await snare(0.3, 0.5);
    const before = highShare(plain, START, START + HIT);
    const after = highShare(toned, START, START + HIT);
    console.log(`velTone: soft snare (vel 0.3) energy above 4 kHz ${before.toFixed(1)}% → ${after.toFixed(1)}% at 50 %`);
    expect(after).toBeLessThanOrEqual(0.75 * before);
    // At full velocity there is no filter: the same samples as without velocity tone.
    const full0 = (await snare(1, 0)).getChannelData(0);
    const full5 = (await snare(1, 0.5)).getChannelData(0);
    expect(full5).toEqual(full0);
  });

  it('plays exactly as before at its default (0)', async () => {
    const withParam = (await snare(0.3, 0)).getChannelData(0);
    const without = (
      await renderNotes(sampler, [{ at: 0, len: 1, key: 60, velocity: 0.3 }], { samples: { main: 'kit/snare' }, tail: 0 })
    ).getChannelData(0);
    expect(withParam).toEqual(without);
  });
});

describe('swing', () => {
  it('at 0.5 and 120 BPM plays odd 1/16s 31.25 ms late, humanized ones and rolls along the curve', async () => {
    // Rim clicks (a sharp attack) 1/8 apart or more: on the grid, on odd 1/16s, nudged ±2 and ±10 ticks, a 1/32.
    const ticks = [0, 240, 960, 960 + 240 + 2, 1920 + 240 - 2, 2880 + 240 + 10, 3840 + 120, 3840 + 1440 + 360];
    const { project, patternId } = instrumentProject(
      sampler,
      ticks.map((t) => ({ at: t / 960, len: 0.1, key: 60 })),
      { samples: { main: 'kit/rim' }, bars: 2 },
    );
    const swung = produce(project, (d) => {
      d.transport.swing = 0.5;
    });
    const { buffer } = await renderOffline(swung, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 2,
      sampleRate: SR,
      tail: 0,
    });
    const onsets = clickOnsets(buffer.getChannelData(0), 0.05, Math.round(0.05 * SR));
    expect(onsets).toHaveLength(ticks.length);
    // Relative to the first note (on a beat: never swung), so the attack and the latency cancel out.
    const ms = (frames: number) => (frames / SR) * 1000;
    const spt = 60 / 120 / 960;
    const late = onsets.map((f, i) => ms(f - onsets[0]!) - ticks[i]! * spt * 1000);
    const expected = ticks.map((t) => (swingTick(t, 0.5) - t) * spt * 1000);
    console.log(`swing 0.5 @120: late by ${late.map((x) => x.toFixed(2)).join(', ')} ms (curve: ${expected.map((x) => x.toFixed(2)).join(', ')})`);
    for (let i = 0; i < ticks.length; i++) expect(Math.abs(late[i]! - expected[i]!), `note at tick ${ticks[i]}`).toBeLessThanOrEqual(0.5);
    // On odd 1/16s, exactly on them or humanized by a tick or two: 31.25 ms late (± 0.5 ms).
    for (const i of [1, 3, 4]) expect(Math.abs(late[i]! - 31.25), `note at tick ${ticks[i]}`).toBeLessThanOrEqual(0.5);
    // On the 1/8 grid nothing moves; a 1/32 between them moves half as far.
    expect(Math.abs(late[2]!)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(late[6]! - 15.625)).toBeLessThanOrEqual(0.5);
  });
});

describe('the 808 slide the beat writer sets up', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('glides an octave (pitch ratio 2 ± 3 %) without a new attack', async () => {
    const s = createServices();
    services.push(s);
    // Two 808 notes overlapping by half a step (the second starts at 1 s); the trap palette's 808.
    const applied = applyBeatSpec(s, {
      title: 'Slide',
      bars: 1,
      bpm: 120,
      style: 'trap',
      tracks: [
        {
          name: '808',
          sound: '808',
          notes: [
            { step: 0, len: 8.5, key: 29, vel: 1 },
            { step: 8, len: 8, key: 41, vel: 1 },
          ],
        },
      ],
    });
    const project = s.doc.getState().project;
    const ch = project.channels[applied.channels['808']!] as InstrumentChannel;
    expect(ch.plugin.pluginId).toBe('agstudio.bass808');
    expect(ch.plugin.params.glide as number).toBeGreaterThanOrEqual(0.06);
    const solo = produce(project, (d) => {
      for (const id of d.channelOrder) if (id !== ch.id) d.channels[id]!.muted = true;
    });
    const { buffer } = await renderOffline(solo, {
      plugins: s.plugins,
      view: { mode: 'pattern', patternId: applied.patternId, loop: null },
      bars: 1,
      sampleRate: SR,
      tail: 0,
    });
    const x = buffer.getChannelData(0);
    const at = (sec: number) => START + Math.round(sec * SR);
    const before = zeroCrossingHz(x, SR, at(0.4), at(0.95));
    const after = zeroCrossingHz(x, SR, at(1.25), at(1.9));
    const ratio = after / before;
    // No new attack: the level right after the slide starts is about what it was just before.
    const envelope = peakIn(x, at(1.0), at(1.15)) / peakIn(x, at(0.85), at(1.0));
    console.log(`808 slide: ${before.toFixed(2)} Hz → ${after.toFixed(2)} Hz, ratio ${ratio.toFixed(4)}, envelope ratio ${envelope.toFixed(3)}`);
    expect(Math.abs(ratio - 2)).toBeLessThanOrEqual(0.06);
    expect(envelope).toBeLessThan(1.6);
  });
});
