import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { sha256Hex } from '@core/io/hash';
import { ProjectFileError, readProjectFile, writeProjectFile } from '@core/io/project-file';
import { decodePcm, encodeWav } from '@core/io/wav';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import { KIT_VERSION } from '@core/model/kit';
import type { Project, SampleRef } from '@core/model/types';
import { StorageError, type BlobStore } from '@platform/opfs';
import { createMemoryBlobStore, createSampleStore } from './blob-store';
import {
  buildProjectFile,
  collectEmbeddedSamples,
  decodableBytes,
  openProjectFile,
  opfsSampleProvider,
} from './project-io';
import { importSampleBytes, sniffAudioExt } from './sample-import';

const NOW = new Date('2026-10-12T09:00:00.000Z');
const tone = (n: number, f = 0.05) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i * f));
const wavBytes = (n = 500) => encodeWav([tone(n)], 44100, { bitDepth: 16 });

/** A minimal big-endian 16-bit mono AIFF. */
function aiffBytes(samples: number[], rate = 44100): Uint8Array {
  const ssnd = 8 + samples.length * 2;
  const out = new Uint8Array(12 + 8 + 18 + 8 + ssnd);
  const v = new DataView(out.buffer);
  const tag = (o: number, t: string) => [...t].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  tag(0, 'FORM');
  v.setUint32(4, out.length - 8);
  tag(8, 'AIFF');
  tag(12, 'COMM');
  v.setUint32(16, 18);
  v.setUint16(20, 1);
  v.setUint32(22, samples.length);
  v.setUint16(26, 16);
  const exp = Math.floor(Math.log2(rate));
  v.setUint16(28, exp + 16383);
  v.setUint32(30, Math.floor((rate / 2 ** exp) * 2 ** 31) >>> 0);
  tag(38, 'SSND');
  v.setUint32(42, ssnd);
  samples.forEach((s, i) => v.setInt16(54 + i * 2, Math.round(s * 32768)));
  return out;
}

function withSamples(...refs: SampleRef[]): Project {
  const p = createEmptyProject({ now: NOW });
  for (const r of refs) p.samples[r.id] = r;
  return p;
}

const builtin = (id: string): SampleRef => ({
  id: id as SampleRef['id'],
  name: 'Kick',
  source: { kind: 'builtin', generator: 'kit/kick', version: KIT_VERSION },
});

beforeEach(() => {
  setIdSource(seededBytes(11));
});

