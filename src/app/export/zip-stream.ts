import { Zip, ZipPassThrough } from 'fflate';
import { ZIP_MAX_BYTES } from '@core/io/project-file';
import type { ByteSink } from '@platform/sinks';
import { ExportError } from './export-wav';

/** A .zip of stored (uncompressed) entries written to a sink as it is built (fflate's streaming Zip). */
export class ZipStream {
  private readonly zip: Zip;
  private chain: Promise<void> = Promise.resolve();
  private error: unknown = null;
  private ended: Promise<void>;
  /** Bytes added so far (fflate writes no zip64: a .zip stays under 4 GB). */
  private total = 0;

  constructor(sink: ByteSink) {
    let resolveEnd!: () => void;
    this.ended = new Promise((r) => (resolveEnd = r));
    this.zip = new Zip((err, chunk, final) => {
      if (err) this.error ??= err;
      if (chunk.byteLength > 0) {
        const copy = chunk.slice();
        this.chain = this.chain.then(() => sink.write(copy)).catch((e: unknown) => {
          this.error ??= e;
        });
      }
      if (final) void this.chain.then(resolveEnd);
    });
  }

  /** Copies a file in, a megabyte at a time. */
  async addFile(name: string, file: Blob): Promise<void> {
    if (this.total + file.size + 1024 * 64 > ZIP_MAX_BYTES) {
      throw new ExportError('The stems add up to more than the 4 GB a .zip file can hold: export them to a folder instead.');
    }
    this.total += file.size;
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    const step = 1 << 20;
    for (let o = 0; o < file.size; o += step) {
      const bytes = new Uint8Array(await file.slice(o, Math.min(file.size, o + step)).arrayBuffer());
      entry.push(bytes, o + step >= file.size);
      await this.chain;
      if (this.error) throw this.error;
    }
    if (file.size === 0) entry.push(new Uint8Array(0), true);
  }

  async finish(): Promise<void> {
    this.zip.end();
    await this.ended;
    await this.chain;
    if (this.error) throw this.error;
  }
}
