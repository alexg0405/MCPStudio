/**
 * Audio export through the real pipeline (services, offline renders, encoder Worker): stems that add
 * up to the mix, normalize, a .zip of stems, and MP3 (M15).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { strFromU8, unzipSync } from 'fflate';
import { createServices, type Services } from '@app/services';
import { runExport, type AudioExportSettings } from '@app/export/audio-export';
import { trimExport } from '@app/export/export-wav';
import { decodePcm } from '@core/io/wav';
import { MASTER, type ClipId, type LaneId, type Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { withoutMasterChain } from '@core/query/stems';
import { measureTail, renderOffline } from '@engine/render-offline';
import delay from '../../src/plugins/builtin/delay';
import eq from '../../src/plugins/builtin/eq';
import { kitProject, withInsert } from '../helpers/fixtures';

const SR = 48000;
const BAR = 3840;

/** Kick on Insert 1 (EQ), snare on Insert 2 sending to Insert 3 (a delay bus), hat straight to the master. */
function song(): Project {
  const kit = kitProject(
    [
      { generator: 'kit/kick', steps: [0, 8] },
      { generator: 'kit/snare', steps: [4, 12] },
      { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
    ],
    120,
  );
  const [kick, snare] = kit.channels;
  let p = withInsert(kit.project, [kick!], { index: 1, fx: [{ def: eq }] }).project;
  p = withInsert(p, [snare!], { index: 2 }).project;
  p = withInsert(p, [], { index: 3, fx: [{ def: delay }] }).project;
  return produce(p, (d) => {
    const [, , ins2, ins3] = d.mixer.order;
    d.mixer.inserts[ins2!]!.routes.push({ to: ins3!, level: 0.6, pre: false });
    d.mixer.inserts[MASTER]!.volume = 0.5; // the master chain halves everything
    addClips(d, [
      {
        kind: 'pattern',
        id: 'c1' as ClipId,
        laneId: d.playlist.laneOrder[0] as LaneId,
        start: 0,
        length: 2 * BAR,
        patternId: kit.patternId,
        offset: 0,
      },
    ]);
  });
}

const settings = (patch: Partial<AudioExportSettings>): AudioExportSettings => ({
  range: 'song',
  codec: 'wav',
  wavBits: 32,
  flacBits: 24,
  mp3Kbps: 320,
  sampleRate: SR,
  normalize: false,
  stems: false,
  masterChain: true,
  stemsTo: 'folder',
  ...patch,
});

const decodeWav = (bytes: Uint8Array) => {
  const pcm = decodePcm(bytes);
  if (!pcm) throw new Error('not a WAV');
  return pcm.channels;
};

describe('audio export', () => {
  const services: Services[] = [];
  const make = (project: Project) => {
    const s = createServices({ project });
    services.push(s);
    s.view.getState().setMode('song');
    return s;
  };
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('writes stems of equal length that add up to the mix (master chain off)', async () => {
    const project = song();
    const s = make(project);
    const files = new Map<string, Uint8Array>();
    const result = await runExport(s, settings({ stems: true, masterChain: false }), { kind: 'memory', files, name: 'stems' });
    expect(result.names).toEqual([
      'Untitled - 00 Master.wav',
      'Untitled - 01 Insert 1.wav',
      'Untitled - 02 Insert 2.wav',
    ]);
    const stems = result.names.map((n) => decodeWav(files.get(n)!));
    const length = stems[0]![0]!.length;
    expect(stems.every((st) => st.every((c) => c.length === length))).toBe(true);
    // The reference: the whole mix without the master chain, rendered the same way.
    const raw = withoutMasterChain(project);
    const opts = { plugins: s.plugins };
    const tail = await measureTail(raw, opts, SR);
    const r = await renderOffline(raw, {
      ...opts,
      view: { mode: 'song', patternId: null, loop: null },
      bars: 2,
      sampleRate: SR,
      tail,
      limiter: false,
    });
    const mix = trimExport(r, 4);
    expect(mix[0]!.length).toBe(length);
    let err = 0;
    let peak = 0;
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < length; i++) {
        const sum = stems.reduce((acc, st) => acc + (st[c]![i] as number), 0);
        err = Math.max(err, Math.abs(sum - (mix[c]![i] as number)));
        peak = Math.max(peak, Math.abs(mix[c]![i] as number));
      }
    expect(peak).toBeGreaterThan(0.1);
    expect(err).toBeLessThan(1e-4);
  });

  it('zips stems through the master chain, and normalizes a mix to −0.3 dBFS', async () => {
    const s = make(song());
    const files = new Map<string, Uint8Array>();
    await runExport(s, settings({ stems: true, stemsTo: 'zip', codec: 'flac' }), { kind: 'memory', files, name: 'song.zip' });
    const zip = unzipSync(files.get('song.zip')!);
    expect(Object.keys(zip).sort()).toEqual([
      'Untitled - 00 Master.flac',
      'Untitled - 01 Insert 1.flac',
      'Untitled - 02 Insert 2.flac',
    ]);
    expect(strFromU8(zip['Untitled - 00 Master.flac']!.subarray(0, 4))).toBe('fLaC');

    const out = new Map<string, Uint8Array>();
    await runExport(s, settings({ normalize: true }), { kind: 'memory', files: out, name: 'mix.wav' });
    const mix = decodeWav(out.get('mix.wav')!);
    let peak = 0;
    for (const c of mix) for (const v of c) peak = Math.max(peak, Math.abs(v));
    expect(20 * Math.log10(peak)).toBeCloseTo(-0.3, 2);
  });

  it('exports just a part of the song (a section, a clip’s bars) as an MP3', async () => {
    const s = make(song());
    const whole = new Map<string, Uint8Array>();
    const part = new Map<string, Uint8Array>();
    const all = await runExport(s, settings({ codec: 'mp3', sampleRate: 44100 }), { kind: 'memory', files: whole, name: 'all.mp3' });
    const res = await runExport(s, settings({ codec: 'mp3', sampleRate: 44100, range: { from: BAR, to: 2 * BAR } }), {
      kind: 'memory',
      files: part,
      name: 'bar2.mp3',
    });
    // Bar 2 of a 2-bar song at 120 BPM: two seconds shorter, and it still sounds.
    expect(all.seconds - res.seconds).toBeCloseTo(2, 1);
    const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(part.get('bar2.mp3')!.slice().buffer as ArrayBuffer);
    expect(Math.abs(decoded.duration - res.seconds)).toBeLessThan(0.1);
    let sum = 0;
    for (const v of decoded.getChannelData(0)) sum += v * v;
    expect(Math.sqrt(sum / decoded.length)).toBeGreaterThan(0.01);
  });

  it('exports MP3 that decodes back to the song (duration, not silent)', async () => {
    const s = make(song());
    const files = new Map<string, Uint8Array>();
    const wav = new Map<string, Uint8Array>();
    await runExport(s, settings({ codec: 'mp3', mp3Kbps: 192, sampleRate: 44100 }), { kind: 'memory', files, name: 'song.mp3' });
    const res = await runExport(s, settings({ sampleRate: 44100 }), { kind: 'memory', files: wav, name: 'song.wav' });
    const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(files.get('song.mp3')!.slice().buffer as ArrayBuffer);
    expect(Math.abs(decoded.duration - res.seconds)).toBeLessThan(0.1);
    let sum = 0;
    const left = decoded.getChannelData(0);
    for (const v of left) sum += v * v;
    expect(Math.sqrt(sum / left.length)).toBeGreaterThan(0.01);
    // 192 kbps: about 24 kB per second.
    expect(files.get('song.mp3')!.length / res.seconds).toBeGreaterThan(20000);
    expect(files.get('song.mp3')!.length / res.seconds).toBeLessThan(28000);
  });
});