describe('importSampleBytes', () => {
  it('stores the bytes once by content hash and returns a new embedded SampleRef', async () => {
    const store = createMemoryBlobStore();
    const put = vi.spyOn(store, 'putBlob');
    const bytes = wavBytes();
    const a = await importSampleBytes(bytes, 'Drums/Kick 01.WAV', { store });
    expect(a).toEqual({
      id: expect.stringMatching(/^smp_[A-Za-z0-9_-]{10}$/),
      name: 'Kick 01',
      source: { kind: 'embedded', hash: await sha256Hex(bytes), ext: 'wav', originalName: 'Kick 01.WAV' },
    });
    expect((await store.getBlob(await sha256Hex(bytes)))?.bytes).toEqual(bytes);
    const b = await importSampleBytes(bytes, 'copy of kick.wav', { store });
    expect(b.id).not.toBe(a.id);
    expect(b.source).toMatchObject({ hash: (a.source as { hash: string }).hash, originalName: 'copy of kick.wav' });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('names and types files without a usable extension', async () => {
    const store = createMemoryBlobStore();
    expect((await importSampleBytes(wavBytes(), 'recording', { store })).source).toMatchObject({ ext: 'wav' });
    expect((await importSampleBytes(aiffBytes([0.1]), 'C:\\samples\\pad', { store })).name).toBe('pad');
    const odd = await importSampleBytes(Uint8Array.from([1, 2, 3, 4]), 'my.sample.w@v', { store });
    expect(odd).toMatchObject({ name: 'my.sample', source: { ext: 'bin' } });
    expect((await importSampleBytes(Uint8Array.from([1]), '.wav', { store })).name).toBe('.wav');
    expect((await importSampleBytes(Uint8Array.from([2]), '   .x', { store })).name).toBe('Sample');
  });

  it('sniffs common audio formats', () => {
    const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    expect(sniffAudioExt(wavBytes())).toBe('wav');
    expect(sniffAudioExt(aiffBytes([0]))).toBe('aiff');
    expect(sniffAudioExt(ascii('FORM\0\0\0\0AIFC'))).toBe('aifc');
    expect(sniffAudioExt(ascii('fLaC\0\0\0\0'))).toBe('flac');
    expect(sniffAudioExt(ascii('OggS\0\0\0\0'))).toBe('ogg');
    expect(sniffAudioExt(ascii('\0\0\0 ftypM4A '))).toBe('m4a');
    expect(sniffAudioExt(ascii('ID3\x04\0\0'))).toBe('mp3');
    expect(sniffAudioExt(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    expect(sniffAudioExt(ascii('hello world'))).toBeNull();
    expect(sniffAudioExt(new Uint8Array(2))).toBeNull();
  });
});

describe('buildProjectFile', () => {
  it('embeds each embedded sample once and skips built-ins', async () => {
    const store = createMemoryBlobStore();
    const a = await importSampleBytes(wavBytes(300), 'a.wav', { store });
    const again = await importSampleBytes(wavBytes(300), 'same bytes.wav', { store });
    const b = await importSampleBytes(aiffBytes([0.25, -0.25]), 'b.aif', { store });
    const project = withSamples(a, again, b, builtin('smp_builtin001'));
    const onMissingSamples = vi.fn();
    const file = await buildProjectFile(project, { mode: 'song' }, '0.1.0', { store, now: NOW, onMissingSamples });
    expect(onMissingSamples).not.toHaveBeenCalled();
    const names = Object.keys(unzipSync(file)).sort();
    const hashA = (a.source as { hash: string }).hash;
    const hashB = (b.source as { hash: string }).hash;
    expect(names).toEqual(
      ['meta.json', 'project.json', `samples/${hashA}.wav`, `samples/${hashB}.aif`, 'view.json'].sort(),
    );
    const read = readProjectFile(file);
    expect(read.project).toEqual(project);
    expect(read.view).toEqual({ mode: 'song' });
    expect(read.samples.get(hashA)?.bytes).toEqual(wavBytes(300));
  });

  it('still writes the file when samples are missing, and reports them', async () => {
    const store = createMemoryBlobStore();
    const ok = await importSampleBytes(wavBytes(), 'ok.wav', { store });
    const ghost: SampleRef = {
      id: 'smp_ghost00001' as SampleRef['id'],
      name: 'Ghost',
      source: { kind: 'embedded', hash: 'f'.repeat(64), ext: 'wav' },
    };
    const ghost2 = { ...ghost, id: 'smp_ghost00002' as SampleRef['id'], name: 'Ghost 2' };
    const project = withSamples(ok, ghost, ghost2);
    expect((await collectEmbeddedSamples(project, store)).missing.map((r) => r.name)).toEqual(['Ghost', 'Ghost 2']);
    const onMissingSamples = vi.fn();
    const file = await buildProjectFile(project, null, '1', { store, onMissingSamples });
    expect(onMissingSamples).toHaveBeenCalledWith([ghost, ghost2]);
    expect(readProjectFile(file).samples.size).toBe(1);
  });
});

describe('openProjectFile', () => {
  async function savedProject() {
    const source = createMemoryBlobStore();
    const ref = await importSampleBytes(wavBytes(800), 'loop.wav', { store: source });
    const project = withSamples(ref, builtin('smp_builtin001'));
    const file = await buildProjectFile(project, { mode: 'pattern' }, '0.1.0', { store: source, now: NOW });
    return { project, ref, file, hash: (ref.source as { hash: string }).hash };
  }

  it('stores the samples it contains before returning', async () => {
    const { project, file, hash } = await savedProject();
    const store = createMemoryBlobStore();
    const opened = await openProjectFile(file, { store });
    expect(opened).toEqual({ project, view: { mode: 'pattern' }, repairs: [], migratedFrom: 1, missingSamples: [] });
    expect((await store.getBlob(hash))?.bytes).toEqual(wavBytes(800));
  });

  it("doesn't rewrite samples the store already has", async () => {
    const { file, hash } = await savedProject();
    const store = createMemoryBlobStore();
    await store.putBlob(hash, 'wav', wavBytes(800));
    const put = vi.spyOn(store, 'putBlob');
    await openProjectFile(file, { store });
    expect(put).not.toHaveBeenCalled();
  });

  it('skips sample files that fail their hash check and reports missing samples', async () => {
    const { file, hash } = await savedProject();
    const entries = unzipSync(file);
    entries[`samples/${hash}.wav`]![100]! ^= 0xff; // bit rot
    const store = createMemoryBlobStore();
    const opened = await openProjectFile(zipSync(entries), { store });
    expect(await store.hasBlob(hash)).toBe(false);
    expect(opened.missingSamples.map((r) => r.name)).toEqual(['loop']);
    expect(opened.repairs).toEqual([
      'Skipped 1 damaged sample file in this project file.',
      '1 sample is missing and will be silent: "loop".',
    ]);
  });

  it('passes project-file errors through', async () => {
    await expect(openProjectFile(strToU8('nope'), { store: createMemoryBlobStore() })).rejects.toBeInstanceOf(
      ProjectFileError,
    );
  });

  it('opens thin files (autosaves) whose samples are already stored', async () => {
    const store = createMemoryBlobStore();
    const ref = await importSampleBytes(wavBytes(), 'x.wav', { store });
    const thin = writeProjectFile({ project: withSamples(ref), view: null, samples: new Map(), appVersion: '1' });
    expect((await openProjectFile(thin, { store })).missingSamples).toEqual([]);
    expect((await openProjectFile(thin, { store: createMemoryBlobStore() })).missingSamples).toEqual([ref]);
  });
});

describe('opfsSampleProvider', () => {
  it('serves embedded sample bytes and nothing for built-ins or missing blobs', async () => {
    const store = createMemoryBlobStore();
    const ref = await importSampleBytes(wavBytes(), 'x.wav', { store });
    const provider = opfsSampleProvider({ store });
    const buf = await provider.getBytes(ref);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buf!)).toEqual(wavBytes());
    expect(await provider.getBytes(builtin('smp_b'))).toBeNull();
    const missing = { ...ref, source: { ...ref.source, hash: 'e'.repeat(64) } } as SampleRef;
    expect(await provider.getBytes(missing)).toBeNull();
  });

  it('transcodes AIFF to WAV so decodeAudioData can read it', async () => {
    const store = createMemoryBlobStore();
    const aiff = aiffBytes([0.5, -0.25, 0.125, 0], 48000);
    const ref = await importSampleBytes(aiff, 'pad.aiff', { store });
    const wav = new Uint8Array((await opfsSampleProvider({ store }).getBytes(ref))!);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(decodePcm(wav)).toEqual(decodePcm(aiff));
    expect(decodePcm(wav)?.sampleRate).toBe(48000);
    const raw = new Uint8Array((await opfsSampleProvider({ store, transcode: false }).getBytes(ref))!);
    expect(raw).toEqual(aiff);
    expect(decodableBytes(wavBytes())).toEqual(wavBytes());
    const broken = Uint8Array.from([...strToU8('FORM'), 0, 0, 0, 4, ...strToU8('AIFF')]);
    expect(decodableBytes(broken)).toBe(broken);
  });
});

describe('sample stores', () => {
  const hash = 'a'.repeat(64);

  it('memory store copies bytes in and out and validates input', async () => {
    const store = createMemoryBlobStore();
    const bytes = Uint8Array.from([1, 2, 3]);
    await store.putBlob(hash, '.WAV', bytes);
    bytes[0] = 9;
    const got = await store.getBlob(hash);
    expect(got).toEqual({ ext: 'wav', bytes: Uint8Array.from([1, 2, 3]) });
    got!.bytes[1] = 9;
    expect((await store.getBlob(hash))?.bytes).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await store.listBlobs()).toEqual([{ hash, ext: 'wav' }]);
    await store.deleteBlob(hash);
    expect(await store.hasBlob(hash)).toBe(false);
    await expect(store.putBlob('x', 'wav', bytes)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.putBlob(hash, '', bytes)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('falls back to memory when the primary store fails, and says so', async () => {
    const primary = createMemoryBlobStore();
    const full = new StorageError('quota', 'Browser storage is full');
    vi.spyOn(primary, 'putBlob').mockRejectedValue(full);
    const store = createSampleStore(primary);
    const onFallback = vi.fn();
    const off = store.onFallback(onFallback);
    await store.putBlob(hash, 'wav', Uint8Array.from([1]));
    expect(onFallback).toHaveBeenCalledWith(full, hash);
    expect(store.memoryOnly).toBe(false);
    expect(await store.getBlob(hash)).toEqual({ ext: 'wav', bytes: Uint8Array.from([1]) });
    expect(await store.hasBlob(hash)).toBe(true);
    expect(await store.listBlobs()).toEqual([{ hash, ext: 'wav' }]);
    off();
    await store.putBlob('b'.repeat(64), 'wav', Uint8Array.from([2]));
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('reads through to the primary store and merges listings', async () => {
    const primary: BlobStore = createMemoryBlobStore();
    await primary.putBlob(hash, 'flac', Uint8Array.from([7]));
    const store = createSampleStore(primary);
    await store.putBlob('b'.repeat(64), 'wav', Uint8Array.from([8]));
    expect(await store.getBlob(hash)).toEqual({ ext: 'flac', bytes: Uint8Array.from([7]) });
    expect((await store.listBlobs()).map((b) => b.ext)).toEqual(['flac', 'wav']);
    await store.deleteBlob(hash);
    expect(await primary.hasBlob(hash)).toBe(false);
  });

  it('works without a primary store and still rejects invalid input', async () => {
    const store = createSampleStore(null);
    expect(store.memoryOnly).toBe(true);
    await store.putBlob(hash, 'wav', Uint8Array.from([1]));
    expect(await store.hasBlob(hash)).toBe(true);
    const primary = createMemoryBlobStore();
    const layered = createSampleStore(primary);
    await expect(layered.putBlob('nope', 'wav', Uint8Array.from([1]))).rejects.toMatchObject({ code: 'invalid' });
  });
});
