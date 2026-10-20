import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import type { AlignEdit, AudioClip, ClipId, Project } from '../../model/types';
import { alignedSampleId, describeAlign, sanitizeAlignEdit } from './edit';
import { alignProblem, guideProblem, nearestLine, planAlignment } from './plan';

/** At 120 BPM a beat (960 ticks) is half a second. */
const BEAT = 960;

/** A lead on one track and a double on another, over the same 8-second sample (with a different trim and place). */
function setup(spec?: { doubleStart?: number; doubleOffset?: number; channel?: Record<string, unknown> }) {
  const samples = new TestSamples();
  const lead = samples.add([new Float32Array(48000 * 8)], 48000, 'lead');
  const double = samples.add([new Float32Array(48000 * 8)], 48000, 'double');
  const one = audioClipProject(lead, [{ start: 0, length: BEAT * 8, offsetSec: 0 }]);
  const two = audioClipProject(double, [{ start: spec?.doubleStart ?? BEAT, length: BEAT * 6, offsetSec: spec?.doubleOffset ?? 0.25 }], {
    channel: (spec?.channel ?? {}) as never,
  });
  // Merge the second project's channel, sample and clip into the first.
  const project = produce(one.project, (d) => {
    const clip = two.project.playlist.clips[two.clipIds[0] as ClipId] as AudioClip;
    d.samples[double.id] = two.project.samples[double.id]!;
    d.channels[two.channelId] = two.project.channels[two.channelId]!;
    d.channelOrder.push(two.channelId);
    d.playlist.clips[clip.id] = { ...clip, laneId: d.playlist.laneOrder[1]! };
  });
  return { project, lead: one.clipIds[0] as ClipId, double: two.clipIds[0] as ClipId, doubleSample: double.id };
}

const withAlign = (p: Project, id: ClipId, align: AlignEdit): Project =>
  produce(p, (d) => {
    (d.playlist.clips[id] as AudioClip).align = align;
  });

describe('planAlignment (guide)', () => {
  it('puts the guide on the clip’s stretch: the clip plays the sample from 0.25 s at 0.5 s, the lead from 0', () => {
    const t = setup();
    const p = withAlign(t.project, t.double, { mode: 'guide', guide: t.lead, tightness: 70 });
    const result = planAlignment(p, t.double);
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    const { plan } = result;
    // The stretch covers the clip's trim minus a margin of 0.3 s (so from 0) to the end of what it plays plus 0.3 s.
    expect(plan.region.fromSec).toBe(0);
    expect(plan.region.toSec).toBeCloseTo(0.25 + 3 + 0.3, 6);
    // The clip plays from 0.25 s into the stretch (the stretch starts at 0), for 3 s.
    expect(plan.audible.fromSec).toBeCloseTo(0.25, 6);
    expect(plan.audible.toSec).toBeCloseTo(3.25, 6);
    // Song time 0.5 s is the clip's sample time 0.25 s and the lead's sample time 0.5 s: the guide is 0.25 s ahead.
    expect(plan.guide?.startSec).toBeCloseTo(0.25, 6);
    // The lead plays from its sample time 0 to 4 s: on the stretch that is −0.25 s to 3.75 s.
    expect(plan.guide?.audible.fromSec).toBeCloseTo(-0.25, 6);
    expect(plan.guide?.audible.toSec).toBeCloseTo(3.75, 6);
    expect(plan.sourceSampleId).toBe(t.doubleSample);
  });

  it('changes the signature with anything the render depends on, and not with anything else', () => {
    const t = setup();
    const base = withAlign(t.project, t.double, { mode: 'guide', guide: t.lead, tightness: 70 });
    const signature = (p: Project) => {
      const r = planAlignment(p, t.double);
      return 'plan' in r ? r.plan.signature : r.problem;
    };
    const was = signature(base);
    expect(signature(withAlign(t.project, t.double, { mode: 'guide', guide: t.lead, tightness: 71 }))).not.toBe(was);
    expect(signature(withAlign(t.project, t.double, { mode: 'guide', guide: t.lead, tightness: 70, pitch: 50 }))).not.toBe(was);
    // Moving the clip or the guide moves the stretch the sound has to follow.
    const moved = produce(base, (d) => void ((d.playlist.clips[t.double] as AudioClip).start += 240));
    expect(signature(moved)).not.toBe(was);
    const guideMoved = produce(base, (d) => void ((d.playlist.clips[t.lead] as AudioClip).start += 240));
    expect(signature(guideMoved)).not.toBe(was);
    // The render, the render's signature and the overlay are results, not inputs.
    const rendered = produce(base, (d) => {
      const a = (d.playlist.clips[t.double] as AudioClip).align!;
      a.renderedSampleId = 'smp_x' as never;
      a.renderedFor = 'something';
      a.warp = [0, 1, 1, 2];
    });
    expect(signature(rendered)).toBe(was);
  });

  it('says why a clip or a guide cannot be used', () => {
    const t = setup();
    expect(alignProblem(t.project, t.double)).toBeNull();
    expect(alignProblem(t.project, 'nope' as ClipId)).toMatch(/not an audio clip/);
    expect(guideProblem(t.project, t.double, undefined)).toMatch(/Choose/);
    expect(guideProblem(t.project, t.double, t.double)).toMatch(/itself/);
    expect(guideProblem(t.project, t.double, t.lead)).toBeNull();
    // A clip that does not play at its own speed (reversed) cannot be aligned.
    const reversed = setup({ channel: { reverse: true } });
    expect(alignProblem(reversed.project, reversed.double)).toMatch(/own speed/);
    // Two clips following each other would never settle.
    const ring = withAlign(withAlign(t.project, t.double, { mode: 'guide', guide: t.lead, tightness: 70 }), t.lead, { mode: 'guide', guide: t.double, tightness: 70 });
    expect(guideProblem(ring, t.lead, t.double)).toMatch(/already/);
    expect('problem' in planAlignment(ring, t.lead)).toBe(true);
  });
});

