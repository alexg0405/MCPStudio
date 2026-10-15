import type { SampleRef, SampleSource } from '@core/model/types';
import { generateFx } from './kit/fx';
import { generate } from './kit/generators';
import type { SampleBytesProvider } from './api';
import { decodeAudio } from './decode';

/**
 * Decoded sample cache keyed by source and sample rate. Built-in (procedural) samples are generated
 * synchronously; embedded samples are decoded from the bytes the app provides. AudioBuffers are not
 * tied to a context, so the cache survives engine reboots.
 */
export class SampleCache {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();

  constructor(private readonly provider?: SampleBytesProvider) {}

  private key(source: SampleSource, sampleRate: number): string {
    return source.kind === 'builtin'
      ? `b:${source.generator}@${source.version}:${sampleRate}`
      : `e:${source.hash}:${sampleRate}`;
  }

  /** The buffer if it is available without waiting (built-ins always are). */
  getSync(ref: Pick<SampleRef, 'source'>, sampleRate: number): AudioBuffer | null {
    const key = this.key(ref.source, sampleRate);
    const hit = this.buffers.get(key);
    if (hit) return hit;
    if (ref.source.kind !== 'builtin') return null;
    // Kit sounds, then the arranger's transition sounds (risers, impacts… named fx/<kind>/…).
    const data = generate(ref.source.generator, sampleRate) ?? generateFx(ref.source.generator, sampleRate);
    if (!data || data.length === 0) return null;
    const buffer = new AudioBuffer({ length: data[0]!.length, numberOfChannels: data.length, sampleRate });
    data.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    this.buffers.set(key, buffer);
    return buffer;
  }

  async load(ref: Pick<SampleRef, 'source'>, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    const sync = this.getSync(ref, ctx.sampleRate);
    if (sync || ref.source.kind === 'builtin') return sync;
    const key = this.key(ref.source, ctx.sampleRate);
    let p = this.pending.get(key);
    if (!p) {
      p = (async () => {
        const bytes = await this.provider?.getBytes(ref as SampleRef);
        if (!bytes) return null;
        try {
          const buffer = await decodeAudio(ctx, bytes);
          this.buffers.set(key, buffer);
          return buffer;
        } catch (e) {
          console.warn(`Can't decode sample "${(ref as SampleRef).name ?? ''}"`, e);
          return null;
        }
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }
}
