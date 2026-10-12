import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { setChannelProp } from '@core/ops/channels';
import { renderOffline } from '@engine/render-offline';
import { kitProject, onsets, peak, resolver, rms } from '../helpers/fixtures';

const SR = 48000;

describe('engine offline render', () => {
  it('plays four-on-the-floor hits with sample-accurate onsets', async () => {
    // A short rim shot so every hit is isolated (a kick's tail overlaps the next beat).
    const { project, patternId } = kitProject([{ generator: 'kit/rim', steps: [0, 4, 8, 12] }], 120);
    const buffer = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 2,
      sampleRate: SR,
    });
    expect(rms(buffer)).toBeGreaterThan(0.01);
    const found = onsets(buffer, 0.05, 0.2);
    // 120 BPM: a beat every 0.5 s over two bars.
    const expected = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((s) => Math.round(s * SR));
    expect(found).toHaveLength(expected.length);
    found.forEach((f, i) => expect(Math.abs(f - (expected[i] as number))).toBeLessThanOrEqual(48)); // ±1 ms
  });

  it('renders silence for a muted channel', async () => {
    const { project, patternId, channels } = kitProject([{ generator: 'kit/snare', steps: [0, 8] }]);
    const muted = produce(project, (d) => setChannelProp(d, channels[0]!, 'muted', true));
    const buffer = await renderOffline(muted, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
    });
    expect(peak(buffer)).toBeLessThan(1e-4);
  });

  it('mixes several kit channels and respects channel volume', async () => {
    const tracks = [
      { generator: 'kit/kick', steps: [0, 8] },
      { generator: 'kit/clap', steps: [4, 12] },
      { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
    ];
    const { project, patternId, channels } = kitProject(tracks);
    const loud = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
    });
    const quiet = produce(project, (d) => {
      for (const id of channels) setChannelProp(d, id, 'volume', 0.39);
    });
    const half = await renderOffline(quiet, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
    });
    expect(rms(loud)).toBeGreaterThan(0.01);
    expect(peak(half) / peak(loud)).toBeCloseTo(0.5, 1);
  });

  it('renders identically twice (deterministic)', async () => {
    const { project, patternId } = kitProject([
      { generator: 'kit/snare', steps: [4, 12] },
      { generator: 'kit/crash', steps: [0] },
    ]);
    const opts = {
      plugins: resolver(),
      view: { mode: 'pattern' as const, patternId, loop: null },
      bars: 1,
      sampleRate: SR,
    };
    const a = (await renderOffline(project, opts)).getChannelData(0);
    const b = (await renderOffline(project, opts)).getChannelData(0);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs((a[i] as number) - (b[i] as number)));
    expect(diff).toBe(0);
  });
});
