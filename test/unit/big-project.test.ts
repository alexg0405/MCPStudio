/**
 * The very big project (`app/fixtures/huge-song.ts`: 200 channels, 100 mixer tracks, 500 patterns, 2,000 clips) stays
 * quick where Node can see it: reading and writing the file, and writing the text the AI reads each turn. The browser
 * side (engine nodes, frame cost) is `test/browser/big-project.test.ts`; the numbers behind these limits are in
 * docs/architecture.md, "Big projects". The regular run shares its cores with the whole suite and keeps loose bounds
 * (`perfLimit`); `npm run test:perf` holds the real ones.
 */
import { produce } from 'immer';
import { beforeAll, describe, expect, it } from 'vitest';
import { projectFileParts, readProjectFile, zipProjectFileParts } from '@core/io/project-file';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { buildHugeSong } from '../../src/app/fixtures/huge-song';
import { projectContext } from '../../src/app/ai/context';
import { createTestServices } from '../../src/app/testing';
import { cpuNow, perfLimit, settle } from '../helpers/perf';

let services: ReturnType<typeof createTestServices>;
let project: Project;

beforeAll(() => {
  const previous = setIdSource(seededBytes(7));
  try {
    services = createTestServices();
    services.history.transact('huge', (draft) => void buildHugeSong(draft));
    project = services.doc.getState().project;
  } finally {
    setIdSource(previous);
  }
});

/** The same project as a new object, so nothing remembered about the old one (a text, an answer) is reused. */
let touches = 0;
const nextSwing = (): number => (++touches % 1000) / 100_000;
const freshCopy = (): Project => produce(project, (draft) => void (draft.transport.swing = nextSwing()));

describe('a very big project', () => {
  it('has the shape the speed limits are for', () => {
    expect(project.channelOrder.length).toBeGreaterThanOrEqual(260);
    expect(project.patternOrder).toHaveLength(500);
    expect(Object.keys(project.playlist.clips)).toHaveLength(2000);
    expect(project.mixer.order).toHaveLength(101);
  });

  it('writes the project file (JSON and zip) in a moment', { tags: ['perf'], timeout: 120_000 }, async () => {
    const limitMs = perfLimit(300, 5000);
    const best = await settle(
      () => {
        const copy = freshCopy();
        const t0 = cpuNow();
        zipProjectFileParts(projectFileParts({ project: copy, view: {}, samples: new Map(), appVersion: 'test' }));
        return cpuNow() - t0;
      },
      (ms) => ms <= limitMs,
    );
    expect(best).toBeLessThanOrEqual(limitMs);
  });

  it('reads the project file (parse, migrate, repair) in a moment', { tags: ['perf'], timeout: 120_000 }, async () => {
    const bytes = zipProjectFileParts(projectFileParts({ project, view: {}, samples: new Map(), appVersion: 'test' }));
    const limitMs = perfLimit(450, 6000);
    const best = await settle(
      () => {
        const t0 = cpuNow();
        const read = readProjectFile(bytes);
        const ms = cpuNow() - t0;
        expect(read.project.patternOrder).toHaveLength(500);
        return ms;
      },
      (ms) => ms <= limitMs,
    );
    expect(best).toBeLessThanOrEqual(limitMs);
  });

  it('writes the AI context for a new project version in well under a second, and again for the same version far quicker', { tags: ['perf'], timeout: 120_000 }, async () => {
    const limits = { first: perfLimit(700, 6000), again: perfLimit(120, 1500) };
    const first = await settle(
      () => {
        // A new project object each time (the answers worked out for one project version are remembered for it).
        services.history.transact('touch', (draft) => void (draft.transport.swing = nextSwing()));
        const t0 = cpuNow();
        projectContext(services);
        return cpuNow() - t0;
      },
      (ms) => ms <= limits.first,
    );
    expect(first).toBeLessThanOrEqual(limits.first);
    const again = await settle(
      () => {
        const t0 = cpuNow();
        projectContext(services);
        return cpuNow() - t0;
      },
      (ms) => ms <= limits.again,
    );
    expect(again).toBeLessThanOrEqual(limits.again);
  });

  it('writes the same context text again for the same project version', () => {
    const text = projectContext(services);
    expect(projectContext(services)).toBe(text);
    expect(text).toContain('Channels (channel rack order):');
    expect(text.length).toBeGreaterThan(20_000);
  });
});
