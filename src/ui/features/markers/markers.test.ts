import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import {
  addMarkerAt,
  adjacentMarker,
  deleteMarker,
  findMarker,
  loopToNextMarker,
  moveMarkerTo,
  renameMarkerTo,
} from '@app/actions/markers';
import { readProjectFile, writeProjectFile } from '@core/io/project-file';
import { markersSorted } from '@core/ops/markers';
import { registerFeatures } from '@ui/features';
import { getActionProviders } from '../../shell/actions';
import { markerAtX } from '../playlist/marker-flags';

const BAR = 3840;

function setup() {
  const s = createTestServices();
  registerFeatures(s);
  const names = () => markersSorted(s.doc.getState().project).map((m) => `${m.name}@${m.tick / BAR + 1}`);
  return { s, names };
}

describe('playlist markers', () => {
  it('adds markers at the song position with fresh names, each one undo step', () => {
    const { s, names } = setup();
    s.view.getState().setSongStart(4 * BAR);
    const a = addMarkerAt(s);
    addMarkerAt(s, 8 * BAR, 'Drop');
    addMarkerAt(s, 0);
    expect(names()).toEqual(['Marker 2@1', 'Marker 1@5', 'Drop@9']);
    expect(s.history.status().undoLabel).toBe('Add marker ‘Marker 2’');
    renameMarkerTo(s, a, '  Verse ');
    moveMarkerTo(s, a, 2 * BAR);
    expect(names()).toEqual(['Marker 2@1', 'Verse@3', 'Drop@9']);
    s.history.undo();
    s.history.undo();
    expect(names()).toEqual(['Marker 2@1', 'Marker 1@5', 'Drop@9']);
  });

  it('finds markers by id, name or number, steps between them and loops to the next one', () => {
    const { s } = setup();
    const verse = addMarkerAt(s, 4 * BAR, 'Verse');
    const drop = addMarkerAt(s, 12 * BAR, 'Drop');
    expect(findMarker(s, verse)?.name).toBe('Verse');
    expect(findMarker(s, 'drop')?.id).toBe(drop);
    expect(findMarker(s, 'Ver')?.id).toBe(verse);
    expect(findMarker(s, 2)?.id).toBe(drop);
    expect(findMarker(s, 'Chorus')).toBeNull();
    expect(adjacentMarker(s, 1, 0)?.name).toBe('Verse');
    expect(adjacentMarker(s, 1, 4 * BAR)?.name).toBe('Drop');
    expect(adjacentMarker(s, -1, 12 * BAR)?.name).toBe('Verse');
    expect(loopToNextMarker(s, verse)).toBe(true);
    expect(s.view.getState().loop).toEqual({ start: 4 * BAR, end: 12 * BAR });
    expect(s.view.getState().mode).toBe('song');
    // After the last marker: to the end of the song (at least a bar).
    expect(loopToNextMarker(s, drop)).toBe(true);
    expect(s.view.getState().loop).toEqual({ start: 12 * BAR, end: 13 * BAR });
    deleteMarker(s, drop);
    expect(findMarker(s, 'Drop')).toBeNull();
  });

  it('runs as commands (Alt+T, args from the AI) and lists jumps in the action search', () => {
    const { s, names } = setup();
    expect(s.keymap.chordsFor('playlist.addMarker')).toEqual(['Alt+T']);
    s.commands.run('playlist.addMarker', { name: 'Drop', bar: 9 });
    s.commands.run('playlist.addMarker', 'Intro');
    expect(names()).toEqual(['Intro@1', 'Drop@9']);
    s.commands.run('playlist.jumpToMarker', 'drop');
    expect(s.view.getState().songStart).toBe(8 * BAR);
    s.commands.run('playlist.previousMarker');
    expect(s.view.getState().songStart).toBe(0);
    s.commands.run('playlist.loopToNextMarker', 'Intro');
    expect(s.view.getState().loop).toEqual({ start: 0, end: 8 * BAR });
    const labels = getActionProviders().flatMap((p) => p(s).map((a) => a.label));
    expect(labels).toEqual(expect.arrayContaining(['Jump to marker: Drop', 'Jump to marker: Intro', 'Loop from marker: Drop']));
    s.commands.run('playlist.deleteMarker', 'Intro');
    expect(names()).toEqual(['Drop@9']);
  });

  it('survives save and open', () => {
    const { s } = setup();
    addMarkerAt(s, 4 * BAR, 'Verse');
    const drop = addMarkerAt(s, 12 * BAR, 'Drop');
    s.history.transact('Marker color', (d) => void (d.playlist.markers[drop]!.color = '#c76b5b'));
    const project = s.doc.getState().project;
    const file = writeProjectFile({ project, view: null, samples: new Map(), appVersion: 'test' });
    const back = readProjectFile(file).project;
    expect(back.playlist.markers).toEqual(project.playlist.markers);
  });

  it('hit-tests marker flags on the ruler (the later flag wins where they touch)', () => {
    const boxes = [
      { id: 'a' as never, tick: 0, x0: 7, x1: 60 },
      { id: 'b' as never, tick: 960, x0: 58, x1: 90 },
    ];
    expect(markerAtX(boxes, 5)).toBeNull();
    expect(markerAtX(boxes, 10)?.id).toBe('a');
    expect(markerAtX(boxes, 59)?.id).toBe('b');
    expect(markerAtX(boxes, 95)).toBeNull();
  });
});
