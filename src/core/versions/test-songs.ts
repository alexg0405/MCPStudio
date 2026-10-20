/**
 * Small songs for the tests of versions and the project list: an empty project with a few clips, a new pattern or a
 * different fader, built with Immer the way edits are. Not used by the app.
 */
import { produce } from 'immer';
import { createEmptyProject, makePattern, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import type { PatternClip, PatternId, Project, Tick } from '../model/types';

const BAR = 3840;

/** A project made the same way every time (give `title` to tell two apart). */
export function emptySong(title = 'Test song'): Project {
  return createEmptyProject({ title, now: new Date('2026-01-01T00:00:00Z') });
}

/** Puts a pattern clip of `patternId` on the first track, `bars` long from bar `startBar` (0-based). */
export function withClip(project: Project, patternId: PatternId, startBar: number, bars = 1): Project {
  return produce(project, (draft) => {
    const laneId = draft.playlist.laneOrder[0]!;
    const id = newId.clip();
    const clip: PatternClip = { kind: 'pattern', id, laneId, patternId, start: startBar * BAR, length: bars * BAR, offset: 0 };
    draft.playlist.clips[id] = clip;
  });
}

/** Adds a pattern called `name` and returns the project and the pattern's id. */
export function withPattern(project: Project, name: string): { project: Project; patternId: PatternId } {
  const pattern = makePattern(name, paletteColor(project.patternOrder.length));
  const next = produce(project, (draft) => {
    draft.patterns[pattern.id] = pattern;
    draft.patternOrder.push(pattern.id);
  });
  return { project: next, patternId: pattern.id };
}

/** A song with `clips` one-bar clips of its first pattern in a row. */
export function songWithClips(clips: number, title?: string): Project {
  let project = emptySong(title);
  const patternId = project.patternOrder[0]!;
  for (let bar = 0; bar < clips; bar++) project = withClip(project, patternId, bar);
  return project;
}

/** Sets a mixer track's fader (linear gain) by its position in the mixer (1 is the first track after the master). */
export function withFader(project: Project, trackNumber: number, volume: number): Project {
  return produce(project, (draft) => {
    const id = draft.mixer.order[trackNumber]!;
    draft.mixer.inserts[id]!.volume = volume;
  });
}

/** The tick of a bar, for assertions about clips. */
export const barTick = (bar: number): Tick => bar * BAR;
