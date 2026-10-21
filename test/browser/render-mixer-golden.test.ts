/**
 * What the mixer graph does to audio, to the last bit. The engine builds the nodes between an instrument and the master in a
 * way that changed on purpose more than once to make an idle project cheaper (stages that were always there are made when
 * they are first needed: the dry/wet stage of a slot, the mute gate of a channel or an insert, the pitch signal of a
 * channel); each of those is only allowed if every render stays bit for bit what it was. These hashes were taken from the
 * engine before those changes and must not move.
 *
 * The sounds are impulses (a worklet that writes 0.5 for one frame per note, so its own DSP is nothing), which the graph then
 * scales, pans, delays, mutes and adds: Chrome's gains, panners and delays do plain float arithmetic, so a hash that moves is
 * a change in the graph. A change to how Chrome itself does that arithmetic would move them too (then re-record them, after
 * making sure that is the reason).
 */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@core/io/hash';
import type { ChannelId, InsertId, Project } from '@core/model/types';
import { setInsertProp, toggleSoloInsert } from '@core/ops/mixer';
import { setChannelProp } from '@core/ops/channels';
import { setRoute } from '@core/ops/routing';
import type { PluginDef } from '@agstudio/sdk';
import { addEffect, channelsProject, impulse, latentEffect, renderDocs } from '../helpers/routing';
import { resolver } from '../helpers/fixtures';

/** Both channels of a render, hashed. */
async function hashOf(buffer: AudioBuffer): Promise<string> {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(new Uint8Array(left.buffer, left.byteOffset, left.byteLength), 0);
  bytes.set(new Uint8Array(right.buffer, right.byteOffset, right.byteLength), left.byteLength);
  return sha256Hex(bytes);
}

/**
 * Six channels of impulses into three tracks (two of them with effects that report latency, so the delay compensation
 * pads routes and the channels' events are scheduled later), with pan, volume, a send before the fader and one after, and a
 * bus that all of it ends up in.
 */
function mixerProject(): { project: Project; channels: ChannelId[]; inserts: InsertId[]; patternId: ReturnType<typeof channelsProject>['patternId'] } {
  const notes = (offset: number): [number, number, number][] => [
    [0 + offset, 240, 60],
    [960 + offset, 240, 62],
    [1920 + offset, 240, 64],
    [2880 + offset, 240, 65],
  ];
  const specs = [
    { def: impulse, notes: notes(0), insert: 1 },
    { def: impulse, notes: notes(120), insert: 1, volume: 0.6 },
    { def: impulse, notes: notes(240), insert: 2 },
    { def: impulse, notes: notes(360), insert: 2, volume: 0.9 },
    { def: impulse, notes: notes(480), insert: 3 },
    { def: impulse, notes: notes(600), insert: 0 },
  ];
  const { project, patternId, channels, ins } = channelsProject(specs);
  const [, track1, track2, bus] = ins as [InsertId, InsertId, InsertId, InsertId];
  const built = produce(project, (d) => {
    addEffect(d, track1, latentEffect(96));
    addEffect(d, track2, latentEffect(32));
    setRoute(d, track1, bus, { level: 0.5, pre: false });
    setRoute(d, track2, bus, { level: 0.7, pre: true });
    setInsertProp(d, track1, 'pan', -0.3);
    setInsertProp(d, track1, 'volume', 0.8);
    setInsertProp(d, track2, 'pan', 0.45);
    setChannelProp(d, channels[0] as ChannelId, 'pan', 0.25);
  });
  return { project: built, channels, inserts: [track1, track2, bus], patternId };
}

const plugins = () => resolver(impulse as PluginDef, latentEffect(96), latentEffect(32));

async function render(project: Project, patternId: ReturnType<typeof mixerProject>['patternId']): Promise<string> {
  return hashOf(await renderDocs([project], patternId, plugins(), { bars: 2 }));
}

/** Recorded from the engine as it was before the mixer's stages were made on demand. */
const GOLDEN = {
  mix: '1b1e6e083b366099f93fdff48e2651b6337c0e29fcf6dda28272c575b3e339da',
  mutedChannelAndInsert: 'd059e21a23dda66b1c7c3f8e8ed02a7f2573bf616ead64a1f307c13fd0974d6e',
  soloedInsert: '447e3031268c7a3f00a18b89ff0ab08df964b1ae056ac100579f9a3f633f2e53',
} as const;

describe('the mixer renders what it always did', () => {
  it('a mix with pan, volume, sends, a bus and latency compensation', async () => {
    const { project, patternId } = mixerProject();
    expect(await render(project, patternId)).toBe(GOLDEN.mix);
  });

  it('a muted channel and a muted insert (the mute gates, made when first needed)', async () => {
    const { project, patternId, channels, inserts } = mixerProject();
    const muted = produce(project, (d) => {
      setChannelProp(d, channels[1] as ChannelId, 'muted', true);
      setInsertProp(d, inserts[1] as InsertId, 'muted', true);
    });
    expect(await render(muted, patternId)).toBe(GOLDEN.mutedChannelAndInsert);
  });

  it('a soloed insert, which leaves the others out', async () => {
    const { project, patternId, inserts } = mixerProject();
    const soloed = produce(project, (d) => toggleSoloInsert(d, inserts[0] as InsertId));
    expect(await render(soloed, patternId)).toBe(GOLDEN.soloedInsert);
  });
});
