import { describe, expect, it } from 'vitest';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { notesHash } from '@core/arrange/notes';
import type { Clip, PatternClip, Project } from '@core/model/types';
import { songCheck } from '@core/query/arrangement';
import { checkArrangement } from '../../arrange/check';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { STUDIO_PROMPT } from '../prompt';
import { ACTION_OPS, type AiAction } from '../schema';
import { SONG_EXAMPLE } from './arrange-prompt';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[], message = 'ok') => applyAnswer(s, { message, actions }, { previousBeat: null });
const project = (s: S) => s.doc.getState().project;
const clips = (p: Project) => Object.values(p.playlist.clips) as Clip[];
const counts = (p: Project) => ({
  patterns: Object.keys(p.patterns).length,
  clips: Object.keys(p.playlist.clips).length,
  channels: Object.keys(p.channels).length,
  samples: Object.keys(p.samples).length,
  markers: Object.keys(p.playlist.markers).length,
  inserts: p.mixer.order.length,
});

/** Whether the beat action can write several new patterns in one answer (`pattern: "new"`, `ref`). */
const beatMakesNewPatterns = () => {
  const beat = ACTION_OPS.find((o) => o.properties.op.const === 'beat')!;
  return 'pattern' in beat.properties && 'ref' in beat.properties;
};

/**
 * Applies the prompt's example song. With a beat action that writes a new pattern per beat it is one
 * answer, exactly as written; until then each beat is its own answer and the arrange names them.
 */
function applyExample(s: S): { warnings: string[]; changes: string[]; answers: number } {
  const actions = JSON.parse(JSON.stringify(SONG_EXAMPLE.actions)) as AiAction[];
  if (beatMakesNewPatterns()) {
    const res = run(s, actions, SONG_EXAMPLE.message);
    return { warnings: res.warnings, changes: res.changes, answers: 1 };
  }
  const titles = new Map<string, string>();
  const warnings: string[] = [];
  const changes: string[] = [];
  let answers = 0;
  for (const a of actions) {
    if (a.op === 'beat') titles.set(String(a.ref), String(a.title));
    if (a.op === 'arrange') {
      const sections = (a.sections as { play: string[] }[]).map((x) => ({ ...x, play: x.play.map((r) => titles.get(r) ?? r) }));
      a.sections = sections;
    }
    const res = run(s, [a]);
    warnings.push(...res.warnings);
    changes.push(...res.changes);
    answers++;
  }
  return { warnings, changes, answers };
}

describe('the song-craft prompt and its example', () => {
  it('the prompt carries the section rules and the example verbatim', () => {
    expect(STUDIO_PROMPT).toContain('Song craft');
    expect(STUDIO_PROMPT).toContain(JSON.stringify(SONG_EXAMPLE));
    // The section comes right after the playlist editing rules (order 15 → 20 → 80).
    expect(STUDIO_PROMPT.indexOf('Playlist editing')).toBeLessThan(STUDIO_PROMPT.indexOf('Song craft'));
    expect(STUDIO_PROMPT.indexOf('Song craft')).toBeLessThan(STUDIO_PROMPT.indexOf('Beat writing'));
  });

  it('the example applies with no warnings, as one undo step, and the arrangement check finds no bugs', () => {
    const s = createTestServices();
    const before = s.history.steps().done.length;
    const res = applyExample(s);
    expect(res.warnings).toEqual([]);
    expect(s.history.steps().done.length - before).toBe(res.answers);
    const summary = res.changes.find((c) => c.startsWith('Arranged'))!;
    expect(summary).toMatch(
      /^Arranged 76 bars: Intro 1–8 · Verse 9–16 · Verse 2 17–24 · Build 25–28 · Drop 29–44 · Break 45–52 · Drop 2 53–68 · Outro 69–76 · \d+ fills, 3 builds \(riser, gap, impact\), 1 breakdown, outro stop$/,
    );
    const p = project(s);
    expect(Object.values(p.playlist.markers).map((m) => m.name).sort()).toEqual(['Break', 'Build', 'Drop', 'Drop 2', 'Intro', 'Outro', 'Verse', 'Verse 2']);
    expect(checkArrangement(s, p, { style: 'trap' }).filter((f) => f.severity === 'bug')).toEqual([]);
    expect(songCheck(p).filter((i) => i.kind === 'stacked' || i.kind === 'doubled')).toEqual([]);
    // It asks for song mode and the mix to be leveled after.
  });
});

