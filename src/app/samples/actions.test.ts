import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { encodeWav } from '@core/io/wav';
import type { AudioClip, AudioClipChannel, InstrumentChannel } from '@core/model/types';
import { chord, MINOR, PATTERNS, renderTestSong } from '@core/dj/test-songs';
import { PPQ } from '@core/time/ppq';
import { engineCorpus, handmadeCorpus } from '../../../test/helpers/sample-corpus';
import { createTestServices } from '../testing';
import { DRUM_PADS_ID, addRowAsClip, addRowsAsChannels, loadRowOnPad, makeKitFromRows, previewRow, stopPreviewRow } from './actions';
import type { FolderLike } from './browser';
import { inlineRunner } from './runner';
import { memoryBrowserStorage } from './storage';

const SR = 44100;
const sounds = [...engineCorpus().filter((s) => s.clear), ...handmadeCorpus(2)];
const pick = (label: string, n = 0) => sounds.filter((s) => s.label === label)[n]!;

const wav = (x: Float32Array, path: string, lastModified = 1_700_000_000_000) => ({
  path,
  file: new File([encodeWav([x], SR, { bitDepth: 16 }).slice().buffer], path.split('/').pop() as string, { lastModified }),
});

async function world(files: { path: string; file: File }[]) {
  const folder: FolderLike = {
    key: 'dir_a',
    name: 'Pack',
    access: 'granted',
    files: files.map((f) => ({ name: f.file.name, path: f.path, handle: { getFile: () => Promise.resolve(f.file) } })),
  };
  const folders = createStore<{ folders: readonly FolderLike[] }>(() => ({ folders: [folder] }));
  const s = createTestServices({ sampleBrowser: { storage: memoryBrowserStorage(), folders, runner: () => inlineRunner(async () => null), flushMs: 5 } });
  s.sampleBrowser.start();
  await s.sampleBrowser.whenIdle();
  const row = (name: string) => s.sampleBrowser.find(name)!;
  return { s, row };
}

