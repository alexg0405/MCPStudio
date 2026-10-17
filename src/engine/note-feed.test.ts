import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { addChannel, moveChannel } from '@core/ops/channels';
import type { FeedNote } from '@agstudio/sdk';
import { NoteFeedHub } from './note-feed';

const on = (key: number, time = 1): FeedNote => ({ kind: 'on', time, noteId: key, key, velocity: 0.8 });

describe('NoteFeedHub', () => {
  it('hands a listener the notes of the instrument channel at its position, and follows the rack order', () => {
    const a = makeInstrumentChannel('A', makePluginInstance('x', 1, {}));
    const b = makeInstrumentChannel('B', makePluginInstance('x', 1, {}));
    let p = produce(createEmptyProject(), (d) => {
      addChannel(d, a);
      addChannel(d, b);
    });
    const hub = new NoteFeedHub();
    hub.setProject(p);
    const heard: number[] = [];
    const stop = hub.listen(2, (e) => heard.push(e.key));
    hub.emit(a.id, on(60));
    hub.emit(b.id, on(62));
    expect(heard).toEqual([62]);
    expect(hub.channelName(1)).toBe('A');
    expect(hub.channelName(2)).toBe('B');
    expect(hub.channelName(3)).toBeNull();
    // Reordering the rack moves who is second.
    p = produce(p, (d) => moveChannel(d, b.id, 0));
    hub.setProject(p);
    hub.emit(a.id, on(64));
    hub.emit(b.id, on(65));
    expect(heard).toEqual([62, 64]);
    stop();
    hub.emit(a.id, on(67));
    expect(heard).toEqual([62, 64]);
  });

  it('tells every listener when everything stops', () => {
    const hub = new NoteFeedHub();
    const seen: string[] = [];
    hub.listen(1, (e) => seen.push(`1:${e.kind}@${e.time}`));
    hub.listen(5, (e) => seen.push(`5:${e.kind}@${e.time}`));
    hub.emitAllOff(2.5);
    expect(seen).toEqual(['1:allOff@2.5', '5:allOff@2.5']);
  });
});
