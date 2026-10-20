/**
 * The Align window's commands and entry points: the clip menu and the Playlist menu offer alignment, the commands act on the
 * selected clips (one undo step), the A/B switch changes what the engine hears without touching the document, and the
 * AI's command catalog knows every command.
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { aiCommands } from '@app/ai/commands';
import { alignState } from '@app/align/state';
import { createTestServices } from '@app/testing';
import { clipHasAlignRender, unalignedSound, heardProject } from '@core/query/hear';
import type { AudioClip, ClipId, SampleId, SampleRef } from '@core/model/types';
import { setAlign, setAlignRender } from '@core/ops/align';
import { extraMenuItems } from '../../context-menus';
import { getMenuItems } from '../../shell/menus';
import { registerFeatures } from '..';
import { ALIGN_WINDOW } from './align-commands';

const SR = 48000;

function setup() {
  const samples = new TestSamples();
  const lead = samples.add([new Float32Array(SR)], SR, 'lead');
  const double = samples.add([new Float32Array(SR)], SR, 'double');
  const a = audioClipProject(lead, [{ start: 0, length: 3840 }]);
  const b = audioClipProject(double, [{ start: 0, length: 3840 }]);
  const project = produce(a.project, (d) => {
    d.samples[double.id] = b.project.samples[double.id]!;
    d.channels[b.channelId] = b.project.channels[b.channelId]!;
    d.channelOrder.push(b.channelId);
    d.playlist.clips[b.clipIds[0] as ClipId] = { ...b.project.playlist.clips[b.clipIds[0] as ClipId]!, laneId: d.playlist.laneOrder[1]! };
  });
  const s = createTestServices();
  registerFeatures(s);
  s.history.load(project);
  const leadClip = a.clipIds[0] as ClipId;
  const doubleClip = b.clipIds[0] as ClipId;
  const clip = (id: ClipId) => s.doc.getState().project.playlist.clips[id] as AudioClip;
  return { s, leadClip, doubleClip, clip };
}

describe('Align: entry points', () => {
  it('the clip menu offers Align to guide… and Tighten timing to the grid for audio clips, and Remove only when aligned', () => {
    const { s, leadClip, doubleClip, clip } = setup();
    const labels = (id: ClipId) => extraMenuItems('playlist.clip', { clip: clip(id) }, s).flatMap((i) => ('label' in i ? [i.label] : []));
    expect(labels(doubleClip)).toEqual(expect.arrayContaining(['Align to guide…', 'Tighten timing to the grid']));
    expect(labels(doubleClip)).not.toContain('Remove alignment');
    s.history.transact('Align', (d) => setAlign(d, doubleClip, { mode: 'guide', guide: leadClip, tightness: 70 }));
    expect(labels(doubleClip)).toContain('Remove alignment');
  });

  it('the Playlist menu (and so the action search) lists the commands, each with a hint', () => {
    const { s } = setup();
    const entries = getMenuItems('playlist').filter((i) => i.kind === 'command');
    const ids = entries.map((i) => (i.kind === 'command' ? i.command : ''));
    expect(ids).toEqual(expect.arrayContaining(['align.open', 'align.tighten', 'align.remove']));
    for (const id of ['align.open', 'align.apply', 'align.tighten', 'align.remove', 'align.toggleOriginal']) {
      const def = s.commands.list().find((c) => c.id === id);
      expect(def?.hint, id).toBeTruthy();
      expect(def?.argsHint, id).toBeTruthy();
    }
  });

  it('every alignment command is in the command catalog the AI and MCP see', () => {
    const { s } = setup();
    const catalog = new Set(aiCommands(s).map((c) => c.id));
    for (const id of ['align.open', 'align.apply', 'align.tighten', 'align.remove', 'align.toggleOriginal']) expect(catalog.has(id), id).toBe(true);
  });
});

describe('Align: commands', () => {
  it('align.open opens the window for the clip given (or the selection) and says what to do when nothing is selected', async () => {
    const { s, doubleClip } = setup();
    await s.commands.run('align.open', {});
    expect(s.session.getState().toasts.map((t) => t.text).join(' ')).toMatch(/Select an audio clip/);
    expect(Object.values(s.view.getState().windows).some((w) => w.type === ALIGN_WINDOW && w.visible)).toBe(true);
    await s.commands.run('align.open', { clip: doubleClip });
    expect(alignState.getState().windowClip).toBe(doubleClip);
  });

  it('align.apply acts on the selected clips with the settings, in one undo step; align.remove takes it off', async () => {
    const { s, leadClip, doubleClip, clip } = setup();
    s.editor.getState().selectClips([doubleClip]);
    const before = s.history.steps().done.length;
    await s.commands.run('align.apply', { guide: leadClip, tightness: 55, pitch: 20 });
    expect(clip(doubleClip).align).toMatchObject({ mode: 'guide', guide: leadClip, tightness: 55, pitch: 20 });
    expect(s.history.steps().done.length).toBe(before + 1);
    await s.commands.run('align.remove', {});
    expect(clip(doubleClip).align).toBeUndefined();
    await s.commands.run('align.tighten', { strength: 90, grid: '1/8' });
    expect(clip(doubleClip).align).toMatchObject({ mode: 'grid', strength: 90, stepTicks: 480 });
  });

  it('align.apply without a guide says so and changes nothing', async () => {
    const { s, doubleClip, clip } = setup();
    s.editor.getState().selectClips([doubleClip]);
    await s.commands.run('align.apply', {});
    expect(clip(doubleClip).align).toBeUndefined();
    expect(s.session.getState().toasts.map((t) => t.text).join(' ')).toMatch(/Say which clip is the lead/);
  });
});

describe('Align: A/B', () => {
  it('the engine hears the recording while the switch is on (the pitch render, made from the aligned sound, goes too); the document stays', async () => {
    const { s, leadClip, doubleClip, clip } = setup();
    const render: SampleRef = { id: 'smp_aligned' as SampleId, name: 'aligned', source: { kind: 'embedded', hash: 'd'.repeat(64), ext: 'flac' } };
    s.history.transact('Align', (d) => {
      setAlign(d, doubleClip, { mode: 'guide', guide: leadClip, tightness: 70 });
      setAlignRender(d, doubleClip, render, 'sig', [0, 5, 1, -5]);
    });
    s.editor.getState().selectClips([doubleClip]);
    const project = s.doc.getState().project;
    expect(clipHasAlignRender(project, doubleClip)).toBe(true);
    expect(unalignedSound(project, [])).toBe(project);
    const sent = () => s.fakeEngine.changes[s.fakeEngine.changes.length - 1]!.next.playlist.clips[doubleClip] as AudioClip;
    expect(sent().align?.renderedSampleId).toBe(render.id);
    const steps = s.history.steps().done.length;
    await s.commands.run('align.toggleOriginal', {});
    expect(s.editor.getState().alignOriginal).toEqual([doubleClip]);
    expect(sent().align?.renderedSampleId).toBeUndefined();
    expect(clip(doubleClip).align?.renderedSampleId).toBe(render.id);
    expect(s.history.steps().done.length).toBe(steps);
    expect(heardProject(project, { audition: null, original: [], unaligned: [doubleClip] })).not.toBe(project);
    await s.commands.run('align.toggleOriginal', { original: false });
    expect(sent().align?.renderedSampleId).toBe(render.id);
    // A clip that goes away takes its switch with it.
    await s.commands.run('align.toggleOriginal', { original: true });
    s.history.transact('Delete', (d) => void delete d.playlist.clips[doubleClip]);
    expect(s.editor.getState().alignOriginal).toEqual([]);
  });
});
