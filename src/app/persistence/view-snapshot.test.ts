import { describe, expect, it } from 'vitest';
import { createTestServices } from '../testing';
import { defaultPianoRoll } from '../stores/editor';
import { applyView, captureView } from './view-snapshot';

describe('view snapshot', () => {
  it('round-trips the view, editor settings and selected channel', () => {
    const a = createTestServices();
    const project = a.doc.getState().project;
    const v = a.view.getState();
    v.setMode('song');
    v.setLoop({ start: 0, end: 3840 });
    v.setSongStart(1920);
    v.showWindow('piano-roll', 'piano-roll');
    v.setRect('piano-roll', { x: 10, y: 20, w: 600, h: 400 });
    a.editor.getState().setPianoRoll({ tool: 'paint', snap: 'beat', pxPerTick: 0.2 });
    a.session.getState().selectChannel(project.channelOrder[1] ?? null);
    const snap = JSON.parse(JSON.stringify(captureView(a))) as unknown;

    const b = createTestServices({ project });
    expect(applyView(b, snap, project)).toBe(true);
    expect(captureView(b)).toEqual(captureView(a));
  });

  it('falls back to defaults for missing or malformed fields', () => {
    const s = createTestServices();
    const project = s.doc.getState().project;
    const applied = applyView(
      s,
      {
        mode: 'karaoke',
        currentPatternId: 'pat_missing',
        loop: { start: 100, end: 50 },
        songStart: -5,
        windows: {
          ok: { type: 'mixer', props: null, rect: { x: 0, y: 0, w: -1, h: 10 }, z: 3, visible: true },
          gone: { type: 'plugin', props: { channelId: 'ch_nonexistent' }, rect: null, z: 1 },
          junk: 42,
        },
        pianoRoll: { tool: 'chainsaw', snap: 'nonsense', pxPerTick: -1, ghosts: false, scrollRow: 12 },
        selectedChannelId: 'ch_missing',
      },
      project,
    );
    expect(applied).toBe(true);
    const v = s.view.getState();
    expect(v.mode).toBe('pattern');
    expect(v.currentPatternId).toBe(project.patternOrder[0]);
    expect(v.loop).toBeNull();
    expect(v.songStart).toBe(0);
    expect(Object.keys(v.windows)).toEqual(['ok']);
    expect(v.windows.ok?.rect).toBeNull();
    const pr = s.editor.getState().pianoRoll;
    expect(pr).toMatchObject({ tool: 'draw', snap: defaultPianoRoll().snap, ghosts: false, scrollRow: 12 });
    expect(pr.pxPerTick).toBe(defaultPianoRoll().pxPerTick);
    expect(s.session.getState().selectedChannelId).toBe(project.channelOrder[0]);
  });

  it('reports a view without windows so the caller can lay out defaults', () => {
    const s = createTestServices();
    expect(applyView(s, null, s.doc.getState().project)).toBe(false);
    expect(applyView(s, { windows: {} }, s.doc.getState().project)).toBe(false);
  });
});
