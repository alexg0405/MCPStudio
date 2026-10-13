import { afterEach, describe, expect, it } from 'vitest';
import { encodeWav } from '@core/io/wav';
import { createEmptyProject } from '@core/model/defaults';
import type { Project, SampleRef } from '@core/model/types';
import { heldSessionLocks, holdSessionLock } from '@platform/locks';
import { createOpfsStorage, isOpfsAvailable } from '@platform/opfs';
import { loadAutosave, selectRecoveryCandidates, startAutosave } from './autosave';
import { createSampleStore } from './blob-store';
import { buildProjectFile, openProjectFile, opfsSampleProvider } from './project-io';
import { importSampleBytes } from './sample-import';

const available = isOpfsAvailable();
const suffix = available ? '' : ' (skipped: OPFS is not available in this browser)';
const roots: string[] = [];

async function scratch(name: string) {
  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry(name, { recursive: true }).catch(() => {});
  roots.push(name);
  const dir = await opfs.getDirectoryHandle(name, { create: true });
  return createOpfsStorage({ root: async () => dir });
}

afterEach(async () => {
  const opfs = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) await opfs.removeEntry(name, { recursive: true }).catch(() => {});
});

function aiff16(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(12 + 26 + 16 + samples.length * 2);
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
  v.setUint32(42, 8 + samples.length * 2);
  samples.forEach((s, i) => v.setInt16(54 + i * 2, Math.round(s * 32767)));
  return out;
}

const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));

describe.skipIf(!available)(`project files with OPFS samples${suffix}`, () => {
  it('saves and reopens samples through OPFS, and the engine can decode them', async () => {
    const source = createSampleStore(await scratch('agstudio-test-src'));
    const wav = await importSampleBytes(encodeWav([tone(4800)], 48000, { bitDepth: 24 }), 'Tone.wav', {
      store: source,
    });
    const aif = await importSampleBytes(aiff16(tone(4800), 48000), 'Tone.aif', { store: source });
    const project: Project = createEmptyProject({ title: 'With samples' });
    for (const ref of [wav, aif]) project.samples[ref.id] = ref;
    const file = await buildProjectFile(project, { mode: 'song' }, '0.1.0', { store: source });

    const target = createSampleStore(await scratch('agstudio-test-dst'));
    const opened = await openProjectFile(file, { store: target });
    expect(opened.project).toEqual(project);
    expect(opened.missingSamples).toEqual([]);
    expect(await target.listBlobs()).toHaveLength(2);

    const provider = opfsSampleProvider({ store: target });
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: 44100 });
    for (const ref of [wav, aif] as SampleRef[]) {
      const bytes = await provider.getBytes(ref);
      expect(bytes).not.toBeNull();
      const buffer = await ctx.decodeAudioData(bytes!);
      // decodeAudioData resamples 48 kHz → 44.1 kHz: 0.1 s either way.
      expect(buffer.duration).toBeCloseTo(0.1, 2);
      let peak = 0;
      for (const x of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(x));
      expect(peak).toBeGreaterThan(0.45);
      expect(peak).toBeLessThan(0.55);
    }
  });
});

describe.skipIf(!available)(`autosave and recovery with OPFS${suffix}`, () => {
  it('autosaves, marks clean, and finds crashed sessions', async () => {
    const storage = await scratch('agstudio-test-autosave');
    const samples = createSampleStore(null);
    let project = createEmptyProject({ title: 'Crashy' });
    const listeners = new Set<() => void>();
    const pageHide = new Set<() => void>();
    const session = `crashed${Math.random().toString(36).slice(2, 8)}`;
    const autosave = startAutosave({
      sessionId: session,
      getSnapshot: () => ({ project, view: { mode: 'pattern' } }),
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      appVersion: '0.1.0',
      storage,
      lifecycle: { onHidden: () => () => {}, onPageHide: (fn) => (pageHide.add(fn), () => pageHide.delete(fn)) },
    });
    project = { ...project, transport: { ...project.transport, bpm: 99 } };
    listeners.forEach((fn) => fn());
    await autosave.flush();
    project = { ...project, transport: { ...project.transport, bpm: 101 } };
    listeners.forEach((fn) => fn());
    await autosave.flush();
    autosave.stop();

    const metas = await storage.listAutosaves();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ sessionId: session, title: 'Crashy', clean: false, slot: 'b' });

    // A live tab holds its lock; the crashed session's lock is free.
    const live = `live${Math.random().toString(36).slice(2, 8)}`;
    const release = await holdSessionLock(live);
    try {
      const candidates = selectRecoveryCandidates(
        [...metas, { ...metas[0]!, sessionId: live, projectId: 'other' }],
        await heldSessionLocks(),
        'this-tab',
      );
      expect(candidates.map((m) => m.sessionId)).toEqual([session]);
    } finally {
      release();
    }

    const recovered = await loadAutosave(session, { storage, store: samples });
    expect(recovered?.project.transport.bpm).toBe(101);
    expect(recovered?.view).toEqual({ mode: 'pattern' });

    // A normal shutdown marks the session clean: no longer a candidate.
    const again = startAutosave({
      sessionId: session,
      getSnapshot: () => ({ project, view: null }),
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      appVersion: '0.1.0',
      storage,
      lifecycle: { onHidden: () => () => {}, onPageHide: (fn) => (pageHide.add(fn), () => pageHide.delete(fn)) },
    });
    listeners.forEach((fn) => fn());
    pageHide.forEach((fn) => fn());
    await again.flush();
    for (let i = 0; i < 50 && !(await storage.listAutosaves())[0]?.clean; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((await storage.listAutosaves())[0]).toMatchObject({ sessionId: session, clean: true });
    expect(selectRecoveryCandidates(await storage.listAutosaves(), new Set(), 'this-tab')).toEqual([]);
    again.stop();
  });
});
