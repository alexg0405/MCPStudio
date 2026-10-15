import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { zipSync } from 'fflate';
import {
  ascii,
  data,
  ev,
  flpFile,
  flpProject,
  playlist,
  projectEvents,
  text,
  type ProjectSpec,
} from '../../../test/helpers/flp';
import { FLP_EVENT as E, FlpError, flpSamplePaths, parseFlp } from './flp';
import { isZip, matchSampleFile, readFlpPackage, readZipAudio } from './flp-package';

const SPEC: ProjectSpec = {
  version: '21.2.3.4004',
  title: 'Night Drive',
  artist: 'AG',
  genre: 'Synthwave',
  tempo: 128.5,
  timeSig: [3, 4],
  channels: [
    { name: 'Kick', sample: 'C:\\Users\\me\\Samples\\Kick 01.wav', levels: [6400, 10000], insert: 1 },
    { name: 'Lead', plugin: 'Fruity Wrapper', vst: 'Serum', levels: [0, 12800, -300], insert: 2, color: 0x3322ff },
    { name: 'Pad', plugin: '3x Osc', root: 48, enabled: false },
  ],
  patterns: [
    {
      iid: 1,
      name: 'Beat',
      color: 0x00ff00,
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
        { position: 384, length: 192, track: 2, pattern: 2, startOffset: 96, muted: true },
        { position: 0, length: 96, track: 5, channel: 0, startOffset: 0.5 },
      ],
      tracks: [{ name: 'Drums', color: 0x0000ff }, {}, { name: 'Lead', enabled: false }],
      markers: [
        { position: 384, name: 'Drop' },
        { position: 768, signature: [7, 8] },
      ],
    },
  ],
  inserts: [
    { name: 'Master', slots: [{ plugin: 'Fruity Limiter' }] },
    {
      name: 'Drums',
      routes: [0],
      slots: [{ plugin: 'Fruity Reeverb 2' }, { plugin: 'Fruity Wrapper', vst: 'Pro-Q 3' }],
    },
    { routes: [1] },
  ],
  params: [
    { insert: 1, id: 192, value: 6400 },
    { insert: 1, id: 193, value: -3200 },
    { insert: 2, id: 64 + 1, value: 12800 },
    { insert: 1, slot: 1, id: 0, value: 0 },
  ],
};

