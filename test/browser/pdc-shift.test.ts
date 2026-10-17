/**
 * Plugin delay compensation is done in time, not with delay lines on the channels (engine/pdc.ts, ChannelStrip.shift):
 * the song's notes, clip starts, automation and plugin transport anchors are scheduled later by what the channel's
 * insert is held back, so playback stays sample-aligned, and a live note (which the song does not schedule) hears
 * none of it. Offline renders, so the frames are exact.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { ParamTarget, Project } from '@core/model/types';
import { Engine } from '@engine/engine';
import { renderOffline } from '@engine/render-offline';
import { automate, pt } from '../helpers/automation';
import { onsets, resolver, withInsert } from '../helpers/fixtures';
import { heldNote, tone } from '../helpers/tone';
import { addEffect, channelsProject, impulse, latentEffect, maxDiffShifted, SR } from '../helpers/routing';

const BAR = 3840;
const LATENT = 240;
const latent = latentEffect(LATENT);
const plugins = () => resolver(tone, impulse, latent);

describe('delay compensation in time', () => {
  it('keeps automation of a channel, an insert and a plugin with the notes', async () => {
    const { project: base, pid, ch } = heldNote(tone, 2);
    const { project: routed, insertId } = withInsert(base, [ch]);
    const channelVolume: ParamTarget = { kind: 'channel', channelId: ch, param: 'volume' };
    const insertVolume: ParamTarget = { kind: 'insert', insertId, param: 'volume' };
    const level: ParamTarget = { kind: 'plugin', owner: { kind: 'channel', channelId: ch }, paramId: 'level' };
    const clip = [{ start: 0, length: 2 * BAR, lane: 1 }];
    let doc = automate(routed, channelVolume, [pt(0, 0.3), pt(2 * BAR, 0.9)], clip).project;
    doc = automate(doc, insertVolume, [pt(0, 0.8), pt(2 * BAR, 0.5)], clip).project;
    doc = automate(doc, level, [pt(0, 1), pt(2 * BAR, 0.4)], clip).project;
    // The same song with a latent effect on another track: everything it plays is held back by it.
    const withLatency = produce(doc, (d) => {
      const other = d.mixer.order[2]!;
      addEffect(d, other, latent);
    });
    const render = (p: Project) =>
      renderOffline(p, {
        plugins: plugins(),
        view: { mode: 'song', patternId: pid, loop: null },
        bars: 2,
        sampleRate: SR,
        tail: 0.2,
      });
    const plain = await render(doc);
    const held = await render(withLatency);
    expect(plain.latency).toBe(0);
    expect(held.latency * SR).toBeCloseTo(LATENT, 6);
    // The whole mix is the plain one, LATENT frames later: notes and every automated value moved together.
    expect(maxDiffShifted(held.buffer, plain.buffer, LATENT)).toBeLessThan(1e-5);
    // (And automation did move the level, so the comparison says something.)
    const data = plain.buffer.getChannelData(0);
    const early = Math.max(...data.slice(5000, 9000).map(Math.abs));
    const late = Math.max(...data.slice(SR * 3, SR * 3 + 4000).map(Math.abs));
    expect(late).toBeLessThan(early * 0.8);
  });

  it('a live note is not held back by the compensation, a song note is', async () => {
    const { project, patternId, channels, ins } = channelsProject([
      { def: impulse, notes: [[0, 240, 60]], insert: 1 },
    ]);
    const latentOther = produce(project, (d) => {
      addEffect(d, ins[2]!, latent);
    });
    const live = async (doc: Project) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR / 2, sampleRate: SR });
      const engine = new Engine(ctx, { plugins: plugins() }, true);
      engine.applyDocChange({ next: doc, prev: doc, patches: null, origin: 'load' });
      engine.setTransportView({ mode: 'pattern', patternId, loop: null });
      await engine.ready();
      expect(engine.graphLatency() * SR).toBeCloseTo(doc === project ? 0 : LATENT, 6);
      engine.previewNoteOn(channels[0]!, 60, 1);
      await engine.syncWorklets();
      const buffer = await ctx.startRendering();
      await engine.dispose();
      return onsets(buffer, 0.05, 0.1);
    };
    const [plain, delayed] = [await live(project), await live(latentOther)];
    expect(plain).toHaveLength(1);
    // Same frame with or without the latency elsewhere in the mix.
    expect(delayed).toEqual(plain);
    // The song's own note of the same impulse is held back by it.
    const song = async (doc: Project) =>
      onsets(
        (
          await renderOffline(doc, {
            plugins: plugins(),
            view: { mode: 'pattern', patternId, loop: null },
            bars: 1,
            sampleRate: SR,
            tail: 0.2,
          })
        ).buffer,
        0.05,
        0.1,
      );
    const [songPlain, songDelayed] = [await song(project), await song(latentOther)];
    expect(songDelayed[0]! - songPlain[0]!).toBe(LATENT);
  });

  it('plans again when the compensation changes while playing: every note lands once, at its new place', async () => {
    const { project, patternId, ins } = channelsProject([
      { def: impulse, notes: [0, 960, 1920, 2880].map((t) => [t, 240, 60] as [number, number, number]), insert: 1 },
    ]);
    const withFx = produce(project, (d) => {
      addEffect(d, ins[2]!, latent);
    });
    const run = async (change: boolean) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR * 3, sampleRate: SR });
      const engine = new Engine(ctx, { plugins: plugins() }, true);
      engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
      engine.setTransportView({ mode: 'pattern', patternId, loop: null });
      await engine.ready();
      const preRoll = 2048 / SR;
      engine.startOffline(0, preRoll);
      engine.pumpOffline(preRoll + 0.45);
      // Part-way through the first beat (the clock is running, as live) an effect with latency appears.
      void ctx.suspend(0.3).then(async () => {
        if (change) {
          engine.applyDocChange({ next: withFx, prev: project, patches: [], origin: 'edit' });
          await engine.ready();
          expect(engine.graphLatency() * SR).toBeCloseTo(LATENT, 6);
        }
        engine.pumpOffline(preRoll + engine.barSeconds() - 1e-6);
        await engine.syncWorklets();
        void ctx.resume();
      });
      const buffer = await ctx.startRendering();
      await engine.dispose();
      return buffer;
    };
    const before = onsets(await run(false), 0.05, 0.1);
    const after = onsets(await run(true), 0.05, 0.1);
    expect(before).toHaveLength(4);
    expect(after).toHaveLength(4);
    // The note that had already sounded stays; the ones still to come wait for the new latency, each exactly once.
    expect(after.map((frame, i) => frame - before[i]!)).toEqual([0, LATENT, LATENT, LATENT]);
  });
});
