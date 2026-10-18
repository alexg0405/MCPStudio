/**
 * "Listen to this take": the engine hears one take on its own while the document stays exactly as it was (session
 * state, no undo entry), and it goes back to the comp when asked, when the take goes away, or on undo.
 */
import { describe, expect, it } from 'vitest';
import { registerFeatures } from '@ui/features';
import { constantTempo } from '@core/time/ppq';
import type { AudioClip, AudioClipChannel, Project, SampleId } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addTakeGroup, newTakeGroup } from '@core/ops/comp';
import { removeClips } from '@core/ops/playlist';
import { auditionProject, takeClipOnLane, takeGroups } from '@core/query/takes';
import { createTestServices } from '@app/testing';
import { listenToTake } from '@app/actions/comp';

const tempo = constantTempo(120);

function setup() {
  const s = createTestServices();
  registerFeatures(s);
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: 'ch_rec' as AudioClipChannel['id'],
    name: 'Recording 1',
    color: '#fff',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: 'master' as never,
    sampleId: 'smp_rec' as SampleId,
  };
  const group = newTakeGroup();
  s.history.transact('Record', (d) => {
    addSample(d, { id: 'smp_rec' as SampleId, name: 'rec', source: { kind: 'builtin', generator: 'x', version: 1 } });
    addChannel(d, channel);
    addTakeGroup(d, {
      group,
      name: 'Recording 1',
      channelId: channel.id,
      takes: [0, 1, 2].map((i) => ({ start: 0, length: 7680, offsetSec: i * 4 })),
      audible: 2,
      first: 0,
      tempo,
    });
  });
  const project = () => s.doc.getState().project;
  const g = () => takeGroups(project()).find((x) => x.id === group)!;
  return { s, project, g, group };
}

const heardClips = (p: Project) =>
  (Object.values(p.playlist.clips) as AudioClip[]).filter((c) => c.take && !c.muted).map((c) => `${c.take!.comp ? 'comp' : 'take'}${c.take!.index}`);

describe('auditionProject', () => {
  it('plays only the listened take of its recording and leaves the document alone', () => {
    const { project, g } = setup();
    const p = project();
    const take0 = g().takes[0]!.clips[0]!;
    expect(heardClips(p)).toEqual(['comp2']);
    const heard = auditionProject(p, take0.id);
    expect(heardClips(heard)).toEqual(['take0']);
    // The take's own track is audible even when muted, and the real project still has the take muted.
    expect(p.playlist.clips[take0.id]!.muted).toBe(true);
    expect(auditionProject(p, take0.id)).toBe(heard);
    // The comp clip is not a take; nothing to listen to alone.
    expect(auditionProject(p, g().comp[0]!.id)).toBe(p);
    expect(auditionProject(p, null)).toBe(p);
  });

  it('makes the take audible when its track is muted or another track is soloed', () => {
    const { s, project, g } = setup();
    const take1 = g().takes[1]!.clips[0]!;
    s.history.transact('Mute and solo', (d) => {
      d.playlist.lanes[take1.laneId]!.muted = true;
      d.playlist.lanes[d.playlist.laneOrder[8]!]!.solo = true;
    });
    const heard = auditionProject(project(), take1.id);
    expect(heard.playlist.lanes[take1.laneId]!.muted).toBe(false);
    expect(heard.playlist.lanes[take1.laneId]!.solo).toBe(true);
  });

  it('takeClipOnLane finds the take of a take track only', () => {
    const { project, g } = setup();
    const lane = g().takeLanes[0]!;
    expect(takeClipOnLane(project(), lane)).toBe(g().takes[2]!.clips[0]!.id);
    expect(takeClipOnLane(project(), g().compLane!)).toBeNull();
  });
});

describe('listen to this take', () => {
  it('sends the engine the solo project, takes no undo step and goes back on the second call', () => {
    const { s, project, g } = setup();
    const take0 = g().takes[0]!.clips[0]!.id;
    const before = s.history.status();
    const docBefore = project();
    expect(listenToTake(s, take0)).toBe(take0);
    expect(s.editor.getState().auditionTake).toBe(take0);
    expect(project()).toBe(docBefore);
    expect(s.history.status()).toEqual(before);
    const last = () => s.fakeEngine.changes[s.fakeEngine.changes.length - 1]!.next;
    expect(heardClips(last())).toEqual(['take0']);
    // The next edit reaches the engine still with only that take heard.
    s.history.transact('Rename', (d) => void (d.playlist.lanes[d.playlist.laneOrder[9]!]!.name = 'Bass'));
    expect(heardClips(last())).toEqual(['take0']);
    expect(heardClips(project())).toEqual(['comp2']);
    // Again: back to the comp.
    expect(listenToTake(s, take0)).toBeNull();
    expect(heardClips(last())).toEqual(['comp2']);
  });

  it('the command listens, switches to another take, and goes back with on: false', async () => {
    const { s, g } = setup();
    await s.commands.run('comp.listenTake', { take: 1 });
    expect(s.editor.getState().auditionTake).toBe(g().takes[0]!.clips[0]!.id);
    await s.commands.run('comp.listenTake', { take: 2 });
    expect(s.editor.getState().auditionTake).toBe(g().takes[1]!.clips[0]!.id);
    await s.commands.run('comp.listenTake', { on: false });
    expect(s.editor.getState().auditionTake).toBeNull();
    // With nothing selected and one being heard, the bare command stops it.
    await s.commands.run('comp.listenTake', { take: 3 });
    expect(s.editor.getState().auditionTake).not.toBeNull();
    await s.commands.run('comp.listenTake', {});
    expect(s.editor.getState().auditionTake).toBe(g().takes[2]!.clips[0]!.id);
  });

  it('goes back to the comp when the take is deleted or the recording is undone', () => {
    const { s, g } = setup();
    const take0 = g().takes[0]!.clips[0]!.id;
    listenToTake(s, take0);
    s.history.transact('Delete take', (d) => removeClips(d, [take0]));
    expect(s.editor.getState().auditionTake).toBeNull();
    const last = s.fakeEngine.changes[s.fakeEngine.changes.length - 1]!.next;
    expect(heardClips(last)).toEqual(['comp2']);
  });

  it('only a take clip can be listened to', () => {
    const { s, g } = setup();
    expect(listenToTake(s, g().comp[0]!.id)).toBeNull();
    expect(listenToTake(s, null)).toBeNull();
  });
});
