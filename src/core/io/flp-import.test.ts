import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ParamValue } from '@agstudio/sdk/params';
import { flpProject, type ProjectSpec } from '../../../test/helpers/flp';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { seededBytes, setIdSource, type RandomBytes } from '../model/ids';
import { MASTER, type AudioClip, type InstrumentChannel, type Project, type SampleRef } from '../model/types';
import { repairProject } from '../schema/migrate';
import { FlpError, flpSamplePaths, parseFlp } from './flp';
import { describeFlpImport, flpToProject, type FlpImportOptions, type FlpResolvedSample } from './flp-import';

const NAMES: Record<string, string> = {
  'agstudio.sampler': 'Sampler',
  'agstudio.3xosc': '3x Osc',
  'agstudio.wavetable': 'Wavetable',
  'agstudio.fm': 'FM',
  'agstudio.bass808': '808 Bass',
  'agstudio.drum-pads': 'Drum Pads',
  'agstudio.drum-synth': 'Drum Synth',
  'agstudio.pluck': 'Pluck',
  'agstudio.slicer': 'Slicer',
  'agstudio.limiter': 'Limiter',
  'agstudio.reverb': 'Reverb',
  'agstudio.eq-pro': 'EQ Pro',
  'agstudio.delay': 'Delay',
};

const plugin: FlpImportOptions['plugin'] = (id) =>
  NAMES[id]
    ? {
        version: 1,
        params: id === 'agstudio.3xosc' ? { osc1Wave: 'saw', cutoff: 8000 } : ({} as Record<string, ParamValue>),
        name: NAMES[id],
      }
    : undefined;

/** Resolves every sample path: `found` ones get an embedded ref, the rest a placeholder. */
function resolve(paths: string[], found: (path: string) => boolean): Map<string, FlpResolvedSample> {
  const m = new Map<string, FlpResolvedSample>();
  paths.forEach((path, i) => {
    const file = path.split(/[\\/]/).pop() ?? path;
    const ref: SampleRef = {
      id: `smp_test${String(i).padStart(6, '0')}` as SampleRef['id'],
      name: file.replace(/\.[^.]+$/, ''),
      source: { kind: 'embedded', hash: String(i).padStart(64, 'a'), ext: 'wav', originalName: file },
    };
    m.set(path, { ref, found: found(path) });
  });
  return m;
}

function load(spec: ProjectSpec, found: (path: string) => boolean = () => true) {
  const flp = parseFlp(flpProject(spec));
  const res = flpToProject(flp, {
    fileName: 'Song.flp',
    plugin,
    samples: resolve(flpSamplePaths(flp), found),
    now: new Date('2026-01-01T00:00:00Z'),
  });
  return { ...res, p: res.project };
}

const byName = (p: Project, name: string) => Object.values(p.channels).find((c) => c.name.startsWith(name));

let previous: RandomBytes;
beforeEach(() => {
  previous = setIdSource(seededBytes(7));
});
afterEach(() => {
  setIdSource(previous);
});

const SONG: ProjectSpec = {
  title: 'Night Drive',
  artist: 'AG',
  tempo: 128,
  ppq: 96,
  channels: [
    { name: 'Kick', sample: 'C:\\Samples\\Kick 01.wav', levels: [6400, 10000], insert: 1 },
    { name: 'Lead', plugin: 'Fruity Wrapper', vst: 'Serum', levels: [0, 12800, -300], insert: 2, color: 0x3322ff },
    { name: 'Pad', plugin: '3x Osc', root: 48, enabled: false },
    { name: 'Vox', sample: '/Users/me/Vox.wav' },
  ],
  patterns: [
    {
      iid: 1,
      name: 'Beat',
      notes: [
        { position: 0, channel: 0, length: 24, key: 60, velocity: 128 },
        { position: 96, channel: 0, length: 24, key: 60, velocity: 64, pan: 0, release: 128, fine: 240 },
      ],
    },
    { iid: 2, name: 'Lead line', notes: [{ position: 0, channel: 1, length: 384, key: 72 }] },
  ],
  arrangements: [
    {
      name: 'Main',
      items: [
        { position: 0, length: 384, track: 0, pattern: 1 },
        { position: 384, length: 384 * 3, track: 2, pattern: 2, startOffset: 96, muted: true },
        { position: 192, length: 384, track: 5, channel: 3, startOffset: 0.5 },
      ],
      tracks: [{ name: 'Drums', color: 0x0000ff }, {}, { name: 'Lead', enabled: false }],
      markers: [
        { position: 768, name: 'Drop' },
        { position: 384, name: 'Verse' },
      ],
    },
  ],
  inserts: [
    { name: 'Master', slots: [{ plugin: 'Fruity Limiter' }] },
    {
      name: 'Drums',
      routes: [0],
      slots: [{ plugin: 'Fruity Reeverb 2' }, { plugin: 'Fruity Wrapper', vst: 'Kickstart 2' }],
    },
    { name: 'Lead bus', routes: [1] },
  ],
  params: [
    { insert: 1, id: 192, value: 12800 },
    { insert: 1, id: 193, value: -3200 },
    { insert: 0, id: 192, value: 16000 },
  ],
};

