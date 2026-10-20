/**
 * The Studio answer `set_reference` + `match_reference` in headless Chrome: the reference file is stored like any imported song,
 * analyzed after the answer, matched (tempo, sections) and leveled, as one undo step. It is a file of its own (the rest of the
 * reference tests are in `reference.test.ts`) so the two heavy chains of renders run side by side.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyAnswer } from '@app/ai/apply';
import { afterStepFor } from '@app/assistant/after-steps';
import { forgetReferences } from '@app/reference/analyze';
import { createServices, type Services } from '@app/services';
import { songSections } from '@core/query/sections';
import { loudnessTarget } from '@core/reference/track';
import { buildSong } from '../helpers/mix-level';
import { BAR, loudnessOfBusiestPart, referenceFile } from '../helpers/reference-song';

const services: Services[] = [];
afterAll(async () => {
  for (const s of services) await s.engine.dispose();
});

describe('reference track matching through the Studio (headless Chrome, real analysis and renders)', () => {
  const file = referenceFile();

  it('Studio: set_reference and match_reference in one answer: analyzed after it, matched, leveled, one undo step', async () => {
    const s2 = createServices();
    services.push(s2);
    buildSong(s2, 'house', { bpm: 124, low: 'bass' });
    const before = s2.doc.getState().project;
    // The file is stored like any other (the music library does this).
    const { songFromBytes, library } = await import('@app/dj/library');
    const song = await songFromBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    library.setState({ songs: [song!], selected: [] });
    forgetReferences();
    const res = applyAnswer(
      s2,
      { message: 'Like your reference', actions: [{ op: 'set_reference', song: 'Reference' }, { op: 'match_reference' }] },
      { previousBeat: null, label: 'like my reference' },
    );
    expect(res.warnings).toEqual([]);
    expect(res.after.map((a) => a.kind)).toEqual(['set_reference', 'match_reference']);
    let entry: number | null = res.edited ? s2.history.status().cursor : null;
    const progress: string[] = [];
    const messages: string[] = [];
    for (const item of res.after) {
      const step = afterStepFor(item.kind)!;
      const was = s2.history.status().cursor;
      const out = await step(item, {
        s: s2,
        entry,
        signal: new AbortController().signal,
        progress: (label) => progress.push(label),
        whenQuiet: async () => {},
      });
      if (entry === null && s2.history.status().cursor !== was) entry = s2.history.status().cursor;
      messages.push(...[out?.message ?? '', ...(out?.changes ?? [])]);
    }
    library.setState({ songs: [], selected: [] });
    const p = s2.doc.getState().project;
    console.log(`Studio match:\n  ${messages.join('\n  ')}`);
    expect(p.reference?.title).toBe(song!.label);
    expect(p.transport.bpm).toBe(128);
    expect(songSections(p).map((x) => x.from / BAR + 1)).toEqual([1, 17, 49, 65]);
    const heard = await loudnessOfBusiestPart(s2);
    console.log(`Studio match loudness: ${heard.lufs.toFixed(2)} LUFS, true peak ${heard.truePeakDb!.toFixed(2)} dBTP`);
    expect(Math.abs(heard.lufs - loudnessTarget(p.reference!))).toBeLessThanOrEqual(0.5);
    expect(heard.truePeakDb!).toBeLessThanOrEqual(-0.95);
    expect(progress).toContain('The mix');
    // Setting the reference, matching it and leveling are one undo step.
    expect(s2.history.steps().done.filter((e) => /like my reference|Set the reference|Match the reference|Level the mix/.test(e.label)).length).toBe(1);
    s2.history.undo();
    expect(s2.doc.getState().project).toEqual(before);
  }, 600_000);
});
