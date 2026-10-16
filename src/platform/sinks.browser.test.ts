import { describe, expect, it } from 'vitest';
import { isOpfsAvailable } from './opfs';
import { openTempFile, sweepTempFiles } from './sinks';

async function tmpNames(): Promise<string[]> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('tmp', { create: true });
  const names: string[] = [];
  for await (const [name] of dir.entries()) names.push(name);
  return names;
}

describe.skipIf(!isOpfsAvailable())('temporary export files', () => {
  it('a sweep removes what a tab that is gone left behind, and keeps what is in use', async () => {
    const live = await openTempFile('stem');
    expect(live).not.toBeNull();
    await live!.sink.write(new Uint8Array(1000));
    await live!.sink.close();
    // A file nobody holds: what a tab that crashed in the middle of a stems export leaves.
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('tmp', { create: true });
    const stale = `stem-${Date.now() - 1000}-9999`;
    const w = await (await dir.getFileHandle(stale, { create: true })).createWritable();
    await w.write(new Uint8Array(500));
    await w.close();
    expect(await tmpNames()).toContain(stale);

    const removed = await sweepTempFiles();
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await tmpNames();
    expect(left).not.toContain(stale);
    expect(left.length).toBeGreaterThanOrEqual(1);
    expect((await live!.file()).size).toBe(1000);

    await live!.remove();
    expect(await sweepTempFiles()).toBe(0);
  });

  it('sweeping with no tmp folder is fine', async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('tmp', { recursive: true }).catch(() => {});
    expect(await sweepTempFiles()).toBe(0);
  });
});
