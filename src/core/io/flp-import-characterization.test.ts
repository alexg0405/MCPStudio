/**
 * Characterization of the FL Studio import: the exact project, report and report text for a few rich
 * projects. It pins the mapping (including every generated id) so the importer can be reorganised without
 * changing what it imports. If a deliberate change to the mapping makes it fail, review the snapshot diff
 * and regenerate it with `vitest -u`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk/params';
import { flpProject, type ProjectSpec } from '../../../test/helpers/flp';
import { seededBytes, setIdSource, type RandomBytes } from '../model/ids';
import type { SampleRef } from '../model/types';
import { flpSamplePaths, parseFlp } from './flp';
import { describeFlpImport, flpToProject, type FlpImportOptions, type FlpResolvedSample } from './flp-import';

const INSTALLED = [
  'agstudio.sampler',
  'agstudio.3xosc',
  'agstudio.wavetable',
  'agstudio.fm',
  'agstudio.bass808',
  'agstudio.drum-pads',
  'agstudio.pluck',
  'agstudio.limiter',
  'agstudio.reverb',
  'agstudio.eq-pro',
  'agstudio.delay',
  'agstudio.compressor',
];

const plugin: FlpImportOptions['plugin'] = (id) =>
  INSTALLED.includes(id)
    ? {
        version: 2,
        params: id === 'agstudio.3xosc' ? { osc1Wave: 'saw', cutoff: 8000 } : ({} as Record<string, ParamValue>),
        name: id.replace('agstudio.', ''),
      }
    : undefined;

function resolve(paths: string[]): Map<string, FlpResolvedSample> {
  const resolved = new Map<string, FlpResolvedSample>();
  paths.forEach((path, i) => {
    const file = path.split(/[\\/]/).pop() ?? path;
    const ref: SampleRef = {
      id: `smp_test${String(i).padStart(6, '0')}` as SampleRef['id'],
      name: file.replace(/\.[^.]+$/, ''),
      source: { kind: 'embedded', hash: String(i).padStart(64, 'a'), ext: 'wav', originalName: file },
    };
    resolved.set(path, { ref, found: i % 2 === 0 });
  });
  return resolved;
}

const RICH: ProjectSpec = {
  title: 'Night Drive',
  artist: 'AG',
  tempo: 128,
  ppq: 96,
  timeSig: [6, 8],
  channels: [
    { name: 'Kick', sample: 'C:\\Samples\\Kick 01.wav', levels: [6400, 10000], insert: 1 },
    { name: 'Lead', plugin: 'Fruity Wrapper', vst: 'Serum', levels: [0, 12800, -300], insert: 2, color: 0x3322ff },
    { name: 'Pad', plugin: '3x Osc', root: 48, enabled: false },
    { name: 'Vox', sample: '/Users/me/Vox.wav' },
    { name: 'Layer', type: 3, children: [0, 2] },
    { name: 'Snare Drum', plugin: 'Sytrus' },
    { name: '808 Sub', plugin: 'Fruity Wrapper', vst: 'Some Bass' },
    {
      name: 'Vol curve',
      type: 5,
      automation: [
        { beats: 0, value: 0.2 },
        { beats: 4, value: 0.9, tension: 0.5 },
      ],
    },
    { name: 'Orphan curve', type: 5, automation: [{ beats: 0, value: 0.5 }] },
  ],
  patterns: [
    {
      iid: 1,
      name: 'Beat',
      notes: [
        { position: 0, channel: 0, length: 24, key: 60, velocity: 128 },
        { position: 96, channel: 0, length: 24, key: 60, velocity: 64, pan: 0, release: 128, fine: 240 },
        { position: 120, channel: 4, length: 48, key: 64, flags: 8 },
        { position: 144, channel: 4, length: 48, key: 65 },
        { position: 150, channel: 99, length: 10, key: 70 },
      ],
    },
    { iid: 2, name: 'Lead line', color: 0x00ff00, notes: [{ position: 0, channel: 1, length: 384, key: 72 }] },
    { iid: 3 },
  ],
  arrangements: [
    {
      name: 'Main',
      items: [
        { position: 0, length: 384, track: 0, pattern: 1 },
        { position: 384, length: 384 * 3, track: 2, pattern: 2, startOffset: 96, muted: true },
        { position: 192, length: 384, track: 5, channel: 3, startOffset: 0.5 },
        { position: 0, length: 96, track: 7, channel: 7 },
        { position: 0, length: 96, track: 9, pattern: 77 },
      ],
      tracks: [{ name: 'Drums', color: 0x0000ff }, {}, { name: 'Lead', enabled: false }],
      markers: [
        { position: 768, name: 'Drop' },
        { position: 384, signature: [3, 4] },
      ],
    },
    { name: 'Alt', items: [{ position: 0, length: 96, track: 0, pattern: 2 }] },
  ],
  currentArrangement: 0,
  inserts: [
    { name: 'Master', slots: [{ plugin: 'Fruity Limiter' }] },
    {
      name: 'Drums',
      routes: [0, 2],
      slots: [
        { plugin: 'Fruity Reeverb 2' },
        { plugin: 'Fruity Wrapper', vst: 'Kickstart 2' },
        { plugin: 'Gross Beat' },
      ],
    },
    { name: 'Lead bus', routes: [1], flags: 0 },
    { slots: [{ plugin: 'Fruity Wrapper', vst: 'Plain Reverb Hall' }] },
  ],
  params: [
    { insert: 1, id: 192, value: 12800 },
    { insert: 1, id: 193, value: -3200 },
    { insert: 0, id: 192, value: 16000 },
    { insert: 1, id: 64 + 2, value: 8000 },
  ],
  links: [
    { channel: 7, param: 0, destination: 0 },
    { channel: 8, param: 5, destination: 0 },
  ],
};

const SPECS: Record<string, ProjectSpec> = {
  rich: RICH,
  legacy: {
    version: '11.0.0.1',
    legacyTempo: [100, 500],
    ppq: 192,
    channels: [
      { name: 'Pad', plugin: '3x Osc' },
      { name: 'Piano', plugin: 'Fruity Wrapper', vst: 'Grand Piano' },
    ],
    patterns: [{ iid: 1, notes: [{ position: 192, channel: 0, length: 96, key: 60 }] }],
    arrangements: [{ items: [{ position: 0, length: 800, track: 3, pattern: 1 }] }],
    legacyPlaylist: true,
  },
  empty: { channels: [] },
};

let previousIdSource: RandomBytes;
beforeEach(() => {
  previousIdSource = setIdSource(seededBytes(7));
});
afterEach(() => {
  setIdSource(previousIdSource);
});

describe('FL Studio import output', () => {
  it('stays identical for rich projects (project, report and report text)', async () => {
    const outputs: string[] = [];
    for (const [name, spec] of Object.entries(SPECS)) {
      setIdSource(seededBytes(7));
      const flp = parseFlp(flpProject(spec));
      const result = flpToProject(flp, {
        fileName: `${name}.flp`,
        plugin,
        samples: resolve(flpSamplePaths(flp)),
        now: new Date('2026-01-01T00:00:00Z'),
      });
      const text = describeFlpImport(result.report, { fromPackage: name === 'legacy' });
      outputs.push(`${name}\n${JSON.stringify({ ...result, text }, null, 1)}`);
    }
    await expect(outputs.join('\n\n') + '\n').toMatchFileSnapshot('./__snapshots__/flp-import.txt');
  });
});
