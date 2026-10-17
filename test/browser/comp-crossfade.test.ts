/**
 * A comp through the real engine (offline render): the comp lane is plain audio clips split at the comp's
 * borders, so nothing in playback or export knows about takes. Where two takes meet, an equal-power crossfade
 * keeps the output smooth: no sample-to-sample jump at the border (a hard cut between two takes of different
 * phase jumps by about the signal's amplitude).
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { tempoMapOf } from '@core/automation/tempo';
import { clipEnvelopeAt } from '@core/audio/envelope';
import type { AudioClip, Project } from '@core/model/types';
import { addTakeGroup, compSetCrossfade, compSwipe, newTakeGroup } from '@core/ops/comp';
import { takeGroups } from '@core/query/takes';
import { renderOffline } from '@engine/render-offline';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';

const SR = 48000;
const LIMITER = Math.round(0.0013 * SR);
const BAR = 3840; // 2 s at 120 BPM

/** Two 2 s takes of a 440 Hz tone, the second a different phase, one after the other in one recording. */
function recording() {
  const x = new Float32Array(4 * SR);
  for (let i = 0; i < x.length; i++) {
    const phase = i < 2 * SR ? 0 : 2.1;
    x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR + phase);
  }
  const samples = new TestSamples();
  const ref = samples.add([x, x.slice()], SR);
  const { project, channelId } = audioClipProject(ref, [], { bpm: 120 });
  return { samples, project, channelId, x };
}

function comped(project: Project, channelId: AudioClip['channelId'], crossfadeMs: number): { project: Project; group: string } {
  const group = newTakeGroup();
  const tempo = tempoMapOf(project, 'song');
  const next = produce(project, (d) => {
    addTakeGroup(d, {
      group,
      name: 'Rec',
      channelId,
      takes: [
        { start: 0, length: BAR, offsetSec: 0 },
        { start: 0, length: BAR, offsetSec: 2 },
      ],
      audible: 0,
      first: 0,
      tempo,
      crossfadeMs,
    });
    // Take 2 plays the second half of the bar.
    compSwipe(d, group, 1, BAR / 2, BAR, tempo);
  });
  return { project: next, group };
}

async function render(project: Project, samples: TestSamples) {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: 1,
    sampleRate: SR,
    tail: 0.2,
  });
  const start = Math.round(r.preRoll * SR) + LIMITER;
  return r.buffer.getChannelData(0).subarray(start);
}

/** The quietest 1 ms (RMS) within ±`around` seconds of `at` seconds: a dip at the border shows here. */
function quietest(out: Float32Array, at: number, around: number): number {
  const w = Math.round(0.001 * SR);
  let m = Infinity;
  for (let i = Math.round((at - around) * SR); i < Math.round((at + around) * SR); i += 8) {
    let e = 0;
    for (let k = 0; k < w; k++) e += (out[i + k] as number) ** 2;
    m = Math.min(m, Math.sqrt(e / w));
  }
  return m;
}

/** The largest step between neighbouring samples within ±`around` seconds of `at` seconds. */
function maxJump(out: Float32Array, at: number, around: number): number {
  let m = 0;
  for (let i = Math.round((at - around) * SR); i < Math.round((at + around) * SR); i++)
    m = Math.max(m, Math.abs((out[i + 1] as number) - (out[i] as number)));
  return m;
}

describe('comp crossfades', () => {
  it('a comp border crossfades: no click at the cut, and the output is the clips’ own audio times their fades', async () => {
    const { samples, project, channelId, x } = recording();
    const { project: p, group } = comped(project, channelId, 10);
    const g = takeGroups(p).find((y) => y.id === group)!;
    expect(g.comp).toHaveLength(2);
    const out = await render(p, samples);
    // The signal's own steepest step: 2π · 440 · 0.5 / SR.
    const slope = (2 * Math.PI * 440 * 0.5) / SR;
    expect(maxJump(out, 1, 0.1)).toBeLessThan(slope * 1.6);
    // Sample by sample: every comp clip plays the recording from its trim, scaled by its fades.
    let err = 0;
    for (let i = Math.round(0.9 * SR); i < Math.round(1.1 * SR); i++) {
      const t = i / SR;
      let want = 0;
      for (const c of g.comp) {
        const dur = c.length / 1920;
        const local = t - c.start / 1920;
        if (local < 0 || local > dur) continue;
        want += (x[Math.round((c.offsetSec + local) * SR)] as number) * clipEnvelopeAt(c, local, dur);
      }
      err = Math.max(err, Math.abs((out[i] as number) - want));
    }
    expect(err).toBeLessThan(0.01);
  });

  it('the crossfade keeps the level across the border at least as well as a hard cut (the engine’s own 2 ms and 4 ms ramps already stop a hard cut from clicking)', async () => {
    const { samples, project, channelId } = recording();
    const hard = comped(project, channelId, 0);
    const out = await render(hard.project, samples);
    const soft = await render(comped(project, channelId, 20).project, samples);
    // The tone is 0.5 · 0.707 = 0.35 RMS; across a crossfade of two takes a rad or two apart in phase it stays above 0.2.
    expect(quietest(soft, 1, 0.006)).toBeGreaterThan(0.2);
    expect(quietest(soft, 1, 0.006)).toBeGreaterThanOrEqual(quietest(out, 1, 0.006) - 0.005);
    // Even the hard cut does not click (the jump stays within a couple of the tone's own steps).
    expect(maxJump(out, 1, 0.1)).toBeLessThan(0.06);
    // Turning the crossfade up afterwards rebuilds the comp with it, keeping the borders.
    const tempo = tempoMapOf(hard.project, 'song');
    const later = produce(hard.project, (d) => compSetCrossfade(d, hard.group, 20, tempo));
    expect(takeGroups(later).find((g) => g.id === hard.group)!.crossfadeMs).toBe(20);
    expect(maxJump(await render(later, samples), 1, 0.1)).toBeLessThan(0.05);
  });
});
