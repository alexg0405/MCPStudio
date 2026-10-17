import { describe, expect, it } from 'vitest';
import { readProjectFile, writeProjectFile, type WriteProjectFileInput } from '@core/io/project-file';
import { createEmptyProject } from '@core/model/defaults';
import { writeProjectFileOffThread } from './zip-async';

const input = (): WriteProjectFileInput => ({
  project: createEmptyProject({ title: 'Song', now: new Date(0) }),
  view: { mode: 'pattern', n: [1, 2, 3] },
  samples: new Map(),
  appVersion: '0.1.0',
  now: new Date('2026-10-12T12:00:00.000Z'),
});

describe('writeProjectFileOffThread (no Workers here: the same zip, made on this thread)', () => {
  it('is byte-identical to writeProjectFile and reads back', async () => {
    const inp = input();
    const a = writeProjectFile(inp);
    const b = await writeProjectFileOffThread(inp);
    expect(b).toEqual(a);
    expect(readProjectFile(b).project.meta.title).toBe('Song');
  });
});
