import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { FlpError } from '@core/io/flp';
import { encodeWav } from '@core/io/wav';
import type { InstrumentChannel } from '@core/model/types';
import { flpProject, type ProjectSpec } from '../../../test/helpers/flp';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { createMemoryBlobStore } from '../persistence/blob-store';
import { createTestServices } from '../testing';
import { importFlpFile, missingSamples, relinkMissingSamples } from './flp-import';

const wav = (n: number) => encodeWav([new Float32Array(4800).fill(n)], 48000, { bitDepth: 16 });
const fileOf = (name: string, bytes: Uint8Array) => ({ name, arrayBuffer: async () => bytes.slice().buffer });

const SPEC: ProjectSpec = {
  title: 'Night Drive',
  tempo: 120,
  channels: [
    { name: 'Kick', sample: 'C:\\Users\\me\\Samples\\Kick 01.wav' },
    { name: 'Snare', sample: '/Users/me/Splice/Snare 7.wav' },
    { name: 'Lead', plugin: 'Fruity Wrapper', vst: 'Serum' },
  ],
  patterns: [
    {
      iid: 1,
      name: 'Beat',
      notes: [
        { position: 0, channel: 0, length: 24, key: 60 },
        { position: 48, channel: 1, length: 24, key: 60 },
        { position: 0, channel: 2, length: 96, key: 72 },
      ],
    },
  ],
  arrangements: [{ name: 'Arrangement', items: [{ position: 0, length: 384, track: 0, pattern: 1 }] }],
};

describe('FL Studio import (app)', () => {
  it('opens a zipped loop package as a new unsaved project with its samples embedded', async () => {
    const s = createTestServices();
    const store = createMemoryBlobStore();
    const zip = zipSync({
      'Night Drive/Night Drive.flp': flpProject(SPEC),
      'Night Drive/Samples/Kick 01.wav': wav(0.5),
    });
    const out = await importFlpFile(s, fileOf('Night Drive.zip', zip), { store });
    expect(out).not.toBeNull();
    const p = s.doc.getState().project;
    expect(projectViolations(p)).toEqual([]);
    expect(p.meta.title).toBe('Night Drive');
    expect(s.files.store.getState()).toMatchObject({ name: 'Night Drive', handle: null });
    expect(s.history.status()).toMatchObject({ dirty: true, canUndo: false });
    expect(s.view.getState().mode).toBe('song');
    const kick = Object.values(p.channels).find((c) => c.name === 'Kick') as InstrumentChannel;
    const ref = p.samples[kick.plugin.samples!.main!]!;
    expect(ref.source.kind).toBe('embedded');
    expect(ref.durationSec).toBeCloseTo(0.1, 6);
    expect(ref.source.kind === 'embedded' && (await store.hasBlob(ref.source.hash, ref.source.ext))).toBe(true);
    expect(out!.report.missingSamples.map((m) => m.file)).toEqual(['Snare 7.wav']);
    expect(out!.headline).toBe('Imported 3 channels, 1 pattern and the arrangement “Arrangement” (1 clip).');
    expect(out!.details.join('\n')).toMatch(/Serum/);
    expect(out!.details.join('\n')).toMatch(/not in the zip \(Snare 7\.wav\)/);
  });

  it('finds missing samples later from audio files or a zip, by file name, in one undo step', async () => {
    const s = createTestServices();
    const store = createMemoryBlobStore();
    await importFlpFile(s, fileOf('Night Drive.flp', flpProject(SPEC)), { store });
    expect((await missingSamples(s, store)).map((r) => r.name).sort()).toEqual(['Kick 01', 'Snare 7']);
    const res = await relinkMissingSamples(
      s,
      [fileOf('kick 01.WAV', wav(0.2)), fileOf('more.zip', zipSync({ 'x/Snare 7.wav': wav(0.3) }))],
      { store },
    );
    expect(res.found.sort()).toEqual(['Kick 01', 'Snare 7']);
    expect(res.stillMissing).toEqual([]);
    expect(await missingSamples(s, store)).toEqual([]);
    const p = s.doc.getState().project;
    expect(projectViolations(p)).toEqual([]);
    const kick = Object.values(p.channels).find((c) => c.name === 'Kick') as InstrumentChannel;
    expect(p.samples[kick.plugin.samples!.main!]!.name).toBe('Kick 01');
    s.history.undo();
    expect((await missingSamples(s, store)).length).toBe(2);
  });

  it('keeps the open project when the file is not an FL project', async () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    await expect(importFlpFile(s, fileOf('notes.flp', new Uint8Array([1, 2, 3])))).rejects.toThrow(FlpError);
    await expect(importFlpFile(s, fileOf('a.zip', zipSync({ 'a.txt': new Uint8Array(1) })))).rejects.toThrow(
      'no FL Studio project',
    );
    expect(s.doc.getState().project).toBe(before);
  });
});
