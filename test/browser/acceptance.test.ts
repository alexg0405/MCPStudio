/**
 * v2 acceptance: one song using the production features together, built through the AI studio's
 * action language (the same ops the AI and the UI use): Drum Pads, a Wavetable lead, an FM bass, a
 * reverb send, a bass ducked by the drums (sidechain), a Limiter on the master, a filter sweep and a
 * tempo ramp, a marker, presets. Then: save → reopen is identical, the mix analysis hears every
 * track, and it exports as WAV, FLAC, MP3, stems and MIDI.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { applyAnswer } from '@app/ai/apply';
import type { AiAction } from '@app/ai/schema';
import { exportMidi } from '@app/actions/midi';
import { analyzeMix } from '@app/analysis/mix';
import { runExport, type AudioExportSettings } from '@app/export/audio-export';
import { createServices, type Services } from '@app/services';
import { decodeFlac } from '@core/io/flac';
import { parseMidi } from '@core/io/midi';
import { decodePcm } from '@core/io/wav';
import { MASTER } from '@core/model/types';

const settings = (patch: Partial<AudioExportSettings>): AudioExportSettings => ({
  range: 'song',
  codec: 'wav',
  wavBits: 24,
  flacBits: 24,
  mp3Kbps: 192,
  sampleRate: 48000,
  normalize: false,
  stems: false,
  masterChain: true,
  stemsTo: 'zip',
  ...patch,
});

const SONG: AiAction[] = [
  { op: 'song', bpm: 128, key: 'A minor' },
  { op: 'add_channel', ref: '@pads', plugin: 'agstudio.drum-pads', name: 'Pads', preset: 'Trap 808 kit' },
  { op: 'add_channel', ref: '@lead', plugin: 'agstudio.wavetable', name: 'Lead' },
  { op: 'add_channel', ref: '@bass', plugin: 'agstudio.fm', name: 'Bass' },
  { op: 'add_insert', ref: '@drums', name: 'Drums' },
  { op: 'edit_channel', channel: '@pads', insert: '@drums' },
  { op: 'add_insert', ref: '@bassbus', name: 'Bass bus' },
  { op: 'edit_channel', channel: '@bass', insert: '@bassbus', volume_db: -4 },
  { op: 'add_insert', ref: '@leadbus', name: 'Lead bus' },
  { op: 'edit_channel', channel: '@lead', insert: '@leadbus', volume_db: -8 },
  { op: 'add_insert', ref: '@verb', name: 'Reverb' },
  { op: 'add_effect', insert: '@verb', plugin: 'agstudio.reverb', preset: 'Hall', mix: 1 },
  { op: 'route', from: '@leadbus', to: '@verb', level_db: -8 },
  { op: 'add_effect', ref: '@duck', insert: '@bassbus', plugin: 'agstudio.ducker', preset: 'Tight duck for bass' },
  { op: 'sidechain', effect: '@duck', from: '@drums' },
  { op: 'add_effect', insert: 'master', plugin: 'agstudio.limiter' },
  { op: 'add_pattern', ref: '@a', name: 'Main', bars: 2 },
  {
    op: 'write_notes',
    pattern: '@a',
    channel: '@pads',
    notes: [0, 8, 16, 24].map((step) => ({ step, key: 36 })).concat([4, 12, 20, 28].map((step) => ({ step, key: 38 }))),
  },
  {
    op: 'write_notes',
    pattern: '@a',
    channel: '@bass',
    notes: [0, 6, 16, 22].map((step) => ({ step, key: 33, length: 4 })),
  },
  {
    op: 'write_notes',
    pattern: '@a',
    channel: '@lead',
    notes: [0, 4, 8, 12, 16, 20, 24, 28].map((step, i) => ({ step, key: [69, 72, 76, 74][i % 4], length: 3 })),
  },
  { op: 'place_pattern', pattern: '@a', bar: 1, times: 2 },
  {
    op: 'automate',
    target: { kind: 'plugin', channel: '@lead', param: 'cutoff' },
    bars: 4,
    points: [
      { bar: 0, value: 0.2 },
      { bar: 4, value: 0.9 },
    ],
  },
  {
    op: 'automate',
    target: { kind: 'tempo' },
    from_bar: 1,
    bars: 4,
    points: [
      { bar: 0, value: 128 },
      { bar: 4, value: 136 },
    ],
  },
  { op: 'marker', action: 'add', name: 'Drop', bar: 3 },
];

describe('v2 acceptance', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('builds the song, saves and reopens it identically, hears it and exports it every way', async () => {
    const s = createServices();
    services.push(s);
    const built = applyAnswer(s, { message: 'A song.', actions: SONG }, { previousBeat: null });
    expect(built.warnings).toEqual([]);
    s.view.getState().setMode('song');
    const project = s.doc.getState().project;
    expect(Object.values(project.playlist.markers)).toHaveLength(1);
    expect(Object.values(project.channels).filter((c) => c.kind === 'automation')).toHaveLength(2);
    expect(project.mixer.inserts[MASTER]!.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.limiter']);

    // Save → reopen: the same project.
    const bytes = await s.files.build();
    s.history.markSaved();
    await s.files.newProject();
    expect(await s.files.openFile(new File([bytes.slice().buffer], 'Acceptance.agproj'))).toBe(true);
    expect(s.doc.getState().project).toEqual(project);

    // The analysis hears the mix and every track that plays.
    const report = await analyzeMix(s);
    expect(report.master.silent).toBe(false);
    expect(report.master.truePeakDb!).toBeLessThan(0);
    const heard = report.tracks.filter((t) => !t.m.silent).map((t) => t.name.replace(/^\d+\s*/, ''));
    // A bus with no channels of its own (the reverb) is heard inside the stems of the tracks that send to it.
    expect(heard).toEqual(expect.arrayContaining(['Drums', 'Bass bus', 'Lead bus']));

    // Exports: WAV, FLAC, MP3, stems (zip) and MIDI.
    const files = new Map<string, Uint8Array>();
    const wav = await runExport(s, settings({ codec: 'wav' }), { kind: 'memory', files, name: 'song.wav' });
    const pcm = decodePcm(files.get('song.wav')!)!;
    expect(pcm.channels[0]!.length / pcm.sampleRate).toBeCloseTo(wav.seconds, 1);
    await runExport(s, settings({ codec: 'flac' }), { kind: 'memory', files, name: 'song.flac' });
    expect(decodeFlac(files.get('song.flac')!).channels[0]!.length).toBe(pcm.channels[0]!.length);
    await runExport(s, settings({ codec: 'mp3' }), { kind: 'memory', files, name: 'song.mp3' });
    const mp3 = files.get('song.mp3')!;
    expect(mp3.length).toBeGreaterThan(10_000);
    expect(String.fromCharCode(...mp3.slice(0, 3)) === 'ID3' || (mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0)).toBe(true);
    await runExport(s, settings({ stems: true, stemsTo: 'zip' }), { kind: 'memory', files, name: 'stems.zip' });
    const stems = Object.keys(unzipSync(files.get('stems.zip')!)).sort();
    // "Acceptance - 17 Drums.wav": the file's name, then each mixer track's number and name.
    expect(stems.map((n) => n.replace(/^Acceptance - \d+ /, ''))).toEqual(['Drums.wav', 'Bass bus.wav', 'Lead bus.wav']);
    const midi = parseMidi(exportMidi(s, 'song').bytes);
    expect(midi.tracks.reduce((n, t) => n + t.notes.length, 0)).toBe(2 * (8 + 4 + 8));
  }, 180_000);
});
