/**
 * The EDM pack's usual songs (`core/arrange/shapes.ts`) applied for real: two beats from the offline generator
 * and one arrange with the style's sections must flow (no structural arrangement bug), come out as one undo
 * step with the mix set up, and mark every section.
 */
import { describe, expect, it } from 'vitest';
import { generateLocalBeat } from '@core/beat/local';
import { STYLE_LABELS, type Style } from '@core/beat/style';
import { SONG_SHAPES } from '@core/arrange/shapes';
import { applyAnswer } from './ai/apply';
import type { AiAction } from './ai/schema';
import { checkArrangement } from './arrange/check';
import { createTestServices } from './testing';

const PACK = ['bigroom', 'proghouse', 'futurebass', 'dubstep', 'melodicdub', 'techhouse', 'trance', 'dnb'] as const satisfies readonly Style[];

/** Bugs that don't depend on how loud each section is guessed to be (the arranger checks the rest against its plan). */
const STRUCTURAL = new Set(['stacked', 'layered-fill', 'static-loop', 'silent', 'crash-spam']);

describe('EDM pack: a song in each style’s usual shape', () => {
  it.each(PACK.map((s) => [s] as const))('%s', (style) => {
    const shape = SONG_SHAPES[style]!;
    const beat = (ref: string, prompt: string) => {
      const { message: _m, ...rest } = generateLocalBeat({ prompt, bpm: 120 });
      return { op: 'beat', pattern: 'new', ref, style, ...rest } as AiAction;
    };
    const sections = shape.map((x) => ({
      name: x.name,
      role: x.role,
      bars: x.bars,
      energy: x.energy,
      play: [x.role === 'drop' || x.role === 'build' ? '@drop' : '@verse'],
      ...(x.without ? { without: [...x.without] } : {}),
    }));
    const s = createTestServices();
    const steps = s.history.steps().done.length;
    const res = applyAnswer(
      s,
      { message: 'A song.', actions: [beat('@verse', STYLE_LABELS[style]), beat('@drop', `${STYLE_LABELS[style]} busier`), { op: 'arrange', style, mix: 'auto', sections } as AiAction] },
      { previousBeat: null },
    );
    expect(res.warnings).toEqual([]);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    const p = s.doc.getState().project;
    const bugs = checkArrangement(s, p, { style }).filter((f) => f.severity === 'bug' && STRUCTURAL.has(f.code));
    expect(bugs.map((b) => `${b.code}: ${b.message}`)).toEqual([]);
    expect(Object.values(p.playlist.markers).map((m) => m.name).sort()).toEqual(shape.map((x) => x.name).sort());
    expect(res.after.filter((a) => a.kind === 'level_mix')).toHaveLength(1);
  });
});
