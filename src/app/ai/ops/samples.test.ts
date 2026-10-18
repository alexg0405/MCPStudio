import { describe, expect, it } from 'vitest';
import type { AudioClip, AudioClipChannel, InstrumentChannel } from '@core/model/types';
import { chord, MINOR, PATTERNS, renderTestSong } from '@core/dj/test-songs';
import { PPQ } from '@core/time/ppq';
import { engineCorpus, handmadeCorpus } from '../../../../test/helpers/sample-corpus';
import { sampleWorld, wavFile, SAMPLE_RATE } from '../../../../test/helpers/sample-world';
import { afterStepFor } from '../../assistant/after-steps';
import { DRUM_PADS_ID } from '../../samples/actions';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';
import { STUDIO_PROMPT } from '../prompt';

const sounds = [...engineCorpus().filter((s) => s.clear), ...handmadeCorpus(2)];
const pick = (label: string, n = 0) => sounds.filter((s) => s.label === label)[n]!;

async function library() {
  const loop = renderTestSong({ sampleRate: SAMPLE_RATE, bpm: 128, pattern: PATTERNS.house, parts: [{ bars: 2, kick: true, snare: true, hats: true }], tail: 0, chords: [chord(57, MINOR)] });
  return sampleWorld([
    wavFile(pick('kick').x, 'Kicks/Kick A.wav'),
    wavFile(pick('kick', 1).x, 'Kicks/Kick B.wav'),
    wavFile(pick('snare').x, 'Snares/Snare A.wav'),
    wavFile(pick('clap').x, 'Snares/Clap A.wav'),
    wavFile(pick('hat').x, 'Hats/Hat A.wav'),
    wavFile(pick('808').x, '808s/808 A.wav'),
    wavFile(pick('tonal').x, 'Keys/Note A.wav'),
    wavFile(loop.mono, 'Loops/Drum Loop 128.wav'),
  ]);
}

type W = Awaited<ReturnType<typeof library>>;
const run = (w: W, actions: AiAction[]) => applyAnswer(w.s, { message: 'ok', actions }, { previousBeat: null });

/** Runs the answer's sample step the way the assistant does (after the edit, folded into the answer's undo entry). */
async function runStep(w: W, res: ReturnType<typeof run>) {
  const item = res.after.find((x) => x.kind === 'samples')!;
  const step = afterStepFor('samples')!;
  const entry = w.s.history.status().cursor;
  return step(item, { s: w.s, entry, signal: new AbortController().signal, progress: () => {}, whenQuiet: () => Promise.resolve() });
}

