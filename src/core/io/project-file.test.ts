import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { createEmptyProject } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { SCHEMA_VERSION, type Project } from '../model/types';
import { MIGRATIONS, migrateProject, type Migration } from '../schema/migrate';
import { sha256Hex } from './hash';
import {
  ProjectFileError,
  normalizeSampleExt,
  readProjectFile,
  writeProjectFile,
  type EmbeddedSample,
} from './project-file';
import { encodeWav } from './wav';

const FIXTURES = import.meta.glob<unknown>('/test/fixtures/projects/*.json', { eager: true, import: 'default' });
const fixture = (name: string) =>
  JSON.parse(JSON.stringify(FIXTURES[`/test/fixtures/projects/${name}.json`])) as Project;
const basic = () => fixture('v3-basic');

const NOW = new Date('2026-10-12T10:30:00.000Z');
const VIEW = { mode: 'song', currentPatternId: 'pat_intro00001', windows: { mixer: { visible: true, z: 3 } } };

async function sampleOf(bytes: Uint8Array, ext: string): Promise<[string, EmbeddedSample]> {
  return [await sha256Hex(bytes), { ext, bytes }];
}

function entriesInfo(zip: Uint8Array) {
  const info: Record<string, { compression: number; size: number; originalSize: number }> = {};
  unzipSync(zip, {
    filter: (f) => {
      info[f.name] = { compression: f.compression, size: f.size, originalSize: f.originalSize };
      return false;
    },
  });
  return info;
}

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const z: Zippable = {};
  for (const [name, v] of Object.entries(files)) z[name] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(z);
}

function errorOf(fn: () => unknown): ProjectFileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectFileError);
    return e as ProjectFileError;
  }
  throw new Error('expected a ProjectFileError');
}