describe('planAlignment (grid)', () => {
  it('lists the grid lines of the stretch in seconds from its start, and limits how far an onset moves', () => {
    const t = setup();
    const p = withAlign(t.project, t.double, { mode: 'grid', tightness: 70, strength: 80, stepTicks: 240 });
    const r = planAlignment(p, t.double);
    if (!('plan' in r)) throw new Error('no plan');
    const lines = r.plan.grid!.linesSec;
    // A 1/16 step at 120 BPM is 125 ms. The stretch starts at sample time 0 = song time 0.25 s.
    expect(lines[1]! - lines[0]!).toBeCloseTo(0.125, 6);
    expect(lines.some((x) => Math.abs(x - 0.25) < 1e-6)).toBe(true);
    expect(r.plan.grid!.maxMoveSec).toBeCloseTo(0.45 * 0.125, 6);
    // The beat changes the lines (and so the signature); the strength and the step too.
    const slower = produce(p, (d) => void (d.transport.bpm = 100));
    const a = planAlignment(slower, t.double);
    expect('plan' in a && a.plan.signature !== r.plan.signature).toBe(true);
  });

  it('finds the nearest line', () => {
    const near = nearestLine([0, 0.125, 0.25, 0.375]);
    expect(near(0.06)).toBe(0);
    expect(near(0.07)).toBe(0.125);
    expect(near(0.3)).toBe(0.25);
    expect(near(5)).toBe(0.375);
    expect(near(-1)).toBe(0);
    expect(nearestLine([])(0.3)).toBe(0.3);
  });
});

describe('alignment as data', () => {
  it('reads settings from damaged data', () => {
    expect(sanitizeAlignEdit(null)).toBeNull();
    expect(sanitizeAlignEdit({ mode: 'weird', tightness: 5 })).toBeNull();
    expect(sanitizeAlignEdit({ mode: 'guide', tightness: 50 })).toBeNull(); // a guide mode with no guide
    const guide = sanitizeAlignEdit({ mode: 'guide', guide: 'clp_1', tightness: 900, pitch: -5, renderedSampleId: 'smp_a', warp: [0, 1, 0.5, 2] });
    expect(guide).toEqual({ mode: 'guide', guide: 'clp_1', tightness: 100, renderedSampleId: 'smp_a', warp: [0, 1, 0.5, 2] });
    const grid = sanitizeAlignEdit({ mode: 'grid', strength: 400, stepTicks: 120.4, tightness: 'x', warp: [1, 2, 0, 3] });
    expect(grid).toEqual({ mode: 'grid', strength: 100, stepTicks: 120, tightness: 70 }); // a warp that goes backwards is dropped
  });

  it('names the sound a later step starts from, and describes the edit in words', () => {
    const channel = { sampleId: 'smp_own' as never };
    expect(alignedSampleId(channel, undefined)).toBe('smp_own');
    expect(alignedSampleId(channel, { align: { mode: 'grid', tightness: 1, renderedSampleId: 'smp_r' as never } })).toBe('smp_r');
    expect(describeAlign({ mode: 'guide', guide: 'c' as ClipId, tightness: 70.4, pitch: 50 })).toBe('Aligned to a guide, tightness 70, pitch 50 %');
    expect(describeAlign({ mode: 'grid', tightness: 70, strength: 80 })).toBe('Tightened to the grid, 80 %');
  });
});
