import { describe, expect, it, vi } from 'vitest';
import { createTestServices } from '../testing';
import { installLaunchConsumer, launchedKind, openLaunchedFiles, planLaunch, type LaunchParams } from './launch';

const handle = (name: string, text = '') =>
  ({ kind: 'file', name, getFile: () => Promise.resolve(new File([text], name)) }) as unknown as FileSystemFileHandle;

describe('files the app is opened with', () => {
  it('tells project, chain and preset files apart, by extension', () => {
    expect(launchedKind('Song.agproj')).toBe('project');
    expect(launchedKind('SONG.AGPROJ')).toBe('project');
    expect(launchedKind('Wide.agchain')).toBe('chain');
    expect(launchedKind('Pad.agpreset')).toBe('preset');
    expect(launchedKind('notes.txt')).toBe('unknown');
  });

  it('opens the first project, and the rest go to the libraries', () => {
    expect(planLaunch(['a.agproj', 'b.agproj', 'c.agchain', 'd.agpreset', 'e.wav'])).toEqual({
      project: 0,
      extraProjects: 1,
      others: [
        { index: 2, kind: 'chain' },
        { index: 3, kind: 'preset' },
        { index: 4, kind: 'unknown' },
      ],
    });
    expect(planLaunch(['c.agchain']).project).toBeNull();
  });

  it('opens a project through the normal open path, keeping its handle for Save', async () => {
    const s = createTestServices();
    const open = vi.spyOn(s.files, 'openFile').mockResolvedValue(true);
    const h = handle('Song.agproj');
    await openLaunchedFiles(s, [h]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0].name).toBe('Song.agproj');
    expect(open.mock.calls[0]![1]).toBe(h);
  });

  it('opens one project at a time and says so', async () => {
    const s = createTestServices();
    const open = vi.spyOn(s.files, 'openFile').mockResolvedValue(true);
    await openLaunchedFiles(s, [handle('A.agproj'), handle('B.agproj')]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(s.session.getState().toasts.map((t) => t.text).join('\n')).toMatch(/one project at a time/);
  });

  it('says what is wrong with a file it cannot use, and still opens the rest', async () => {
    const s = createTestServices();
    const open = vi.spyOn(s.files, 'openFile').mockResolvedValue(true);
    await openLaunchedFiles(s, [handle('notes.txt'), handle('Pad.agpreset', '{"nope":1}'), handle('S.agproj')]);
    const toasts = s.session.getState().toasts.map((t) => t.text);
    expect(toasts.some((t) => /can't open "notes.txt"/.test(t))).toBe(true);
    expect(toasts.some((t) => /preset file/.test(t))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('receives files from Chrome’s launch queue, and is skipped where there is none', async () => {
    const s = createTestServices();
    const open = vi.spyOn(s.files, 'openFile').mockResolvedValue(true);
    expect(installLaunchConsumer(s, {})).toBe(false);
    let consumer: ((p: LaunchParams) => void | Promise<void>) | undefined;
    expect(installLaunchConsumer(s, { launchQueue: { setConsumer: (c) => void (consumer = c) } })).toBe(true);
    await consumer!({ files: [] }); // a plain launch with no files
    expect(open).not.toHaveBeenCalled();
    await consumer!({ files: [handle('Song.agproj')] });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