describe('place_sample', () => {
  it('checks the sound and the target when the answer is read, and puts a sound as a sampler channel after it', async () => {
    const w = await library();
    const before = w.s.doc.getState().project.channelOrder.length;
    const cursor = w.s.history.status().cursor;
    const res = run(w, [{ op: 'place_sample', sample: 'Kick A' }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Adds “Kick A” as a sampler channel']);
    const item = res.after.find((x) => x.kind === 'samples');
    expect(item).toMatchObject({ kind: 'samples', work: [{ kind: 'place', to: 'channel' }] });
    // Nothing is in the project until the step has read the file.
    expect(w.s.doc.getState().project.channelOrder).toHaveLength(before);
    const out = await runStep(w, res);
    expect(out!.changes).toEqual(['Added “Kick A” as a sampler channel']);
    expect(w.s.doc.getState().project.channelOrder).toHaveLength(before + 1);
    // The edit joins the answer's undo entry when there is one; with none, it is one entry of its own.
    expect(w.s.history.status().cursor).toBe(cursor + 1);
    w.s.history.undo();
    expect(w.s.doc.getState().project.channelOrder).toHaveLength(before);
  });

  it('puts a loop on the playlist by default, following the song tempo, at the bar and track asked for', async () => {
    const w = await library();
    const res = run(w, [{ op: 'place_sample', sample: 'Loops/Drum Loop 128.wav', track: 3, bar: 5 }]);
    expect(res.changes).toEqual(['Puts “Drum Loop 128” on the playlist at bar 5 on track 3']);
    await runStep(w, res);
    const p = w.s.doc.getState().project;
    const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'audio') as AudioClip;
    expect(clip.start).toBe(4 * 4 * PPQ);
    expect(clip.laneId).toBe(p.playlist.laneOrder[2]);
    expect(clip.length).toBe(2 * 4 * PPQ);
    expect((p.channels[clip.channelId] as AudioClipChannel).stretch).toBe('stretch');
    expect((p.channels[clip.channelId] as AudioClipChannel).sourceBpm).toBeCloseTo(128, 0);
  });

  it('loads a sound on a pad of a Drum Pads channel, also one made earlier in the same answer', async () => {
    const w = await library();
    const res = run(w, [
      { op: 'add_channel', plugin: DRUM_PADS_ID, name: 'Kit', ref: '@kit' },
      { op: 'place_sample', sample: 'Snare A', to: 'pad', channel: '@kit', pad: 3 },
    ]);
    expect(res.warnings).toEqual([]);
    await runStep(w, res);
    const p = w.s.doc.getState().project;
    const kit = Object.values(p.channels).find((c) => c.kind === 'instrument' && c.plugin.pluginId === DRUM_PADS_ID) as InstrumentChannel;
    expect(p.samples[kit.plugin.samples!.pad3!]!.name).toBe('Snare A');
  });

  it('says what is wrong: an unknown sound, a bad target, a channel that is not Drum Pads, a pad out of range', async () => {
    const w = await library();
    const res = run(w, [
      { op: 'place_sample', sample: 'Nothing like it' },
      { op: 'place_sample', sample: 'Kick A', to: 'moon' },
      { op: 'place_sample', sample: 'Kick A', to: 'pad', channel: w.s.doc.getState().project.channelOrder[0], pad: 1 },
      { op: 'place_sample', sample: 'Kick A', to: 'clip', bar: 0 },
      { op: 'place_sample' },
    ]);
    expect(res.changes).toEqual([]);
    expect(res.warnings.map((x) => x.slice(0, 60))).toEqual([
      'place sample: there is no sample "Nothing like it" in the sa',
      'place sample: to must be channel, clip or pad (not "moon")',
      expect.stringContaining('is not a Drum Pads channel'),
      'place sample: bar is 1-based',
      'place sample: which sample? (an id, path or file name from l',
    ]);
    expect(res.after.find((x) => x.kind === 'samples')).toBeUndefined();
  });
});

describe('make_kit', () => {
  it('makes a Drum Pads kit from named sounds, laid out like the default kit', async () => {
    const w = await library();
    const res = run(w, [{ op: 'make_kit', samples: ['Hat A', 'Kick A', 'Snare A', 'Clap A'], name: 'Studio kit' }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Makes a Drum Pads kit from 4 of 4 one-shots']);
    const out = await runStep(w, res);
    const line = out!.changes?.[0] ?? '';
    for (const pad of ['pad 1 Kick A', 'pad 3 Snare A', 'pad 4 Clap A', 'pad 7 Hat A']) expect(line).toContain(pad);
    const p = w.s.doc.getState().project;
    const kit = Object.values(p.channels).find((c) => c.name === 'Studio kit') as InstrumentChannel;
    expect(kit.plugin.pluginId).toBe(DRUM_PADS_ID);
    expect(Object.keys(kit.plugin.samples ?? {}).sort()).toEqual(['pad1', 'pad3', 'pad4', 'pad7']);
  });

  it('takes a folder or search words instead of names, leaves loops out and says so', async () => {
    const w = await library();
    const res = run(w, [{ op: 'make_kit', folder: 'Pack/Kicks' }]);
    expect(res.changes).toEqual(['Makes a Drum Pads kit from 2 of 2 one-shots']);
    const all = run(w, [{ op: 'make_kit', text: 'a' }]);
    expect(all.warnings).toEqual([]);
    const loops = run(w, [{ op: 'make_kit', samples: ['Kick A', 'Drum Loop 128'] }]);
    expect(loops.changes[0]).toContain('1 loops or long files left out');
  });

  it('says what is wrong: nothing named, nothing found, only loops', async () => {
    const w = await library();
    const res = run(w, [
      { op: 'make_kit' },
      { op: 'make_kit', folder: 'Pack/Nowhere' },
      { op: 'make_kit', samples: ['Drum Loop 128'] },
    ]);
    expect(res.changes).toEqual([]);
    expect(res.warnings).toEqual([
      'make kit: name the sounds (samples), or a folder and/or search words',
      expect.stringContaining('no one-shots match that folder'),
      'make kit: a kit needs one-shots (those are loops or long files)',
    ]);
  });
});

describe('list_samples (the read tool)', () => {
  it('lists the sounds with what the analysis found, filters like the window, and says the song tempo and key', async () => {
    const w = await library();
    w.s.history.transact('song', (d) => void ((d.transport.bpm = 128), (d.transport.key = { root: 9, scale: 'minor' })));
    const all = runReadTool(w.s, 'list_samples', {}) as { files: number; analyzed: number; samples: Record<string, unknown>[]; by_type: Record<string, number>; loops: number; song: unknown; folders: unknown[] };
    expect(all.files).toBe(8);
    expect(all.analyzed).toBe(8);
    expect(all.loops).toBe(1);
    expect(all.by_type.kick).toBe(2);
    expect(all.song).toEqual({ bpm: 128, key: 'A minor' });
    expect(all.folders).toEqual([{ name: 'Pack', files: 8 }]);
    const kick = all.samples.find((x) => String(x.path).endsWith('Kick A.wav'))!;
    expect(kick).toMatchObject({ type: 'kick', path: 'Pack/Kicks/Kick A.wav' });
    expect(kick.id).toMatch(/^dir_test:Kicks\/Kick A\.wav$/);
    expect(typeof kick.length_s).toBe('number');
    const loop = all.samples.find((x) => x.type === 'loop')!;
    expect(loop.bpm).toBeCloseTo(128, 0);
    expect(loop.bars).toBe(2);
  });

  it('filters by type, kind, tempo, key, folder, text and tag, sorts, limits, and finds similar sounds', async () => {
    const w = await library();
    const list = (a: Record<string, unknown>) => (runReadTool(w.s, 'list_samples', a) as { samples: { path: string; type: string }[]; matching: number; warnings?: string[]; error?: string }).samples.map((x) => x.path.replace('Pack/', ''));
    expect(list({ category: 'kick' })).toEqual(['Kicks/Kick A.wav', 'Kicks/Kick B.wav']);
    expect(list({ kind: 'loop' })).toEqual(['Loops/Drum Loop 128.wav']);
    expect(list({ bpm_min: 120, bpm_max: 130 })).toEqual(['Loops/Drum Loop 128.wav']);
    expect(list({ bpm_min: 60, bpm_max: 70, half_double: true })).toEqual(['Loops/Drum Loop 128.wav']);
    expect(list({ folder: 'Pack/Snares' })).toEqual(['Snares/Clap A.wav', 'Snares/Snare A.wav']);
    expect(list({ text: 'hat' })).toEqual(['Hats/Hat A.wav']);
    expect(list({ text: 'kick -deep', category: 'kick' }).length).toBe(2);
    expect(list({ limit: 3 })).toHaveLength(3);
    expect(list({ sort: 'length', descending: true })[0]).toBe('Loops/Drum Loop 128.wav');
    w.s.sampleBrowser.toggleFavorite(w.row('Hat A').id);
    w.s.sampleBrowser.addTag(w.row('Snare A').id, 'Tight');
    expect(list({ favorites: true })).toEqual(['Hats/Hat A.wav']);
    expect(list({ tag: 'tight' })).toEqual(['Snares/Snare A.wav']);
    const similar = list({ similar_to: 'Kick A', limit: 2 });
    expect(similar[0]).toBe('Kicks/Kick B.wav');
    const note = w.row('Note A').analysis!;
    const keyName = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][note.root!]!;
    expect(list({ key: keyName.replace('♯', '#').replace('♭', 'b') })).toContain('Keys/Note A.wav');
  });

  it('reports bad arguments in warnings and an unknown similar_to as an error, and says so when there are no folders', async () => {
    const w = await library();
    const bad = runReadTool(w.s, 'list_samples', { category: 'banjo', key: 'H flat', sort: 'sideways' }) as { warnings: string[]; matching: number };
    expect(bad.warnings).toHaveLength(3);
    expect(bad.matching).toBe(8);
    expect(runReadTool(w.s, 'list_samples', { similar_to: 'nothing' })).toEqual({ error: expect.stringContaining('there is no sample "nothing"') });
    const empty = await sampleWorld([]);
    expect(runReadTool(empty.s, 'list_samples', {})).toMatchObject({ samples: [], note: expect.stringContaining('Sample browser') });
  });

  it('is in the Studio guide', () => {
    expect(STUDIO_PROMPT).toContain('list_samples');
    expect(STUDIO_PROMPT).toContain('make_kit');
  });
});
