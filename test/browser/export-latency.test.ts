import { describe, expect, it } from 'vitest';
import { renderOffline } from '@engine/render-offline';
import { trimExport } from '@app/export/export-wav';
import { kitProject, onsets, resolver, withInsert } from '../helpers/fixtures';
import { latentEffect } from '../helpers/routing';

const SR = 48000;

const asBuffer = (channels: Float32Array[]) => {
  const b = new AudioBuffer({ length: channels[0]!.length, sampleRate: SR, numberOfChannels: channels.length });
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
};

describe('WAV export with delay compensation', () => {
  it('starts the file on the first beat even when an effect delays the mix', async () => {
    const latent = latentEffect(960); // 20 ms
    const kit = kitProject([{ generator: 'kit/kick', steps: [0, 8] }], 120);
    const exported = async (fx: boolean) => {
      const { project } = withInsert(kit.project, kit.channels, { fx: fx ? [{ def: latent }] : [] });
      const r = await renderOffline(project, {
        plugins: resolver(latent),
        view: { mode: 'pattern', patternId: kit.patternId, loop: null },
        bars: 1,
        sampleRate: SR,
        tail: 'auto',
      });
      return { latency: r.latency, audio: asBuffer(trimExport(r, 2)) };
    };
    const plain = await exported(false);
    const delayed = await exported(true);
    expect(plain.latency).toBe(0);
    expect(delayed.latency).toBeCloseTo(960 / SR, 9);
    const [a] = onsets(plain.audio);
    const [b] = onsets(delayed.audio);
    expect(a).toBeDefined();
    expect(Math.abs(b! - a!)).toBeLessThanOrEqual(1);
    // The tail estimate covers the delay: the second kick and its decay are still in the file.
    expect(onsets(delayed.audio)).toHaveLength(2);
  });
});
