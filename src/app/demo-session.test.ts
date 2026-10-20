import { describe, expect, it } from 'vitest';
import { MASTER } from '@core/model/types';
import { repairProject } from '@core/schema/migrate';
import { addChannel } from '@core/ops/channels';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { projectViolations } from '../../test/helpers/project-invariants';
import { createDemoProject, DEMO_TITLE } from './demo-project';
import { createTestServices } from './testing';

/** A project the musician has worked on: edits to undo, a layout, and a file it saves to. */
function workedOnProject() {
  const s = createTestServices();
  s.history.transact('add synth', (d) =>
    addChannel(d, makeInstrumentChannel('Lead', makePluginInstance('agstudio.3xosc', 1, {}))),
  );
  s.history.transact('add synth', (d) =>
    addChannel(d, makeInstrumentChannel('Pad', makePluginInstance('agstudio.3xosc', 1, {}))),
  );
  s.history.undo();
  s.view.getState().showWindow('mixer', 'mixer', null);
  const handle = { name: 'song.agproj' } as FileSystemFileHandle;
  s.files.store.setState({ name: 'song', handle, fileKey: 'file-key' });
  return { s, handle };
}

describe('the demo song', () => {
  it('is a consistent project with a beat, a melody, a song, chords and a mastering chain', () => {
    const s = createTestServices();
    const demo = createDemoProject(s.plugins);
    expect(projectViolations(demo)).toEqual([]);
    expect(repairProject(demo).repairs ?? []).toEqual([]);
    expect(demo.meta.title).toBe(DEMO_TITLE);
    expect(demo.channelOrder.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(demo.playlist.clips).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(demo.chords ?? {})).toHaveLength(4);
    expect(demo.transport.key).toEqual({ root: 9, scale: 'minor' });
    const master = demo.mixer.inserts[MASTER];
    expect(master?.fx.map((slot) => slot.plugin.pluginId)).toEqual(['agstudio.maximizer', 'agstudio.limiter']);
  });
});

describe('the demo session', () => {
  it('shows the demo as an unsaved project with no file, and puts everything back at the end', async () => {
    const { s, handle } = workedOnProject();
    const project = s.doc.getState().project;
    const status = s.history.status();
    const windows = s.view.getState().windows;

    await s.demo.begin();
    expect(s.demo.active).toBe(true);
    expect(s.doc.getState().project.meta.title).toBe(DEMO_TITLE);
    expect(s.files.store.getState()).toMatchObject({ name: DEMO_TITLE, handle: null, fileKey: null });
    expect(s.history.status().dirty).toBe(true);
    expect(s.history.status().canUndo).toBe(false);

    s.demo.end();
    expect(s.demo.active).toBe(false);
    expect(s.doc.getState().project).toBe(project);
    expect(s.history.status()).toEqual(status);
    expect(s.files.store.getState()).toMatchObject({ name: 'song', handle, fileKey: 'file-key' });
    expect(s.view.getState().windows).toEqual(windows);
    // The undone step is still there to redo.
    const channelsBefore = s.doc.getState().project.channelOrder.length;
    expect(s.history.redo()).toBe(true);
    expect(s.doc.getState().project.channelOrder).toHaveLength(channelsBefore + 1);
  });

  it('shows the musician’s own project to the reload snapshot and the crash autosave while the demo is on screen', async () => {
    const { s } = workedOnProject();
    const project = s.doc.getState().project;
    expect(s.demo.own).toBeNull();
    await s.demo.begin();
    expect(s.demo.own).toMatchObject({ project, name: 'song', fileKey: 'file-key', isDirty: true });
    s.demo.end();
    expect(s.demo.own).toBeNull();
  });

  it('does nothing twice: beginning again keeps the first project, ending without a demo changes nothing', async () => {
    const { s } = workedOnProject();
    const project = s.doc.getState().project;
    s.demo.end();
    expect(s.doc.getState().project).toBe(project);
    await s.demo.begin();
    const demo = s.doc.getState().project;
    await s.demo.begin();
    expect(s.doc.getState().project).toBe(demo);
    s.demo.end();
    expect(s.doc.getState().project).toBe(project);
  });

  it('is ended by anything that is about to replace the project, so the question is about the musician’s song', async () => {
    const { s } = workedOnProject();
    const project = s.doc.getState().project;
    await s.demo.begin();
    // The musician's project has unsaved changes: New asks about them (no dialog here, so the answer is "cancel").
    expect(await s.files.newProject()).toBe(false);
    expect(s.demo.active).toBe(false);
    expect(s.doc.getState().project).toBe(project);
  });

  it('makes a version of unsaved work first, as a net under the net', async () => {
    const { s } = workedOnProject();
    const calls: string[] = [];
    s.versions.savePoint = (reason, note) => {
      calls.push(`${reason}: ${note}`);
      return Promise.resolve(null);
    };
    await s.demo.begin();
    expect(calls).toEqual(['before-big: a guided tour opened its demo song']);
    s.demo.end();
  });
});