describe('arrange', () => {
  function beats() {
    const s = createTestServices();
    applyExample(s);
    return s;
  }
  const sections = (names: Record<string, string>) => [
    { name: 'Intro', role: 'intro', bars: 4, play: [names.intro] },
    { name: 'Drop', role: 'drop', bars: 8, play: [names.drop, names.intro] },
    { name: 'Break', role: 'break', bars: 4, play: [names.intro] },
    { name: 'Drop 2', role: 'drop', bars: 8, play: [names.drop, names.intro] },
  ];
  const names = { intro: 'Intro keys', drop: 'Drop beat' };

  it('arranging twice gives the same patterns, clips, channels and tracks', () => {
    const s = beats();
    const first = run(s, [{ op: 'arrange', style: 'trap', sections: sections(names) }]);
    expect(first.warnings).toEqual([]);
    expect(first.after).toEqual(expect.arrayContaining([{ kind: 'mode', mode: 'song' }, expect.objectContaining({ kind: 'level_mix', style: 'trap', fromTick: 0, bars: 24 })]));
    const once = counts(project(s));
    const second = run(s, [{ op: 'arrange', style: 'trap', sections: sections(names) }]);
    expect(second.warnings).toEqual([]);
    expect(counts(project(s))).toEqual(once);
  });

  it('resolves every reference before changing anything', () => {
    const s = beats();
    const before = project(s);
    const res = run(s, [{ op: 'arrange', sections: [{ name: 'Intro', bars: 4, play: ['Intro keys'] }, { name: 'Drop', bars: 8, play: ['Nope'] }] }]);
    expect(res.warnings).toEqual(['arrange: “Drop”: there is no pattern "Nope"']);
    expect(project(s)).toBe(before);
    const parts = run(s, [{ op: 'arrange', sections: [{ name: 'Intro', bars: 4, play: ['Intro keys'], without: ['kazoo'] }] }]);
    expect(parts.warnings[0]).toMatch(/“Intro”: "kazoo" is neither a part/);
    const big = run(s, [{ op: 'arrange', sections: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, bars: 64, play: ['Intro keys'] })) }]);
    expect(big.warnings).toEqual(['arrange: an arrangement holds up to 512 bars (these sections add up to 576)']);
  });

  it('editing a source rebuilds its unmodified variants and leaves hand-edited ones', () => {
    const s = beats();
    run(s, [{ op: 'arrange', style: 'trap', sections: sections(names) }]);
    const p = project(s);
    const drop = Object.values(p.patterns).find((x) => x.name === 'Drop beat')!;
    const variants = Object.values(p.patterns).filter((x) => x.derived?.from === drop.id);
    expect(variants.length).toBeGreaterThanOrEqual(2);
    const [mine, theirs] = variants;
    // The musician edits one variant by hand.
    run(s, [{ op: 'write_notes', pattern: theirs!.id, channel: 'Clap', notes: [{ step: 4 }, { step: 12 }] }]);
    const edited = project(s).patterns[theirs!.id]!;
    expect(notesHash(edited.notes)).not.toBe(edited.derived!.hash);
    // The AI rewrites the source's claps.
    const res = run(s, [{ op: 'write_notes', pattern: 'Drop beat', channel: 'Clap', notes: [{ step: 8 }, { step: 20 }, { step: 24 }] }]);
    expect(res.changes.some((c) => /^Rebuilt \d+ variations? of “Drop beat” to follow the new notes \(1 edited by hand stay as they are\)$/.test(c))).toBe(true);
    const q = project(s);
    const clapId = Object.values(q.channels).find((c) => c.name === 'Clap')!.id;
    const claps = Object.values(q.patterns[mine!.id]!.notes[clapId] ?? {}).map((n) => n.tick);
    expect(claps).toEqual(expect.arrayContaining([20 * 240]));
    expect(q.patterns[theirs!.id]!.notes).toEqual(edited.notes);
    // One undo step undoes the edit and the rebuild together.
    s.history.undo();
    expect(project(s).patterns[mine!.id]).toEqual(p.patterns[mine!.id]);
  });
});

describe('develop, transition and vary', () => {
  it('develop on the stacked song: one undo step, no stacked parts left, gaps before the drops', () => {
    const s = createTestServices();
    s.history.transact('song', (d) => {
      buildStackedSong(d);
    });
    const res = run(s, [{ op: 'develop', style: 'trap' }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]).toMatch(/^Developed bars 1–112: /);
    expect(s.history.steps().done.map((e) => e.label)).toEqual(['song', 'AI: ok']);
    const p = project(s);
    expect(songCheck(p).filter((i) => i.kind === 'stacked')).toEqual([]);
    const bugs = checkArrangement(s, p, { style: 'trap' }).filter((f) => f.severity === 'bug').map((f) => f.code);
    expect(bugs).not.toContain('no-gap');
    expect(bugs).not.toContain('layered-fill');
    expect(bugs).not.toContain('crash-spam');
    expect(res.touched).toEqual({ from: 0, to: 112 * 3840 });
  });

  it('vary makes a variant of a pattern that later actions place by ref; transition adds one recipe', () => {
    const s = createTestServices();
    applyExample(s);
    const res = run(s, [
      { op: 'vary', kind: 'fill', pattern: 'Drop beat', ref: '@dropFill' },
      { op: 'place_pattern', pattern: '@dropFill', bar: 81, track: 30 },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]).toMatch(/^Made “Drop beat · (fill|hat fill|kick fill|tom fill)( \d+)?”$/);
    const placed = clips(project(s)).filter((c): c is PatternClip => c.kind === 'pattern' && c.start === 80 * 3840);
    expect(project(s).patterns[placed[0]!.patternId]!.derived).toBeDefined();
    const t = run(s, [{ op: 'transition', bar: 81, kind: 'riser' }]);
    expect(t.changes).toEqual(['Added riser at bar 81']);
    const again = run(s, [{ op: 'transition', bar: 81, kind: 'riser' }]);
    expect(again.changes).toEqual(['Riser at bar 81: already there (nothing added)']);
    const v = run(s, [{ op: 'vary', kind: 'hat_roll', bar: 12 }]);
    expect(v.changes[0]).toMatch(/^Added a hat roll at the end of bar 12/);
    const bad = run(s, [{ op: 'vary', kind: 'wobble', bar: 3 }]);
    expect(bad.warnings).toEqual(['vary: unknown variation "wobble"']);
  });
});
