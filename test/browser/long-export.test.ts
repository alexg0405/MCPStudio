/**
 * Hour-long exports: rendering window by window gives the single render bit for bit (reverb and
 * delay tails across the window boundaries included), and the streamed files decode back to it.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import type { ClipId, LaneId, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { renderStream, windowGrid } from '@engine/render-offline';
import delay from '../../src/plugins/builtin/delay';
import reverb from '../../src/plugins/builtin/reverb';
import { kitProject, resolver, withInsert } from '../helpers/fixtures';

const SR = 48000;

/**
 * A drum loop through reverb and delay, `bars` long in song mode at 128 BPM (exact timing). Two
 * channels: Chrome sums three or more connections into one input in an order that changes from
 * render to render (by memory address), so with more, even two plain renders differ by a rounding
 * step here and there; with two, renders are bit for bit repeatable.
 */
function reverbDelaySong(bars: number, fx: 'both' | 'none' | 'reverb' | 'delay' = 'both'): Project {
  const { project: kit, patternId, channels } = kitProject(
    [
      { generator: 'kit/kick', steps: [0, 4, 8, 12] },
      { generator: 'kit/snare', steps: [4, 10, 12] },
    ],
    128,
  );
  const all = { reverb: { def: reverb }, delay: { def: delay, params: { feedback: 0.45 } } };
  const list = fx === 'both' ? [all.reverb, all.delay] : fx === 'none' ? [] : [all[fx]];
  const { project } = withInsert(kit, channels, { fx: list });
  return produce(project, (d) => {
    addClips(d, [
      {
        kind: 'pattern',
        id: 'clip_loop' as ClipId,
        laneId: d.playlist.laneOrder[0] as LaneId,
        start: 0,
        length: bars * 3840,
        patternId,
        offset: 0,
      },
    ]);
  });
}

async function streamAll(project: Project, bars: number, windowSec: number, sampleRate = SR) {
  const parts: Float32Array[][] = [];
  const t0 = performance.now();
  const r = await renderStream(project, {
    plugins: resolver(),
    view: { mode: 'song', patternId: null, loop: null },
    bars,
    sampleRate,
    tail: 'auto',
    windowSec,
    onAudio: (channels) => {
      parts.push(channels);
    },
  });
  const ms = performance.now() - t0;
  const join = (c: number) => {
    const out = new Float32Array(r.frames);
    let o = 0;
    for (const p of parts) {
      out.set(p[c]!, o);
      o += p[c]!.length;
    }
    return out;
  };
  return { r, left: join(0), right: join(1), ms };
}

describe('windowed renders', () => {
  it('uses a grid that keeps windows on the render quantum (and the reverb partitions at 48 kHz)', () => {
    expect(windowGrid(48000)).toBe(128);
    expect((windowGrid(44100) * 44100) % 128).toBe(0);
    expect(windowGrid(96000)).toBe(64);
  });

  it('stitch to the single render bit for bit, reverb and delay tails across the boundary included', async () => {
    const bars = 80; // 150 s: two 128 s windows
    const project = reverbDelaySong(bars);
    const one = await streamAll(project, bars, 100000);
    const two = await streamAll(project, bars, 128);
    expect(one.r.windows).toBe(1);
    expect(two.r.windows).toBe(2);
    expect(two.r.frames).toBe(one.r.frames);
    let diffs = 0;
    let worst = 0;
    for (const [a, b] of [
      [one.left, two.left],
      [one.right, two.right],
    ] as const) {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          diffs++;
          worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
        }
      }
    }
    console.log(`single ${Math.round(one.ms)} ms, windowed ${Math.round(two.ms)} ms; ${diffs} samples differ, worst ${worst}`);
    // The boundary (128 s) is in the middle of the music: there is sound there.
    let level = 0;
    for (let i = 128 * SR - 4800; i < 128 * SR + 4800; i++) level = Math.max(level, Math.abs(one.left[i]!));
    expect(level).toBeGreaterThan(0.05);
    expect(diffs).toBe(0);
  }, 120_000);

  it('at 44.1 kHz (no partition-aligned grid) stays within rounding of the single render', async () => {
    const bars = 40; // 75 s: three 32 s windows
    const project = reverbDelaySong(bars);
    const one = await streamAll(project, bars, 100000, 44100);
    const three = await streamAll(project, bars, 32, 44100);
    expect(three.r.windows).toBe(3);
    let worst = 0;
    for (let i = 0; i < one.left.length; i++) worst = Math.max(worst, Math.abs(one.left[i]! - three.left[i]!));
    console.log(`44.1 kHz: worst difference ${worst} (${(20 * Math.log10(worst || 1e-12)).toFixed(0)} dBFS)`);
    expect(worst).toBeLessThan(1e-5);
  }, 120_000);
});

