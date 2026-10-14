/**
 * Freeze and Consolidate: what they render plays back like what it replaced (M15).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createServices, type Services } from '@app/services';
import { consolidate, freezeChannel, unfreezeChannel } from '@app/actions/render-to-audio';
import { opfsSampleProvider } from '@app/persistence/project-io';
import type { ChannelId, ClipId, LaneId, Project } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { renderOffline } from '@engine/render-offline';
import eq from '../../src/plugins/builtin/eq';
import { kitProject, withInsert } from '../helpers/fixtures';

const BAR = 3840;

function song(): { project: Project; kick: ChannelId } {
  const kit = kitProject(
    [
      { generator: 'kit/kick', steps: [0, 6, 8] },
      { generator: 'kit/snare', steps: [4, 12] },
    ],
    120,
  );
  const [kick, snare] = kit.channels;
  let p = withInsert(kit.project, [kick!], { index: 1, fx: [{ def: eq, params: { lowGain: 6 } }] }).project;
  p = withInsert(p, [snare!], { index: 2 }).project;
  const project = produce(p, (d) => {
    const k = d.channels[kick!];
    if (k?.kind === 'instrument') k.pan = -0.4;
    addClips(d, [
      {
        kind: 'pattern',
        id: 'c1' as ClipId,
        laneId: d.playlist.laneOrder[0] as LaneId,
        start: 0,
        length: 2 * BAR,
        patternId: kit.patternId,
        offset: 0,
      },
    ]);
  });
  return { project, kick: kick! };
}

describe('freeze and consolidate', () => {
  const all: Services[] = [];
  afterAll(async () => {
    for (const s of all) await s.engine.dispose();
  });

  const render = async (s: Services) => {
    const r = await renderOffline(s.doc.getState().project, {
      plugins: s.plugins,
      samples: opfsSampleProvider(),
      view: { mode: 'song', patternId: null, loop: null },
      bars: 2,
      sampleRate: s.engine.sampleRate,
      tail: 1,
    });
    return [r.buffer.getChannelData(0), r.buffer.getChannelData(1)];
  };
  const diff = (a: Float32Array[], b: Float32Array[]) => {
    let m = 0;
    let peak = 0;
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < Math.min(a[c]!.length, b[c]!.length); i++) {
        m = Math.max(m, Math.abs(a[c]![i]! - b[c]![i]!));
        peak = Math.max(peak, Math.abs(a[c]![i]!));
      }
    return { m, peak };
  };

  it('freezes a channel into audio that sounds the same through its mixer track, and unfreezes it', async () => {
    const { project, kick } = song();
    const s = createServices({ project });
    all.push(s);
    const before = await render(s);
    const frozenId = await freezeChannel(s, kick);
    const p = s.doc.getState().project;
    expect(p.channels[kick]!.muted).toBe(true);
    const original = p.channels[kick];
    expect(p.channels[frozenId]).toMatchObject({
      kind: 'audioClip',
      frozenFrom: kick,
      output: original?.kind === 'instrument' ? original.output : null,
    });
    expect(s.history.status().undoLabel).toBe('Freeze kit/kick');
    const after = await render(s);
    const { m, peak } = diff(before, after);
    expect(peak).toBeGreaterThan(0.1);
    // Not bit-exact: where the kick's sample ends, Chrome stops the EQ's filters on the original
    // (its input goes silent) while the frozen clip keeps feeding them zeros (−50 dB here).
    expect(m / peak).toBeLessThan(0.005);
    expect(unfreezeChannel(s, kick)).toBe(true);
    expect(s.doc.getState().project.channels[frozenId]).toBeUndefined();
    expect(s.doc.getState().project.channels[kick]!.muted).toBe(false);
  });

  it('consolidates clips into one audio clip that sounds like them', async () => {
    const { project } = song();
    const s = createServices({ project });
    all.push(s);
    const before = await render(s);
    s.editor.getState().selectClips(['c1' as ClipId]);
    const id = await consolidate(s);
    const p = s.doc.getState().project;
    expect(p.playlist.clips['c1' as ClipId]).toBeUndefined();
    expect(p.playlist.clips[id]).toMatchObject({ kind: 'audio', start: 0 });
    const after = await render(s);
    const { m, peak } = diff(before, after);
    expect(peak).toBeGreaterThan(0.1);
    expect(m).toBeLessThan(1e-4);
    s.history.undo();
    expect(s.doc.getState().project.playlist.clips['c1' as ClipId]).toBeDefined();
  });
});
