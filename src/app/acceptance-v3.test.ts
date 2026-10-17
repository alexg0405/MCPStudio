/**
 * v3 acceptance ("the minimum"): in every style, a song the AI would build — three beats and one
 * arrange — applies cleanly as one undo step, flows (the arrangement check finds no bugs: no stacked
 * parts, fills replace the groove, gaps and risers before drops…) and gets its mix set up (role
 * buses, the bass ducking under the kick, a Limiter last on the master, leveling requested).
 */
import { describe, expect, it } from 'vitest';
import { generateLocalBeat } from '@core/beat/local';
import { STYLES, type Style } from '@core/beat/style';
import { MASTER } from '@core/model/types';
import { applyAnswer } from './ai/apply';
import type { AiAction } from './ai/schema';
import { checkArrangement } from './arrange/check';
import { findMixLayout } from './mix/layout';
import { createTestServices } from './testing';

const WORDS: Record<Style, string> = {
  trap: 'trap',
  drill: 'uk drill',
  boombap: 'boom bap',
  lofi: 'lofi chill',
  house: 'house',
  edm: 'edm',
  reggaeton: 'reggaeton',
  afro: 'afrobeats',
  pop: 'pop',
  bigroom: 'big room',
  proghouse: 'progressive house',
  futurebass: 'future bass',
  dubstep: 'dubstep',
  melodicdub: 'melodic dubstep',
  techhouse: 'tech house',
  trance: 'trance',
  dnb: 'drum and bass',
};

function song(style: Style): AiAction[] {
  const beat = (ref: string, prompt: string) => {
    const spec = generateLocalBeat({ prompt, bpm: 130 });
    const { message: _m, ...rest } = spec;
    return { op: 'beat', pattern: 'new', ref, style, ...rest } as AiAction;
  };
  return [
    beat('@verse', WORDS[style]),
    beat('@drop', `${WORDS[style]} busier`),
    {
      op: 'arrange',
      style,
      mix: 'auto',
      sections: [
        { name: 'Intro', role: 'intro', bars: 4, energy: 2, play: ['@verse'], without: ['drums', 'bass'] },
        { name: 'Verse', role: 'verse', bars: 8, energy: 3, play: ['@verse'] },
        { name: 'Build', role: 'build', bars: 4, energy: 3, play: ['@verse'], without: ['bass'] },
        { name: 'Drop', role: 'drop', bars: 8, energy: 5, play: ['@drop'] },
        { name: 'Break', role: 'break', bars: 4, energy: 2, play: ['@verse'], without: ['drums'] },
        { name: 'Outro', role: 'outro', bars: 4, energy: 1, play: ['@verse'], without: ['bass'] },
      ],
    },
  ];
}

/** Bugs that don't depend on how loud each section is guessed to be (the arranger checks the rest against its plan). */
const STRUCTURAL = new Set(['stacked', 'layered-fill', 'static-loop', 'silent', 'crash-spam']);

describe('v3 acceptance: every style comes out flowing and mixed', () => {
  it.each(STYLES.map((s) => [s] as const))('%s', (style) => {
    const s = createTestServices();
    const steps = s.history.steps().done.length;
    const res = applyAnswer(s, { message: 'A song.', actions: song(style) }, { previousBeat: null });
    expect(res.warnings).toEqual([]);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    const p = s.doc.getState().project;
    // It flows: nothing the checker counts as a bug.
    const bugs = checkArrangement(s, p, { style }).filter((f) => f.severity === 'bug' && STRUCTURAL.has(f.code));
    expect(bugs.map((b) => `${b.code}: ${b.message}`)).toEqual([]);
    // The sections are marked, and the song is as long as they are.
    expect(Object.values(p.playlist.markers).map((m) => m.name).sort()).toEqual(['Break', 'Build', 'Drop', 'Intro', 'Outro', 'Verse']);
    // Its mix is set up by role, the Limiter last on the master, and leveling runs after the answer.
    const layout = findMixLayout(p);
    expect(layout.buses.kick && layout.buses.drums && layout.buses.bass).toBeTruthy();
    const master = p.mixer.inserts[MASTER]!.fx;
    expect(master.at(-1)?.plugin.pluginId).toBe('agstudio.limiter');
    expect(res.after.filter((a) => a.kind === 'level_mix')).toHaveLength(1);
    // And it plays from just before what changed, in song mode.
    expect(res.touched?.from).toBe(0);
  });
});