describe('FL Studio import', () => {
  it('makes a consistent project', () => {
    const { p } = load(SONG);
    expect(projectViolations(p)).toEqual([]);
    expect(repairProject(p).repairs).toEqual([]);
  });

  it('takes the title, artist, tempo and time signature', () => {
    const { p } = load({ ...SONG, timeSig: [6, 8] });
    expect(p.meta).toMatchObject({ title: 'Night Drive', author: 'AG' });
    expect(p.transport.bpm).toBe(128);
    expect(p.transport.timeSig).toEqual({ num: 6, den: 8 });
    expect(load({ channels: [] }).p.transport.bpm).toBe(140); // FL's default when the file has none
    expect(load({ channels: [] }).p.meta.title).toBe('Song');
  });

  it('maps channels: sampler + sample, levels, insert, colour, root key, mute', () => {
    const { p } = load(SONG);
    expect(p.channelOrder.map((id) => p.channels[id]!.name)).toEqual([
      'Kick',
      'Lead (stand-in for Serum)',
      'Pad',
      'Vox',
    ]);
    const kick = byName(p, 'Kick') as InstrumentChannel;
    expect(kick.plugin.pluginId).toBe('agstudio.sampler');
    expect(p.samples[kick.plugin.samples!.main!]!.name).toBe('Kick 01');
    expect(kick.volume).toBeCloseTo(10000 / 12800, 6);
    expect(kick.pan).toBe(0);
    expect(kick.output).toBe(p.mixer.order[1]);
    const lead = byName(p, 'Lead') as InstrumentChannel;
    expect(lead.plugin.pluginId).toBe('agstudio.wavetable');
    expect(lead).toMatchObject({ volume: 1, pan: -1, pitch: -300, color: '#ff2233', output: p.mixer.order[2] });
    const pad = byName(p, 'Pad') as InstrumentChannel;
    expect(pad.plugin.pluginId).toBe('agstudio.3xosc');
    expect(pad.plugin.params).toEqual({ osc1Wave: 'saw', cutoff: 8000 }); // defaults, not FL's settings
    expect(pad).toMatchObject({ rootKey: 48, muted: true, output: MASTER });
  });

  it('rescales ticks (PPQ 96 → 960) and keeps velocity, pan, release and fine pitch', () => {
    const { p } = load(SONG);
    const kick = byName(p, 'Kick')!;
    const beat = p.patterns[p.patternOrder[0]!]!;
    expect(beat.name).toBe('Beat');
    const notes = Object.values(beat.notes[kick.id]!).sort((a, b) => a.tick - b.tick);
    expect(notes.map((n) => [n.tick, n.length, n.key])).toEqual([
      [0, 240, 60],
      [960, 240, 60],
    ]);
    expect(notes[0]!.velocity).toBe(1);
    expect(notes[0]!.pan).toBeUndefined();
    expect(notes[1]).toMatchObject({ velocity: 0.5, pan: -1, release: 1, fine: 100 });
  });

  it('rescales other resolutions too (PPQ 960 stays, 192 doubles to 960)', () => {
    const spec = (ppq: number): ProjectSpec => ({
      ppq,
      channels: [{ name: 'Pad', plugin: '3x Osc' }],
      patterns: [{ iid: 1, notes: [{ position: ppq, channel: 0, length: ppq / 2, key: 60 }] }],
    });
    for (const ppq of [960, 192, 48]) {
      const { p } = load(spec(ppq));
      const n = Object.values(Object.values(p.patterns[p.patternOrder[0]!]!.notes)[0]!)[0]!;
      expect([n.tick, n.length]).toEqual([960, 480]);
    }
  });

  it('builds the playlist: pattern base, track order, offsets, mute, audio clips, track names, markers', () => {
    const { p, hasSong } = load(SONG);
    expect(hasSong).toBe(true);
    const lanes = p.playlist.laneOrder.map((id) => p.playlist.lanes[id]!);
    expect(lanes).toHaveLength(32);
    expect(lanes[0]).toMatchObject({ name: 'Drums', color: '#ff0000', muted: false });
    expect(lanes[1]!.name).toBe('Track 2');
    expect(lanes[2]).toMatchObject({ name: 'Lead', muted: true });
    const clips = Object.values(p.playlist.clips).sort((a, b) => a.start - b.start || a.laneId.localeCompare(b.laneId));
    const lane = (id: string) => p.playlist.laneOrder.indexOf(id as never);
    const beat = clips.find((c) => c.kind === 'pattern' && p.patterns[c.patternId]!.name === 'Beat')!;
    expect([beat.start, beat.length, lane(beat.laneId)]).toEqual([0, 3840, 0]);
    const lead = clips.find((c) => c.kind === 'pattern' && p.patterns[c.patternId]!.name === 'Lead line')!;
    expect(lead).toMatchObject({ start: 3840, length: 11520, offset: 960, muted: true });
    expect(lane(lead.laneId)).toBe(2);
    // FL clips don't loop: the pattern is long enough to hold its longest clip (offset + length).
    expect(p.patterns[lead.kind === 'pattern' ? lead.patternId : ('' as never)]!.length).toBe(15360);
    // The sampler that is only on the playlist is FL's audio clip channel.
    const vox = byName(p, 'Vox')!;
    expect(vox.kind).toBe('audioClip');
    const audio = clips.find((c) => c.kind === 'audio') as AudioClip;
    expect(audio).toMatchObject({ channelId: vox.id, start: 1920, length: 3840 });
    expect(audio.offsetSec).toBeCloseTo((0.5 * 60) / 128, 9);
    expect(lane(audio.laneId)).toBe(5);
    const markers = Object.values(p.playlist.markers).sort((a, b) => a.tick - b.tick);
    expect(markers.map((m) => [m.tick, m.name])).toEqual([
      [3840, 'Verse'],
      [7680, 'Drop'],
    ]);
  });

  it('imports the open arrangement and reports the others', () => {
    const { p, report } = load({
      ...SONG,
      arrangements: [
        { name: 'Main', items: [{ position: 0, length: 96, track: 0, pattern: 1 }] },
        {
          name: 'Remix',
          items: [
            { position: 0, length: 96, track: 3, pattern: 2 },
            { position: 96, length: 96, track: 3, pattern: 2 },
          ],
        },
      ],
      currentArrangement: 1,
    });
    expect(Object.keys(p.playlist.clips)).toHaveLength(2);
    expect(report.arrangement).toBe('Remix');
    expect(report.otherArrangements).toEqual(['Main']);
  });

  it('maps the mixer: names, volume, pan, routing, sends and effects', () => {
    const { p, report } = load(SONG);
    expect(p.mixer.order).toHaveLength(17);
    const [master, drums, bus, plain] = p.mixer.order.map((id) => p.mixer.inserts[id]!);
    expect(master!.volume).toBeCloseTo(1.905, 3);
    expect(master!.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.limiter']);
    expect(drums).toMatchObject({ name: 'Drums', volume: 1, pan: -0.5 });
    expect(drums!.routes).toEqual([{ to: MASTER, level: 1, pre: false }]);
    expect(drums!.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.reverb']);
    expect(bus!.name).toBe('Lead bus');
    expect(bus!.routes.map((r) => r.to)).toEqual([drums!.id]);
    expect(plain).toMatchObject({ name: 'Insert 3', routes: [{ to: MASTER, level: 1, pre: false }] });
    expect(report.skippedEffects).toEqual([{ insert: 'Drums', plugin: 'Kickstart 2' }]);
    expect(report.effects).toBe(2);
  });

  it('gives generators a built-in stand-in by plugin and by name, keeping their notes', () => {
    const { p, report } = load({
      channels: [
        { name: 'Sytrus', plugin: 'Sytrus' },
        { name: '808 Boom', plugin: 'Fruity Wrapper', vst: 'Serum' },
        { name: 'Snare', plugin: 'Fruity DrumSynth Live' },
        { name: 'Drums', plugin: 'FPC' },
        { name: 'Keys', plugin: 'Fruity Wrapper', vst: 'Keyscape' },
        { name: 'Nexus', plugin: 'Fruity Wrapper', vst: 'Nexus' },
        { name: 'Strings', plugin: 'Plucked!' },
        { name: 'Pad', plugin: 'Harmor' },
      ],
      patterns: [
        { iid: 1, notes: [0, 1, 2, 3, 4, 5, 6, 7].map((c) => ({ position: 0, channel: c, length: 96, key: 60 })) },
      ],
    });
    const id = (n: string) => (byName(p, n) as InstrumentChannel).plugin.pluginId;
    expect(id('Sytrus')).toBe('agstudio.fm');
    expect(id('808 Boom')).toBe('agstudio.bass808');
    expect(id('Snare')).toBe('agstudio.sampler');
    const snare = byName(p, 'Snare') as InstrumentChannel;
    expect(p.samples[snare.plugin.samples!.main!]!.source).toEqual({
      kind: 'builtin',
      generator: 'kit/snare',
      version: 1,
    });
    expect(id('Drums')).toBe('agstudio.drum-pads');
    expect(id('Keys')).toBe('agstudio.3xosc');
    expect(id('Nexus')).toBe('agstudio.wavetable');
    expect(byName(p, 'Nexus')!.name).toBe('Nexus (stand-in)');
    expect(id('Strings')).toBe('agstudio.pluck');
    expect(id('Pad')).toBe('agstudio.wavetable');
    expect(report.notes).toBe(8);
    expect(report.standIns.filter((s) => s.vst).map((s) => s.plugin)).toEqual(['Serum', 'Keyscape', 'Nexus']);
    expect(projectViolations(p)).toEqual([]);
  });

  it('reports missing samples and keeps their channels (with a named placeholder sample)', () => {
    const { p, report } = load(SONG, (path) => !path.includes('Kick'));
    const kick = byName(p, 'Kick') as InstrumentChannel;
    expect(kick.plugin.samples?.main).toBeDefined();
    expect(report.missingSamples).toEqual([{ channel: 'Kick', file: 'Kick 01.wav', path: 'C:\\Samples\\Kick 01.wav' }]);
    const text = describeFlpImport(report).details.join('\n');
    expect(text).toMatch(/1 sample wasn’t in the file \(Kick 01\.wav\).*zipped loop package/);
  });

  it('copies layer notes to the layer’s children', () => {
    const { p, report } = load({
      channels: [
        { name: 'Layer', type: 3, plugin: 'Layer', children: [1, 2] },
        { name: 'A', plugin: '3x Osc' },
        { name: 'B', plugin: '3x Osc' },
      ],
      patterns: [{ iid: 1, notes: [{ position: 0, channel: 0, length: 96, key: 64 }] }],
    });
    expect(p.channelOrder).toHaveLength(2);
    const pat = p.patterns[p.patternOrder[0]!]!;
    expect(Object.keys(pat.notes)).toHaveLength(2);
    expect(report.layers).toEqual([{ channel: 'Layer', children: 2 }]);
    expect(report.notes).toBe(2);
  });

  it('imports automation clips with points in beats, and their target when it is clear', () => {
    const { p, report } = load({
      channels: [
        { name: 'Bass', plugin: '3x Osc' },
        {
          name: 'Bass vol',
          type: 5,
          automation: [
            { beats: 0, value: 0 },
            { beats: 4, value: 1, tension: 0.5 },
          ],
        },
        { name: 'Mystery', type: 5, automation: [{ beats: 0, value: 0.5 }] },
      ],
      links: [
        { channel: 1, param: 0, destination: 0 },
        { channel: 2, param: 0x8005, destination: 0x2041 },
      ],
      arrangements: [{ items: [{ position: 96, length: 384, track: 1, channel: 1, startOffset: 1 }] }],
    });
    const auto = byName(p, 'Bass vol')!;
    expect(auto.kind).toBe('automation');
    if (auto.kind !== 'automation') return;
    expect(auto.points).toEqual([
      { tick: 0, value: 0 },
      { tick: 3840, value: 1, tension: 0.5 },
    ]);
    expect(auto.target).toEqual({ kind: 'channel', channelId: byName(p, 'Bass')!.id, param: 'volume' });
    const clip = Object.values(p.playlist.clips)[0]!;
    expect(clip).toMatchObject({ kind: 'automation', channelId: auto.id, start: 960, length: 3840, offset: 960 });
    expect(report.untargetedAutomation).toEqual(['Mystery']);
  });

  it('leaves slide notes out and says so', () => {
    const { report } = load({
      channels: [{ name: 'Bass', plugin: '3x Osc' }],
      patterns: [
        {
          iid: 1,
          notes: [
            { position: 0, channel: 0, length: 96, key: 48 },
            { position: 48, channel: 0, length: 48, key: 50, flags: 0x4008 },
          ],
        },
      ],
    });
    expect(report.slideNotes).toBe(1);
    expect(describeFlpImport(report).details.join(' ')).toMatch(/1 slide note/);
  });

  it('describes the import in plain words', () => {
    const { report } = load(SONG, (path) => !path.includes('Kick'));
    const { headline, details } = describeFlpImport(report);
    expect(headline).toBe(
      'Imported 4 channels, 2 patterns, the arrangement “Main” (3 clips), 2 markers and 2 effects.',
    );
    expect(details[0]).toMatch(
      /^Not imported: 1 VST plugin \(Serum\)\. Their channels keep their notes and play a stand-in/,
    );
    expect(details.join('\n')).toMatch(/Effects not imported: Kickstart 2 \(Drums\)/);
    expect(describeFlpImport(report, { fromPackage: true }).details.join('\n')).toMatch(/not in the zip/);
  });

  it('turns any readable file into a consistent project (fuzzed specs)', () => {
    const note = fc.record({
      position: fc.nat({ max: 5000 }),
      channel: fc.nat({ max: 6 }),
      length: fc.nat({ max: 2000 }),
      key: fc.nat({ max: 140 }),
      velocity: fc.nat({ max: 255 }),
      pan: fc.nat({ max: 255 }),
      fine: fc.nat({ max: 255 }),
      flags: fc.constantFrom(0x4000, 0x4008, 0),
    });
    const spec = fc.record({
      ppq: fc.constantFrom(24, 48, 96, 192, 960),
      tempo: fc.option(fc.double({ min: 1, max: 2000, noNaN: true }), { nil: undefined }),
      timeSig: fc.option(fc.tuple(fc.nat({ max: 40 }), fc.nat({ max: 40 })), { nil: undefined }),
      channels: fc.array(
        fc.record({
          name: fc.string({ maxLength: 80 }),
          plugin: fc.constantFrom('', '3x Osc', 'Fruity Wrapper', 'Sytrus', 'Layer', 'FPC'),
          type: fc.constantFrom(0, 2, 3, 4, 5),
          insert: fc.integer({ min: -1, max: 127 }),
          levels: fc.tuple(
            fc.integer({ min: -20000, max: 20000 }),
            fc.integer({ min: 0, max: 40000 }),
            fc.integer({ min: -9000, max: 9000 }),
          ),
          children: fc.array(fc.nat({ max: 8 }), { maxLength: 3 }),
          automation: fc.array(
            fc.record({
              beats: fc.double({ min: 0, max: 64, noNaN: true }),
              value: fc.double({ min: -2, max: 2, noNaN: true }),
            }),
            { maxLength: 4 },
          ),
        }),
        { maxLength: 7 },
      ),
      patterns: fc.array(fc.record({ iid: fc.nat({ max: 20 }), notes: fc.array(note, { maxLength: 8 }) }), {
        maxLength: 4,
      }),
      arrangements: fc.array(
        fc.record({
          items: fc.array(
            fc.record({
              position: fc.nat({ max: 100000 }),
              length: fc.nat({ max: 10000 }),
              track: fc.nat({ max: 499 }),
              pattern: fc.option(fc.nat({ max: 22 }), { nil: undefined }),
              channel: fc.nat({ max: 8 }),
              startOffset: fc.option(fc.nat({ max: 4000 }), { nil: undefined }),
            }),
            { maxLength: 8 },
          ),
          markers: fc.array(fc.record({ position: fc.nat({ max: 100000 }), name: fc.string({ maxLength: 70 }) }), {
            maxLength: 3,
          }),
        }),
        { maxLength: 2 },
      ),
      inserts: fc.array(
        fc.record({
          name: fc.string({ maxLength: 10 }),
          routes: fc.array(fc.nat({ max: 20 }), { maxLength: 3 }),
          slots: fc.array(fc.record({ plugin: fc.constantFrom('Fruity Limiter', 'Fruity Wrapper', 'Mystery') }), {
            maxLength: 2,
          }),
        }),
        { maxLength: 4 },
      ),
    });
    fc.assert(
      fc.property(spec, (s) => {
        let flp;
        try {
          flp = parseFlp(flpProject(s as ProjectSpec));
        } catch (e) {
          if (e instanceof FlpError) return;
          throw e;
        }
        const { project } = flpToProject(flp, {
          fileName: 'x.flp',
          plugin,
          samples: resolve(flpSamplePaths(flp), () => true),
        });
        const repaired = repairProject(project).project;
        expect(projectViolations(repaired)).toEqual([]);
        expect(projectViolations(project)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