describe('sample browser actions', () => {
  it('auditions a one-shot as it is, at the volume set, and stops it on a second click', async () => {
    const { s, row } = await world([wav(pick('kick').x, 'Kicks/Kick A.wav')]);
    s.sampleBrowser.setPrefs({ volume: 0.5 });
    expect(await previewRow(s, row('Kick A'), { toggle: true })).toBe(true);
    expect(s.fakeEngine.previews).toHaveLength(1);
    expect(s.fakeEngine.previews[0]!.opts).toEqual({});
    expect(s.fakeEngine.previewVolume).toBe(0.5);
    expect(s.sampleBrowser.store.getState().playing).toBe(row('Kick A').id);
    await previewRow(s, row('Kick A'), { toggle: true });
    expect(s.sampleBrowser.store.getState().playing).toBeNull();
    expect(s.fakeEngine.previews).toHaveLength(1);
    stopPreviewRow(s);
  });

  it('auditions a loop at the project tempo from the next beat, looping', async () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 100, pattern: PATTERNS.pop, parts: [{ bars: 2, kick: true, snare: true, hats: true }], tail: 0 });
    const { s, row } = await world([wav(song.mono, 'Loops/Drums.wav')]);
    s.history.transact('tempo', (d) => void (d.transport.bpm = 120));
    await previewRow(s, row('Drums'));
    const o = s.fakeEngine.previews[0]!.opts!;
    expect(o.loop).toBe(true);
    expect(o.onBeat).toBe(true);
    expect(o.stretch).toBeCloseTo(100 / 120, 6);
    s.sampleBrowser.setPrefs({ syncMode: 'resample' });
    await previewRow(s, row('Drums'));
    expect(s.fakeEngine.previews[1]!.opts!.rate).toBeCloseTo(1.2, 6);
    expect(s.fakeEngine.previews[1]!.opts!.stretch).toBeUndefined();
    stopPreviewRow(s);
  });

  it('moves a tonal one-shot to the song key when that is on', async () => {
    const note = pick('tonal');
    const { s, row } = await world([wav(note.x, 'Keys/Note.wav')]);
    s.history.transact('key', (d) => void (d.transport.key = { root: 0, scale: 'minor' }));
    await previewRow(s, row('Note'));
    expect(s.fakeEngine.previews[0]!.opts).toEqual({});
    s.sampleBrowser.setPrefs({ inKey: true });
    await previewRow(s, row('Note'));
    const rate = s.fakeEngine.previews[1]!.opts!.rate;
    const root = row('Note').analysis!.root!;
    const shift = ((((0 - root) % 12) + 18) % 12) - 6;
    if (shift === 0) expect(rate).toBeUndefined();
    else expect(rate).toBeCloseTo(Math.pow(2, shift / 12), 6);
    stopPreviewRow(s);
  });

  it('adds sampler channels for rows in one undo step and notes the rows as used', async () => {
    const { s, row } = await world([wav(pick('kick').x, 'Kick A.wav'), wav(pick('snare').x, 'Snare A.wav')]);
    const before = s.doc.getState().project.channelOrder.length;
    const ids = await addRowsAsChannels(s, [row('Kick A'), row('Snare A')]);
    expect(ids).toHaveLength(2);
    const p = s.doc.getState().project;
    expect(p.channelOrder).toHaveLength(before + 2);
    expect(p.channels[ids[0]!]!.name).toBe('Kick A');
    expect(s.sampleBrowser.find('Kick A')!.lastUsed).toBeGreaterThan(0);
    s.history.undo();
    expect(s.doc.getState().project.channelOrder).toHaveLength(before);
  });

  it('adds a loop to the playlist following the song tempo, as long as its bars', async () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 96, pattern: PATTERNS.dembow, parts: [{ bars: 4, kick: true, snare: true, hats: true }], tail: 0, chords: [chord(57, MINOR)] });
    const { s, row } = await world([wav(song.mono, 'Loops/Dembow.wav')]);
    const id = await addRowAsClip(s, row('Dembow'), { startTick: 4 * 4 * PPQ });
    expect(id).not.toBeNull();
    const p = s.doc.getState().project;
    const clip = p.playlist.clips[id!] as AudioClip;
    const ch = p.channels[clip.channelId] as AudioClipChannel;
    expect(ch.stretch).toBe('stretch');
    expect(ch.sourceBpm).toBeCloseTo(96, 0);
    expect(clip.length).toBe(4 * 4 * PPQ);
    expect(clip.start).toBe(4 * 4 * PPQ);
    // A one-shot is as long as it plays and does not follow the tempo.
    const kick = wav(pick('kick').x, 'Kick B.wav');
    const w2 = await world([kick]);
    const id2 = await addRowAsClip(w2.s, w2.row('Kick B'));
    const p2 = w2.s.doc.getState().project;
    expect((p2.channels[(p2.playlist.clips[id2!] as AudioClip).channelId] as AudioClipChannel).stretch).toBeUndefined();
  });

  it('makes a Drum Pads kit from one-shots: kick on pad 1, snare 3, clap 4, hat 7, in one undo step', async () => {
    const { s, row } = await world([
      wav(pick('hat').x, 'Hat 1.wav'),
      wav(pick('kick').x, 'Kick 1.wav'),
      wav(pick('clap').x, 'Clap 1.wav'),
      wav(pick('snare').x, 'Snare 1.wav'),
    ]);
    const before = s.doc.getState().project.channelOrder.length;
    const res = await makeKitFromRows(s, s.sampleBrowser.store.getState().rows, 'My kit');
    expect(res.channelId).not.toBeNull();
    expect(res.placed.map((x) => x.pad)).toEqual([1, 3, 4, 7]);
    const p = s.doc.getState().project;
    const ch = p.channels[res.channelId!] as InstrumentChannel;
    expect(ch.name).toBe('My kit');
    expect(ch.plugin.pluginId).toBe(DRUM_PADS_ID);
    expect(Object.keys(ch.plugin.samples ?? {}).sort()).toEqual(['pad1', 'pad3', 'pad4', 'pad7']);
    expect(p.samples[ch.plugin.samples!.pad1!]!.name).toBe('Kick 1');
    expect(p.samples[ch.plugin.samples!.pad3!]!.name).toBe('Snare 1');
    expect(p.channelOrder).toHaveLength(before + 1);
    s.history.undo();
    expect(s.doc.getState().project.channelOrder).toHaveLength(before);
    expect(row('Kick 1')).toBeDefined();
  });

  it('reports loops left out of a kit, and makes no channel when nothing fits', async () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 128, pattern: PATTERNS.house, parts: [{ bars: 2, kick: true, snare: true, hats: true }], tail: 0 });
    const { s } = await world([wav(song.mono, 'Loops/Loop.wav')]);
    const before = s.doc.getState().project.channelOrder.length;
    const res = await makeKitFromRows(s, s.sampleBrowser.store.getState().rows);
    expect(res.channelId).toBeNull();
    expect(res.plan.skipped).toHaveLength(1);
    expect(s.doc.getState().project.channelOrder).toHaveLength(before);
  });

  it('loads a row on one pad of a Drum Pads channel, and refuses other channels and bad pads', async () => {
    const { s, row } = await world([wav(pick('kick').x, 'Kick 1.wav'), wav(pick('snare').x, 'Snare 1.wav')]);
    const kit = await makeKitFromRows(s, [row('Kick 1')]);
    expect(await loadRowOnPad(s, row('Snare 1'), kit.channelId!, 5)).toBe(true);
    const ch = s.doc.getState().project.channels[kit.channelId!] as InstrumentChannel;
    expect(ch.plugin.samples!.pad5).toBeDefined();
    expect(await loadRowOnPad(s, row('Snare 1'), kit.channelId!, 17)).toBe(false);
    const sampler = s.doc.getState().project.channelOrder[0]!;
    expect(await loadRowOnPad(s, row('Snare 1'), sampler, 1)).toBe(false);
  });
});
