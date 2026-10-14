import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { tempoMapOf } from '@core/automation/tempo';
import type { ClipId, LaneId, ParamTarget, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { renderOffline } from '@engine/render-offline';
import type { PluginDef } from '@agstudio/sdk';
import filter from '../../src/plugins/builtin/filter';
import { automate, bandPower, pt, rmsEnvelope } from '../helpers/automation';
import { kitProject, onsets, resolver, withInsert } from '../helpers/fixtures';
import { heldNote, noise, tone } from '../helpers/tone';

const SR = 48000;
const LIMITER = Math.round(0.0013 * SR);
const BAR = 3840;

const sineRms = (amplitude: number) => amplitude / Math.SQRT2;
const plugins = () => resolver(tone, noise);
/** RMS of the 20 ms window starting at song time `t` (seconds). */
const at = (env: number[], t: number) => env[Math.round(t / 0.02)] as number;

describe('automation (offline renders)', () => {
  it('a channel volume ramp: the RMS envelope follows the curve, holding before and after', async () => {
    const { project: base, pid, ch } = heldNote(tone, 4);
    const target: ParamTarget = { kind: 'channel', channelId: ch, param: 'volume' };
    // Bar 1: the channel's own volume (0.78); bars 2–3: 0 → 1.25; bar 4: hold.
    const { project } = automate(base, target, [pt(0, 0), pt(2 * BAR, 1)], [{ start: BAR, length: 2 * BAR, lane: 1 }]);
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: plugins(),
      view: { mode: 'song', patternId: pid, loop: null },
      bars: 4,
      sampleRate: SR,
      tail: 0.1,
    });
    const env = rmsEnvelope(buffer, 0.02 * SR, Math.round(preRoll * SR) + LIMITER);
    expect(at(env, 1)).toBeCloseTo(sineRms(0.25 * 0.78), 3);
    for (const t of [2.5, 3, 4, 5, 5.9]) expect(at(env, t)).toBeCloseTo(sineRms(0.25 * 1.25 * ((t + 0.01 - 2) / 4)), 3);
    expect(at(env, 7)).toBeCloseTo(sineRms(0.25 * 1.25), 3);
  });

  it('an insert volume ramp follows the fader taper', async () => {
    const one = heldNote(tone, 2);
    const { project: routed, insertId } = withInsert(one.project, [one.ch]);
    const target: ParamTarget = { kind: 'insert', insertId, param: 'volume' };
    const { project } = automate(routed, target, [pt(0, 0.8), pt(BAR, 0.4)], [{ start: 0, length: 2 * BAR, lane: 1 }]);
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: plugins(),
      view: { mode: 'song', patternId: one.pid, loop: null },
      bars: 2,
      sampleRate: SR,
      tail: 0.1,
    });
    const env = rmsEnvelope(buffer, 0.02 * SR, Math.round(preRoll * SR) + LIMITER);
    const k = Math.log(1.905) / Math.log(1.25);
    for (const t of [0.2, 0.7, 1.2, 1.7, 2.5, 3.5]) {
      const pos = t < 2 ? 0.8 - 0.4 * ((t + 0.01) / 2) : 0.4;
      expect(at(env, t)).toBeCloseTo(sineRms(0.25 * 0.78 * Math.pow(pos / 0.8, k)), 3);
    }
  });

  it('a filter cutoff sweep moves the spectrum over time', async () => {
    const one = heldNote(noise, 2);
    const { project: routed, insertId, slots } = withInsert(one.project, [one.ch], {
      fx: [{ def: filter as PluginDef, params: { cutoff: 1000 } }],
    });
    const cutoff: ParamTarget = {
      kind: 'plugin',
      owner: { kind: 'fx', insertId, slotId: slots[0]! },
      paramId: 'cutoff',
    };
    const n = (hz: number) => Math.log(hz / 20) / Math.log(1000);
    const { project } = automate(routed, cutoff, [pt(0, n(200)), pt(2 * BAR, n(8000))], [
      { start: 0, length: 2 * BAR, lane: 1 },
    ]);
    const render = (pr: Project) =>
      renderOffline(pr, {
        plugins: plugins(),
        view: { mode: 'song', patternId: one.pid, loop: null },
        bars: 2,
        sampleRate: SR,
        tail: 0.1,
      });
    const { buffer, preRoll } = await render(project);
    const start = Math.round(preRoll * SR);
    // Noise: average many bins (one bin of a noise spectrum varies a lot).
    const band = (t: number, b: AudioBuffer = buffer) => {
      let sum = 0;
      for (let k = 0; k < 24; k++) sum += bandPower(b, 3000 + k * 100, start + Math.round(t * SR), 8192);
      return sum / 24;
    };
    const levels = [0.3, 1.3, 2.3, 3.3].map((t) => band(t));
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]! * 2);
    // Early (cutoff ~250 Hz) against late (~6 kHz): far more than 20 dB apart.
    expect(10 * Math.log10(levels[3]! / levels[0]!)).toBeGreaterThan(20);
    // Without the clip the filter stays at its own 1 kHz.
    const still = await render(routed);
    const flat = [0.3, 3.3].map((t) => band(t, still.buffer));
    expect(Math.abs(10 * Math.log10(flat[1]! / flat[0]!))).toBeLessThan(3);
  });

  it('a tempo ramp: hits land where the tempo map puts them', async () => {
    const { project: kit, patternId } = kitProject([{ generator: 'kit/rim', steps: [0, 4, 8, 12] }], 120);
    const withClips = produce(kit, (d) => {
      for (let b = 0; b < 4; b++)
        addClips(d, [
          {
            kind: 'pattern',
            id: `c${b}` as ClipId,
            laneId: d.playlist.laneOrder[0] as LaneId,
            start: b * BAR,
            length: BAR,
            patternId,
            offset: 0,
          },
        ]);
    });
    // 120 → 180 BPM over the four bars (range 60–180).
    const { project } = automate(withClips, { kind: 'tempo' }, [pt(0, 0.5), pt(4 * BAR, 1)], [
      { start: 0, length: 4 * BAR, lane: 1 },
    ]);
    const tempo = tempoMapOf(project, 'song');
    expect(tempo.bpmAt(2 * BAR)).toBeCloseTo(150, 0);
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'song', patternId, loop: null },
      bars: 4,
      sampleRate: SR,
      tail: 0.2,
    });
    const found = onsets(buffer, 0.05, 0.15);
    const expected = Array.from({ length: 16 }, (_, k) => Math.round((preRoll + tempo.tickToSeconds(k * 960)) * SR) + LIMITER);
    expect(found).toHaveLength(16);
    found.forEach((f, i) => expect(Math.abs(f - expected[i]!)).toBeLessThanOrEqual(Math.round(0.002 * SR)));
    // The beats get closer together as the tempo rises.
    expect(found[15]! - found[14]!).toBeLessThan(found[1]! - found[0]!);
  });

  it('starting in the middle of a clip applies the value at that tick', async () => {
    const { project: base, pid, ch } = heldNote(tone, 3, 120, BAR);
    const target: ParamTarget = { kind: 'channel', channelId: ch, param: 'volume' };
    const { project } = automate(base, target, [pt(0, 0), pt(2 * BAR, 1)], [{ start: 0, length: 2 * BAR, lane: 1 }]);
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: plugins(),
      view: { mode: 'song', patternId: pid, loop: null },
      bars: 1,
      fromTick: BAR,
      sampleRate: SR,
      tail: 0.1,
    });
    const env = rmsEnvelope(buffer, 0.02 * SR, Math.round(preRoll * SR) + LIMITER);
    // Bar 2 starts halfway up the ramp (0.625), not at the channel's own 0.78.
    expect(at(env, 0)).toBeCloseTo(sineRms(0.25 * 1.25 * ((BAR + 0.01 * 1920) / (2 * BAR))), 3);
    expect(at(env, 1.5)).toBeCloseTo(sineRms(0.25 * 1.25 * ((BAR + 1.51 * 1920) / (2 * BAR))), 3);
  });

  it('automates a worklet instrument’s own param (a-rate) and reads it at note time', async () => {
    const { project: base, pid, ch } = heldNote(tone, 2);
    const level: ParamTarget = { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'level' };
    const { project } = automate(base, level, [pt(0, 1), pt(2 * BAR, 0.25)], [{ start: 0, length: 2 * BAR, lane: 1 }]);
    const { buffer, preRoll } = await renderOffline(project, {
      plugins: plugins(),
      view: { mode: 'song', patternId: pid, loop: null },
      bars: 2,
      sampleRate: SR,
      tail: 0.1,
    });
    const env = rmsEnvelope(buffer, 0.02 * SR, Math.round(preRoll * SR) + LIMITER);
    for (const t of [0.5, 2, 3.5]) expect(at(env, t)).toBeCloseTo(sineRms(0.25 * 0.78 * (1 - 0.75 * ((t + 0.01) / 4))), 3);
  });
});
