import { beforeEach, describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { addChannel } from '@core/ops/channels';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { registerFeatures } from '..';
import { windowTypes } from '../../workspace/registry';
import { selectorFor } from './target';
import { TOURS, tourById, tourForWindow } from './tour-list';
import { endTour, goToStep, startTour, tourStore } from './tour-state';
import { spotlight } from './spotlight';

const AI_WORD = /\bA\.?I\.?\b/;

function setup() {
  const s = createTestServices();
  registerFeatures(s);
  return s;
}

describe('the tour list', () => {
  const s = setup();

  it('has the tours the owner asked for, each with its steps', () => {
    expect(TOURS.map((t) => t.id)).toEqual([
      'overview',
      'first-song',
      'record-vocal',
      'dj-mixing',
      'clip-launcher',
      'harmony-chords',
      'mix-master',
      'studio-mcp',
    ]);
    expect(tourById('first-song')!.steps.map((x) => x.id)).toEqual([
      'sounds',
      'beat',
      'melody',
      'midi-effects',
      'song',
      'play',
      'mix',
      'export',
    ]);
    expect(tourById('record-vocal')!.steps.map((x) => x.id)).toEqual([
      'input',
      'record',
      'takes',
      'pitch',
      'cleanup',
      'align',
      'chain',
      'harmonies',
    ]);
  });

  it('gives every step an id, a title and a body, every tour a summary, and no word "AI"', () => {
    const ids = new Set<string>();
    for (const tour of TOURS) {
      expect(ids.has(tour.id), `duplicate tour ${tour.id}`).toBe(false);
      ids.add(tour.id);
      expect(tour.summary.length, tour.id).toBeGreaterThan(20);
      expect(tour.steps.length, tour.id).toBeGreaterThanOrEqual(4);
      const stepIds = new Set<string>();
      for (const step of tour.steps) {
        expect(stepIds.has(step.id), `${tour.id}: duplicate step ${step.id}`).toBe(false);
        stepIds.add(step.id);
        expect(step.title.length, `${tour.id}/${step.id}`).toBeGreaterThan(3);
        expect(step.body.length, `${tour.id}/${step.id}`).toBeGreaterThan(40);
        for (const text of [step.title, step.body, tour.title, tour.summary, step.tryIt?.label ?? ''])
          expect(AI_WORD.test(text), `${tour.id}/${step.id}: "${text}"`).toBe(false);
      }
    }
  });

  it('points every step at a target the engine understands', () => {
    for (const tour of TOURS)
      for (const step of tour.steps)
        expect(selectorFor(step.target), `${tour.id}/${step.id}: ${step.target}`).not.toBeNull();
    expect(selectorFor('window:mixer')).toBe('[data-window-type="mixer"]');
    expect(selectorFor('tour:transport')).toBe('[data-tour="transport"]');
    expect(selectorFor('menu:file')).toBe('[data-menu="file"]');
    expect(selectorFor('slot:input')).toBe('[data-slot="input"]');
    // A name that could break out of the attribute selector is refused.
    expect(selectorFor('window:a"],body[x="')).toBeNull();
    expect(selectorFor('nothing' as never)).toBeNull();
  });

  it('names real commands: shortcuts in the text and the buttons on a step', () => {
    for (const tour of TOURS)
      for (const step of tour.steps) {
        for (const m of step.body.matchAll(/\{key:([\w.]+)\}/g))
          expect(s.commands.get(m[1]!), `${tour.id}/${step.id}: ${m[1]}`).toBeTruthy();
        if (step.tryIt)
          expect(s.commands.get(step.tryIt.command), `${tour.id}/${step.id}: ${step.tryIt.command}`).toBeTruthy();
      }
  });

  it('lets a step’s button only open a window or pick a tool: a tour never edits the demo song for you', () => {
    const allowed =
      /^(view\.|options\.audioInput|options\.connectAi|samples\.open|reference\.open|dj\.open|dj\.controllers\.open|decks\.open|launcher\.open|launcher\.fromPatterns|chords\.showLane|playlist\.tool\.)/;
    for (const tour of TOURS)
      for (const step of tour.steps)
        if (step.tryIt) expect(step.tryIt.command, `${tour.id}/${step.id}`).toMatch(allowed);
  });

  it('gives every window type to exactly one tour, so every “?” can offer one', () => {
    const owners = new Map<string, string[]>();
    for (const tour of TOURS) for (const w of tour.windows) owners.set(w, [...(owners.get(w) ?? []), tour.id]);
    for (const [type, tours] of owners) expect(tours, `${type} is in several tours`).toHaveLength(1);
    const missing = windowTypes().filter((type) => !tourForWindow(type));
    expect(missing, `window types with no tour: ${missing.join(', ')}`).toEqual([]);
    for (const type of owners.keys()) expect(windowTypes(), `${type} is not a window type`).toContain(type);
  });

  it('lists every tour in the command’s argument hint, so Studio can start any of them', () => {
    const hint = s.commands.get('tour.start')!.argsHint!;
    for (const tour of TOURS) expect(hint).toContain(`'${tour.id}'`);
  });
});

describe('running a tour', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.history.transact('add a synth', (d) =>
      addChannel(d, makeInstrumentChannel('Lead', makePluginInstance('agstudio.3xosc', 1, {}))),
    );
    s.history.transact('add another', (d) =>
      addChannel(d, makeInstrumentChannel('Pad', makePluginInstance('agstudio.3xosc', 1, {}))),
    );
    s.history.undo();
  });

  it('shows the demo song, moves card by card, and gives the project back deep-equal when it ends', async () => {
    const project = s.doc.getState().project;
    const snapshot = structuredClone(project);
    const status = s.history.status();
    expect(await startTour(s, 'first-song')).toBe(true);
    expect(tourStore.getState().run).toMatchObject({ step: 0 });
    expect(s.doc.getState().project).not.toBe(project);
    goToStep(s, 1);
    expect(tourStore.getState().run?.step).toBe(1);
    goToStep(s, 0);
    goToStep(s, -1);
    expect(tourStore.getState().run).toBeNull();
    expect(s.doc.getState().project).toBe(project);
    expect(s.doc.getState().project).toEqual(snapshot);
    expect(s.history.status()).toEqual(status);
  });

  it('loses nothing in any tour: every card prepared, then done or skipped', async () => {
    const project = s.doc.getState().project;
    const status = s.history.status();
    for (const tour of TOURS) {
      await startTour(s, tour.id);
      for (const [i, step] of tour.steps.entries()) {
        step.prepare?.(s);
        goToStep(s, i);
      }
      // Half the tours are skipped on the last card, half finished with Done.
      if (tour.id.length % 2) endTour(s);
      else goToStep(s, tour.steps.length);
      expect(tourStore.getState().run).toBeNull();
      expect(s.doc.getState().project, tour.id).toBe(project);
      expect(s.history.status(), tour.id).toEqual(status);
    }
  });

  it('is ended, with the project back, when something else is about to replace the project', async () => {
    const project = s.doc.getState().project;
    // The musician's project has unsaved changes, so New asks; the answer here is "keep my project".
    s.files.setUi({ askUnsaved: () => Promise.resolve('cancel') });
    await startTour(s, 'overview');
    await s.files.newProject();
    expect(tourStore.getState().run).toBeNull();
    expect(s.demo.active).toBe(false);
    expect(s.doc.getState().project).toBe(project);
  });

  it('replaces a running tour with the next one without restoring in between, and never keeps two demos', async () => {
    const project = s.doc.getState().project;
    await startTour(s, 'overview');
    const demo = s.doc.getState().project;
    await startTour(s, 'mix-master');
    expect(tourStore.getState().run?.tour.id).toBe('mix-master');
    expect(s.doc.getState().project).toBe(demo);
    endTour(s);
    expect(s.doc.getState().project).toBe(project);
  });

  it('refuses a tour that does not exist, and says so', async () => {
    expect(await startTour(s, 'no-such-tour')).toBe(false);
    expect(s.session.getState().toasts.at(-1)?.text).toContain('no-such-tour');
    expect(tourStore.getState().run).toBeNull();
  });

  it('starts from the command with an id (and the overview with none), and stops from the command', async () => {
    s.commands.run('tour.start', 'dj-mixing');
    await new Promise((r) => setTimeout(r, 0));
    expect(tourStore.getState().run?.tour.id).toBe('dj-mixing');
    expect(s.commands.run('tour.stop')).toBe(true);
    expect(tourStore.getState().run).toBeNull();
    expect(s.commands.run('tour.stop')).toBe(false);
    s.commands.run('help.tour');
    await new Promise((r) => setTimeout(r, 0));
    expect(tourStore.getState().run?.tour.id).toBe('overview');
    endTour(s);
  });

  it('runs a one-card spotlight on the real project, swapping nothing', async () => {
    const project = s.doc.getState().project;
    const step = TOURS[1]!.steps[1]!;
    await startTour(s, spotlight(step), { demo: false });
    expect(s.demo.active).toBe(false);
    expect(s.doc.getState().project).toBe(project);
    expect(tourStore.getState().run?.tour.steps).toHaveLength(1);
    goToStep(s, 1);
    expect(tourStore.getState().run).toBeNull();
  });
});
