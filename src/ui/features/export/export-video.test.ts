import { describe, expect, it, vi } from 'vitest';
import { createTestServices } from '@app/testing';
import { NO_WEBCODECS } from '@app/export/video/support';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { registerFeatures } from '@ui/features';
import { extraMenuItems } from '../../context-menus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { getMenuItems } from '../../shell/menus';
import { exportStore, openExport } from './export-store';

const BAR = 3840;

function setup() {
  const s = createTestServices();
  registerFeatures(s);
  s.history.transact('song', (d) => {
    buildStackedSong(d);
  });
  return s;
}

const labelled = (list: MenuEntry[]) =>
  list.filter((e): e is Extract<MenuEntry, { label: string; onSelect(): void }> => 'label' in e && 'onSelect' in e);

describe('Export as video (commands and menus)', () => {
  it('is in the File menu and opens the dialog on its video tab', async () => {
    const s = setup();
    const file = getMenuItems('file').flatMap((i) => (i.kind === 'command' ? [i.command] : []));
    expect(file).toEqual(expect.arrayContaining(['file.exportMp3', 'file.exportWav', 'file.exportVideo']));
    const def = s.commands.get('file.exportVideo')!;
    expect(def.title).toBe('Export as video…');
    expect(def.hint!.length).toBeGreaterThan(40);
    exportStore.setState({ open: false, tab: 'audio', span: null });
    await s.commands.run('file.exportVideo');
    expect(exportStore.getState()).toMatchObject({ open: true, tab: 'video', span: null });
    // The audio commands still open the audio tab.
    await s.commands.run('file.exportWav');
    expect(exportStore.getState()).toMatchObject({ open: true, tab: 'audio' });
    exportStore.setState({ open: false });
  });

  it('offers Export … as video… on a marker, the loop and a clip, opening the dialog on that part', () => {
    const s = setup();
    const p = s.doc.getState().project;
    const drop = Object.values(p.playlist.markers).find((m) => m.name === 'Drop')!;
    const marker = labelled(extraMenuItems('playlist.marker', { markerId: drop.id }, s)).filter((e) =>
      e.label.endsWith('as video…'),
    );
    expect([...new Set(marker.map((e) => e.label))]).toEqual(['Export “Drop” as video…']);
    marker[0]!.onSelect();
    const open = exportStore.getState();
    expect(open).toMatchObject({ open: true, tab: 'video' });
    expect(open.span!.label).toMatch(/^“Drop” \(bars? \d+/);
    expect(open.span!.to).toBeGreaterThan(open.span!.from);
    exportStore.setState({ open: false, span: null });
    // The ruler offers it for the loop region.
    expect(labelled(extraMenuItems('playlist.ruler', { tick: 0 }, s)).some((e) => e.label.endsWith('as video…'))).toBe(
      false,
    );
    s.view.getState().setLoop({ start: 4 * BAR, end: 8 * BAR });
    const loop = labelled(extraMenuItems('playlist.ruler', { tick: 0 }, s)).filter((e) =>
      e.label.endsWith('as video…'),
    );
    expect([...new Set(loop.map((e) => e.label))]).toEqual(['Export the loop as video…']);
    loop[0]!.onSelect();
    expect(exportStore.getState().span).toMatchObject({ from: 4 * BAR, to: 8 * BAR });
    exportStore.setState({ open: false, span: null });
  });

  it('opens with a part of the song as a fourth choice', () => {
    openExport('video', { from: 0, to: BAR, label: 'bar 1' });
    expect(exportStore.getState()).toEqual({ open: true, tab: 'video', span: { from: 0, to: BAR, label: 'bar 1' } });
    openExport('audio');
    expect(exportStore.getState().span).toBeNull();
    exportStore.setState({ open: false });
  });

  it('is reachable by Studio with every option in its hint, and says plainly when the browser cannot make videos', async () => {
    const s = setup();
    const def = s.commands.get('file.exportVideoNow')!;
    expect(def.gesture).toBe(true);
    for (const word of [
      'range',
      'fromBar',
      'style',
      'size',
      'fps',
      'format',
      'title',
      'artist',
      'normalize',
      'mp4-h264',
      'webm-vp9',
      'vertical',
    ])
      expect(def.argsHint, word).toContain(word);
    // Node has no WebCodecs: the command asks nothing it cannot do and the toast explains.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await s.commands.run('file.exportVideoNow', { style: 'wave', size: 'square', fps: 60 });
    await vi.waitFor(() => expect(s.session.getState().toasts.map((t) => t.text)).toContain(NO_WEBCODECS));
    // The settings it was asked for are remembered for the next export.
    expect(s.prefs.getState()).toMatchObject({
      exportVideoStyle: 'wave',
      exportVideoSize: 'square',
      exportVideoFps: 60,
    });
  });
});
