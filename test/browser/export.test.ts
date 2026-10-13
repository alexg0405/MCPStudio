import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@core/io/hash';
import { decodePcm, encodeWav } from '@core/io/wav';
import { renderOffline } from '@engine/render-offline';
import { trimRender } from '@app/export/export-wav';
import { kitProject, onsets, resolver } from '../helpers/fixtures';

const SR = 48000;

describe('WAV export', () => {
  it('renders hash-identical files twice in a row', async () => {
    const { project, patternId } = kitProject(
      [
        { generator: 'kit/kick', steps: [0, 4, 8, 12] },
        { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
      ],
      128,
    );
    const render = async () => {
      const r = await renderOffline(project, {
        plugins: resolver(),
        view: { mode: 'pattern', patternId, loop: null },
        bars: 2,
        sampleRate: SR,
        tail: 'auto',
      });
      const channels = trimRender(r.buffer, r.preRoll, (2 * 4 * 60) / 128);
      return encodeWav(channels, SR, { bitDepth: 24 });
    };
    const [a, b] = [await render(), await render()];
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });

  it('decodes a 24-bit export back to the float render within one step', async () => {
    const { project, patternId } = kitProject([{ generator: 'kit/snare', steps: [0, 8] }], 120);
    const r = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
    });
    const channels = trimRender(r.buffer, r.preRoll, 2);
    const wav = encodeWav(channels, SR, { bitDepth: 24 });
    const decoded = await new OfflineAudioContext(2, 1, SR).decodeAudioData(wav.slice().buffer);
    expect(decoded.length).toBe(channels[0]?.length);
    let err = 0;
    for (let c = 0; c < 2; c++) {
      const x = decoded.getChannelData(c);
      const y = channels[c] as Float32Array;
      for (let i = 0; i < y.length; i++) err = Math.max(err, Math.abs((x[i] as number) - (y[i] as number)));
    }
    expect(err).toBeLessThanOrEqual(1 / 2 ** 23);
    // Our own parser agrees with Chrome's decoder.
    const ours = decodePcm(wav);
    expect(ours?.channels[0]?.length).toBe(decoded.length);
  });

  it('starts at the music and trims the silence after the last tail', async () => {
    const { project, patternId } = kitProject([{ generator: 'kit/rim', steps: [0] }], 120);
    const r = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 1,
      sampleRate: SR,
      tail: 4,
    });
    const channels = trimRender(r.buffer, r.preRoll, 2);
    const left = channels[0] as Float32Array;
    // The first hit sits at the start (after the limiter's 1.3 ms look-ahead), not after the pre-roll.
    const first = left.findIndex((v) => Math.abs(v) > 0.05);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(Math.round(0.003 * SR));
    // One bar at 120 BPM is 2 s; the 4 s render tail is mostly silence and gets cut.
    expect(left.length).toBeGreaterThanOrEqual(2 * SR);
    expect(left.length).toBeLessThan(2.5 * SR);
  });

  it('renders from a start tick (a loop region)', async () => {
    const { project, patternId } = kitProject([{ generator: 'kit/rim', steps: [0, 8] }], 120);
    // Pattern mode loops the 1-bar pattern; starting half a bar in, the second hit (step 8) comes first.
    const r = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 0.5,
      fromTick: 1920,
      sampleRate: SR,
      tail: 0.2,
    });
    const hits = onsets(r.buffer, 0.05, 0.2);
    expect(hits).toHaveLength(1);
    expect(Math.abs((hits[0] as number) - Math.round(r.preRoll * SR))).toBeLessThan(Math.round(0.003 * SR));
  });

  it('reports progress and can be cancelled', async () => {
    const { project, patternId } = kitProject([{ generator: 'kit/kick', steps: [0, 4, 8, 12] }], 120);
    const controller = new AbortController();
    const seen: number[] = [];
    const done = renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 16,
      sampleRate: SR,
      chunk: 128 * 32,
      onProgress: (f) => {
        seen.push(f);
        if (f > 0.2) controller.abort();
      },
      signal: controller.signal,
    });
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((f, i) => i === 0 || f >= (seen[i - 1] as number))).toBe(true);
  });
});