describe('writeProjectFile / readProjectFile', () => {
  it('round-trips project, view, meta and sample bytes', async () => {
    const project = basic();
    const wav = encodeWav([Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 10))], 44100, { bitDepth: 16 });
    const other = Uint8Array.from({ length: 777 }, (_, i) => (i * 37) & 0xff);
    const samples = new Map([await sampleOf(wav, 'wav'), await sampleOf(other, 'aif')]);
    const bytes = writeProjectFile({ project, view: VIEW, samples, appVersion: '0.2.0', now: NOW });

    const read = readProjectFile(bytes);
    expect(read.project).toEqual(project);
    expect(read.view).toEqual(VIEW);
    expect(read.meta).toEqual({ format: 1, appVersion: '0.2.0', savedAt: '2026-10-12T10:30:00.000Z' });
    expect(read.repairs).toEqual([]);
    expect(read.migratedFrom).toBe(SCHEMA_VERSION);
    expect([...read.samples.keys()].sort()).toEqual([...samples.keys()].sort());
    for (const [hash, s] of samples) {
      const got = read.samples.get(hash)!;
      expect(got.ext).toBe(s.ext);
      expect(got.bytes).toEqual(s.bytes); // byte-exact
      expect(await sha256Hex(got.bytes)).toBe(hash);
    }
  });

  it('deflates the JSON entries and stores audio uncompressed', async () => {
    const project = basic();
    const wav = encodeWav([new Float32Array(4000)], 44100, { bitDepth: 16 }); // silence: very compressible
    const [hash, sample] = await sampleOf(wav, 'wav');
    const info = entriesInfo(
      writeProjectFile({ project, view: VIEW, samples: new Map([[hash, sample]]), appVersion: '1', now: NOW }),
    );
    expect(Object.keys(info)).toEqual(['meta.json', 'project.json', 'view.json', `samples/${hash}.wav`]);
    for (const name of ['meta.json', 'project.json', 'view.json']) expect(info[name]!.compression).toBe(8);
    expect(info['project.json']!.size).toBeLessThan(info['project.json']!.originalSize / 2);
    expect(info[`samples/${hash}.wav`]).toEqual({ compression: 0, size: wav.length, originalSize: wav.length });
  });

  it('is deterministic for the same input and time', () => {
    const input = { project: basic(), view: VIEW, samples: new Map(), appVersion: '1', now: NOW };
    expect(writeProjectFile(input)).toEqual(writeProjectFile(input));
  });

  it('accepts dates outside the zip timestamp range', () => {
    const bytes = writeProjectFile({
      project: basic(),
      view: null,
      samples: new Map(),
      appVersion: '1',
      now: new Date(0),
    });
    expect(readProjectFile(bytes).meta.savedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('writes a project made by createEmptyProject that reads back unchanged', () => {
    setIdSource(seededBytes(1));
    const project = createEmptyProject({ now: NOW });
    const read = readProjectFile(writeProjectFile({ project, view: undefined, samples: new Map(), appVersion: '1' }));
    expect(read.project).toEqual(project);
    expect(read.view).toBeNull();
  });

  it('validates hashes and extensions on write', () => {
    const write = (hash: string, ext: string) =>
      writeProjectFile({
        project: basic(),
        view: null,
        samples: new Map([[hash, { ext, bytes: new Uint8Array(1) }]]),
        appVersion: '1',
      });
    expect(() => write('abc', 'wav')).toThrow(TypeError);
    expect(() => write('a'.repeat(64), 'w/v')).toThrow(TypeError);
    expect(() => write('a'.repeat(64), '.WAV')).not.toThrow();
    expect(normalizeSampleExt('.AIFF')).toBe('aiff');
    expect(normalizeSampleExt('')).toBeNull();
    expect(normalizeSampleExt('toolongextension')).toBeNull();
  });

  it('repairs a broken project and reports it', () => {
    const broken = FIXTURES['/test/fixtures/projects/v1-broken.json'];
    const read = readProjectFile(
      zip({
        'meta.json': JSON.stringify({ format: 1, appVersion: '0.1.0', savedAt: '' }),
        'project.json': JSON.stringify(broken),
      }),
    );
    expect(read.repairs.length).toBeGreaterThan(5);
    expect(read.project.transport.bpm).toBe(522);
    expect(read.view).toBeNull();
  });

  it('runs migrations for older project versions', () => {
    const v1 = fixture('v1-basic');
    const v0 = { ...v1, schemaVersion: 0, transport: { tempo: 128 } };
    const m0: Migration = (p) => ({
      ...p,
      transport: { bpm: (p.transport as { tempo: number }).tempo, timeSig: { num: 4, den: 4 }, swing: 0.2 },
    });
    const read = readProjectFile(zip({ 'meta.json': '{"format":1}', 'project.json': JSON.stringify(v0) }), {
      migrations: [m0, ...MIGRATIONS.slice(1)],
    });
    expect(read.migratedFrom).toBe(0);
    expect(read.project).toEqual(migrateProject(v1).project);
    expect(read.repairs).toEqual([]);
  });

  it('upgrades a v1 file with the built-in migrations', () => {
    const read = readProjectFile(
      zip({ 'meta.json': '{"format":1}', 'project.json': JSON.stringify(fixture('v1-basic')) }),
    );
    expect(read.migratedFrom).toBe(1);
    expect(read.project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(read.repairs).toEqual([]);
  });

  it('tolerates a missing or damaged meta.json and view.json', () => {
    const project = JSON.stringify(basic());
    const noMeta = readProjectFile(zip({ 'project.json': project }));
    expect(noMeta.meta.format).toBe(1);
    expect(noMeta.repairs).toEqual(['The file had no format information; it was read as a version 1 project file.']);
    const badMeta = readProjectFile(zip({ 'meta.json': '{nope', 'project.json': project, 'view.json': '[1, 2' }));
    expect(badMeta.repairs).toEqual([
      "The file's format information was damaged; it was read as a version 1 project file.",
      "The saved window layout couldn't be read and was reset.",
    ]);
    expect(badMeta.view).toBeNull();
    const bom = readProjectFile(
      zip({ 'meta.json': '﻿{"format":1,"appVersion":"x","savedAt":"y"}', 'project.json': project }),
    );
    expect(bom.meta).toEqual({ format: 1, appVersion: 'x', savedAt: 'y' });
  });

  it('ignores unrelated entries and keeps the first copy of a sample', () => {
    const hash = 'b'.repeat(64);
    const read = readProjectFile(
      zip({
        'project.json': JSON.stringify(basic()),
        'meta.json': '{"format":1}',
        'notes.txt': 'hello',
        'samples/': new Uint8Array(0),
        'samples/not-a-hash.wav': new Uint8Array(3),
        [`samples/${hash}.WAV`]: Uint8Array.from([1, 2, 3]),
      }),
    );
    expect([...read.samples.entries()]).toEqual([[hash, { ext: 'wav', bytes: Uint8Array.from([1, 2, 3]) }]]);
  });
});

describe('readProjectFile errors', () => {
  const project = () => JSON.stringify(basic());

  it('rejects files that are not zips', () => {
    for (const bytes of [
      new Uint8Array(0),
      strToU8('{"schemaVersion":1}'),
      strToU8('RIFF....WAVEfmt ' + ' '.repeat(40)),
    ]) {
      const err = errorOf(() => readProjectFile(bytes));
      expect(err.code).toBe('not-a-project-file');
      expect(err.message).toBe('This file is not an AGstudio project (.agproj).');
    }
  });

  it('rejects truncated or corrupted archives', () => {
    const good = writeProjectFile({ project: basic(), view: null, samples: new Map(), appVersion: '1', now: NOW });
    expect(errorOf(() => readProjectFile(good.subarray(0, good.length - 30))).code).toBe('damaged');
    const corrupt = good.slice();
    const info = entriesInfo(good);
    expect(info['project.json']!.compression).toBe(8);
    // Scribble over the middle of the archive (inside the deflated project.json).
    corrupt.fill(0xff, 200, 260);
    const err = errorOf(() => readProjectFile(corrupt));
    expect(['damaged', 'invalid-json', 'invalid-project']).toContain(err.code);
  });

  it('needs project.json', () => {
    const err = errorOf(() => readProjectFile(zip({ 'meta.json': '{"format":1}', 'view.json': '{}' })));
    expect(err.code).toBe('missing-project');
    expect(err.message).toBe('This project file is incomplete: it contains no project data.');
    expect(errorOf(() => readProjectFile(zipSync({}))).code).toBe('missing-project');
  });

  it('reports invalid JSON', () => {
    const err = errorOf(() =>
      readProjectFile(zip({ 'meta.json': '{"format":1}', 'project.json': '{"schemaVersion": 1,' })),
    );
    expect(err.code).toBe('invalid-json');
    expect(err.message).toBe("This project file is damaged: its project data can't be read.");
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('reports JSON that is not a project', () => {
    for (const json of ['[]', '{"schemaVersion":1}', '"hello"']) {
      const err = errorOf(() => readProjectFile(zip({ 'project.json': json })));
      expect(err.code).toBe('invalid-project');
      expect(err.message).toBe("This project file is damaged: its project data isn't valid.");
    }
  });

  it('refuses newer file formats and project versions', () => {
    const format = errorOf(() => readProjectFile(zip({ 'meta.json': '{"format":2}', 'project.json': project() })));
    expect(format.code).toBe('newer-format');
    expect(format.message).toBe(
      'This project was saved by a newer version of AGstudio (file format 2). Update AGstudio to open it.',
    );
    const newer = JSON.stringify({ ...basic(), schemaVersion: SCHEMA_VERSION + 1 });
    const schema = errorOf(() => readProjectFile(zip({ 'meta.json': '{"format":1}', 'project.json': newer })));
    expect(schema.code).toBe('newer-version');
    expect(schema.message).toBe(
      `This project was saved by a newer version of AGstudio (project version ${SCHEMA_VERSION + 1}; this version opens up to ${SCHEMA_VERSION}). Update AGstudio to open it.`,
    );
  });

  it('refuses old project versions it cannot convert', () => {
    const old = JSON.stringify({ ...basic(), schemaVersion: 0 });
    const err = errorOf(() => readProjectFile(zip({ 'project.json': old })));
    expect(err.code).toBe('unsupported-version');
    expect(err.message).toBe(
      "This project uses an old project version (0) that this version of AGstudio can't convert.",
    );
  });
});