describe('FLP reader', () => {
  it('reads the header, version, project info, tempo and time signature', () => {
    const f = parseFlp(flpProject(SPEC));
    expect(f.ppq).toBe(96);
    expect(f.channelCount).toBe(3);
    expect(f.version).toBe('21.2.3.4004');
    expect(f.versionParts).toEqual([21, 2, 3, 4004]);
    expect(f.title).toBe('Night Drive');
    expect(f.artist).toBe('AG');
    expect(f.genre).toBe('Synthwave');
    expect(f.tempo).toBeCloseTo(128.5, 6);
    expect(f.timeSig).toEqual({ num: 3, beat: 4 });
    expect(f.warnings).toEqual([]);
  });

  it('reads channels: names, generator, VST name, levels, insert, colour, root key, sample path', () => {
    const f = parseFlp(flpProject(SPEC));
    expect(f.channels.map((c) => c.iid)).toEqual([0, 1, 2]);
    const [kick, lead, pad] = f.channels;
    expect(kick).toMatchObject({ name: 'Kick', internalName: '', samplePath: 'C:\\Users\\me\\Samples\\Kick 01.wav' });
    expect(kick).toMatchObject({ pan: 6400, volume: 10000, insert: 1, enabled: true });
    expect(lead).toMatchObject({
      name: 'Lead',
      internalName: 'Fruity Wrapper',
      vst: { name: 'Serum', vendor: 'Vendor' },
    });
    expect(lead).toMatchObject({ pan: 0, volume: 12800, pitch: -300, insert: 2, color: '#ff2233' });
    expect(pad).toMatchObject({ internalName: '3x Osc', rootNote: 48, enabled: false });
    expect(flpSamplePaths(f)).toEqual(['C:\\Users\\me\\Samples\\Kick 01.wav']);
  });

  it('reads patterns and the 24-byte note records', () => {
    const f = parseFlp(flpProject(SPEC));
    expect(f.patterns.map((p) => [p.iid, p.name, p.color])).toEqual([
      [1, 'Beat', '#00ff00'],
      [2, 'Lead line', undefined],
    ]);
    expect(f.patterns[0]!.notes[1]).toMatchObject({
      position: 96,
      channel: 0,
      length: 24,
      key: 60,
      velocity: 64,
      pan: 0,
      release: 128,
      fine: 240,
      flags: 0x4000,
    });
  });

  it('reads arrangements: items (pattern base, reversed tracks, offsets, mute), tracks and markers', () => {
    const f = parseFlp(flpProject(SPEC));
    expect(f.arrangements).toHaveLength(1);
    const a = f.arrangements[0]!;
    expect(a.name).toBe('Main');
    expect(a.items).toEqual([
      { position: 0, length: 384, track: 0, kind: 'pattern', ref: 1, muted: false, startOffset: null, endOffset: null },
      { position: 384, length: 192, track: 2, kind: 'pattern', ref: 2, muted: true, startOffset: 96, endOffset: null },
      // Channel item offsets are beats (float) → ticks at the file's PPQ.
      { position: 0, length: 96, track: 5, kind: 'channel', ref: 0, muted: false, startOffset: 48, endOffset: null },
    ]);
    expect(a.tracks.map((t) => [t.name, t.color, t.enabled])).toEqual([
      ['Drums', '#ff0000', true],
      [undefined, '#565148', true],
      ['Lead', '#565148', false],
    ]);
    expect(a.markers).toEqual([
      { position: 384, kind: 0, name: 'Drop' },
      { position: 768, kind: 1, numerator: 7, denominator: 8 },
    ]);
  });

  it('reads pattern offsets written as float32 too', () => {
    const f = parseFlp(
      flpProject({
        arrangements: [
          { items: [{ position: 0, length: 96, track: 0, pattern: 1, startOffset: 48, floatOffsets: true }] },
        ],
      }),
    );
    expect(f.arrangements[0]!.items[0]!.startOffset).toBe(48);
  });

  it('detects the playlist record size (32, 60, 80, 88 bytes)', () => {
    for (const stride of [32, 60, 80, 88]) {
      const f = parseFlp(
        flpProject({
          arrangements: [
            {
              stride,
              items: [
                { position: 0, length: 96, track: 3, pattern: 1 },
                { position: 96, length: 96, track: 4, pattern: 2 },
              ],
            },
          ],
        }),
      );
      expect(f.arrangements[0]!.items.map((i) => [i.track, i.ref])).toEqual([
        [3, 1],
        [4, 2],
      ]);
    }
  });

  it('un-reverses track indexes by version: 499 from FL 12.9.1, 198 before', () => {
    const old = parseFlp(
      flpProject({
        version: '12.3.0.5',
        arrangements: [{ items: [{ position: 0, length: 96, track: 7, pattern: 1 }] }],
      }),
    );
    expect(old.arrangements[0]!.items[0]!.track).toBe(7);
    const raw = playlist([{ position: 0, length: 96, track: 7, pattern: 1 }], { maxTrack: 198 });
    const modern = parseFlp(flpFile([data(E.version, ascii('20.8.0.1')), raw]));
    // Stored for 199 tracks but read as 500: the item would land on track 308, not 7.
    expect(modern.arrangements[0]!.items[0]!.track).toBe(499 - 191);
  });

  it('reads files from before arrangements (FL < 12.9) as one implicit arrangement', () => {
    const f = parseFlp(
      flpProject({
        version: '12.3.0.5',
        legacyPlaylist: true,
        arrangements: [
          { items: [{ position: 0, length: 96, track: 0, pattern: 1 }], markers: [{ position: 0, name: 'A' }] },
        ],
      }),
    );
    expect(f.arrangements).toHaveLength(1);
    expect(f.arrangements[0]!.items).toHaveLength(1);
    expect(f.arrangements[0]!.markers[0]!.name).toBe('A');
  });

  it('decodes text by version: UTF-16 from 11.5, single-byte before', () => {
    const modern = parseFlp(flpProject({ version: '11.5.0.1', title: 'Grüße ♫' }));
    expect(modern.title).toBe('Grüße ♫');
    const old = parseFlp(flpProject({ version: '11.1.0.1', title: 'Grüße' }));
    expect(old.title).toBe('Grüße');
    const nine = parseFlp(
      flpProject({ version: '9.0.0', title: 'Old song', channels: [{ name: 'Bass', plugin: '3x Osc' }] }),
    );
    expect(nine.title).toBe('Old song');
    expect(nine.channels[0]!.name).toBe('Bass');
  });

  it('reads the legacy coarse/fine tempo when the modern event is missing', () => {
    expect(parseFlp(flpProject({ legacyTempo: [93, 250] })).tempo).toBeCloseTo(93.25, 6);
    expect(parseFlp(flpProject({ tempo: 140, legacyTempo: [93, 0] })).tempo).toBe(140);
  });

  it('reads mixer inserts: names, routing, sends, volume/pan params, effect slots (VST names)', () => {
    const f = parseFlp(flpProject(SPEC));
    expect(f.inserts).toHaveLength(3);
    const [master, drums, third] = f.inserts;
    expect(master!.name).toBe('Master');
    expect(master!.slots.map((s) => s.internalName)).toEqual(['Fruity Limiter']);
    expect(drums).toMatchObject({ name: 'Drums', volume: 6400, pan: -3200 });
    expect(drums!.routing![0]).toBe(true);
    expect(drums!.slots.map((s) => [s.index, s.internalName, s.vst?.name, s.enabled])).toEqual([
      [0, 'Fruity Reeverb 2', undefined, undefined],
      [1, 'Fruity Wrapper', 'Pro-Q 3', false],
    ]);
    expect(third!.routing![1]).toBe(true);
    expect(third!.sends[1]).toBe(12800);
  });

  it('reads automation channel points (delta-encoded beats) and target links', () => {
    const f = parseFlp(
      flpProject({
        channels: [
          { name: 'Bass', plugin: '3x Osc' },
          {
            name: 'Bass vol',
            type: 5,
            plugin: '',
            automation: [
              { beats: 0, value: 0 },
              { beats: 4, value: 1, tension: 0.5 },
              { beats: 6, value: 0.25 },
            ],
          },
        ],
        links: [{ channel: 1, param: 0, destination: 0 }],
      }),
    );
    expect(f.channels[1]!.automation).toEqual([
      { beats: 0, value: 0, tension: 0 },
      { beats: 4, value: 1, tension: 0.5 },
      { beats: 6, value: 0.25, tension: 0 },
    ]);
    expect(f.automationLinks).toEqual([{ channel: 1, param: 0, destination: 0 }]);
  });

  it('skips unknown events of every size', () => {
    const events = projectEvents({ title: 'X' });
    events.push(ev(63, 1), ev(120, 2), ev(190, 3), data(250, new Uint8Array(300)), data(207, new Uint8Array(0)));
    const f = parseFlp(flpFile(events));
    expect(f.title).toBe('X');
    expect(f.skippedEvents).toBeGreaterThanOrEqual(4);
  });

  it('reads multi-byte varint lengths', () => {
    const long = 'x'.repeat(200); // 402 bytes of UTF-16: a two-byte length
    expect(parseFlp(flpFile([data(E.version, ascii('21.0.0')), text(E.title, long)])).title).toBe(long);
  });

  it('gives readable errors for files that are not projects', () => {
    expect(() => parseFlp(new Uint8Array([1, 2, 3]))).toThrow(FlpError);
    expect(() => parseFlp(new TextEncoder().encode('MThd....'))).toThrow("This isn't an FL Studio project");
    expect(() => parseFlp(flpFile([], { format: 0x10 }))).toThrow('score file');
    expect(() => parseFlp(flpFile([]))).toThrow('no project data');
    const bytes = flpProject(SPEC);
    expect(() => parseFlp(bytes.subarray(0, 10))).toThrow('cut off');
  });

  it('imports what it can from a cut-off file and says so', () => {
    const bytes = flpProject(SPEC);
    const f = parseFlp(bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    expect(f.warnings.join(' ')).toMatch(/cut off/);
    expect(f.title).toBe('Night Drive');
  });

  it('never throws anything but FlpError on random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        try {
          parseFlp(bytes);
        } catch (e) {
          if (!(e instanceof FlpError)) throw e;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never crashes on mutated valid files (random header + event bytes)', () => {
    const valid = flpProject(SPEC);
    fc.assert(
      fc.property(
        fc.array(fc.record({ at: fc.nat({ max: valid.length - 1 }), value: fc.integer({ min: 0, max: 255 }) }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.nat({ max: valid.length }),
        (edits, cut) => {
          const b = valid.slice(0, Math.max(cut, 14));
          for (const e of edits) if (e.at < b.length) b[e.at] = e.value;
          try {
            const f = parseFlp(b);
            expect(f.ppq).toBeGreaterThan(0);
          } catch (e) {
            if (!(e instanceof FlpError)) throw e;
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('Zipped loop packages', () => {
  const flp = flpProject(SPEC);
  const zip = zipSync({
    'Night Drive/Night Drive.flp': flp,
    'Night Drive/Backup/Night Drive (old).flp': new Uint8Array(10),
    'Night Drive/Samples/Kick 01.wav': new Uint8Array([1, 2, 3]),
    'Night Drive/Samples/Other.WAV': new Uint8Array([4]),
    'Night Drive/readme.txt': new Uint8Array([5]),
    '__MACOSX/Night Drive/._Kick 01.wav': new Uint8Array([6]),
  });

  it('finds the project (the shallowest .flp) and the audio files', () => {
    expect(isZip(zip)).toBe(true);
    expect(isZip(flp)).toBe(false);
    const pkg = readFlpPackage(zip);
    expect(pkg.flpName).toBe('Night Drive.flp');
    expect(parseFlp(pkg.flp).title).toBe('Night Drive');
    expect(pkg.audio.map((a) => a.path).sort()).toEqual([
      'Night Drive/Samples/Kick 01.wav',
      'Night Drive/Samples/Other.WAV',
    ]);
    expect(readZipAudio(zip)).toHaveLength(2);
  });

  it('matches sample paths by file name (any folder, any case, then by stem)', () => {
    const files = readFlpPackage(zip).audio;
    expect(matchSampleFile('C:\\Users\\me\\Samples\\KICK 01.wav', files)?.path).toBe('Night Drive/Samples/Kick 01.wav');
    expect(matchSampleFile('/Users/me/other.wav', files)?.path).toBe('Night Drive/Samples/Other.WAV');
    expect(matchSampleFile('%FLStudioFactoryData%\\Data\\Kick 01.flac', files)?.path).toBe(
      'Night Drive/Samples/Kick 01.wav',
    );
    expect(matchSampleFile('C:\\nothing.wav', files)).toBeUndefined();
  });

  it('says what is wrong with zips that are not packages', () => {
    expect(() => readFlpPackage(zipSync({ 'a.wav': new Uint8Array(1) }))).toThrow('no FL Studio project');
    expect(() => readFlpPackage(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toThrow(FlpError);
  });
});
