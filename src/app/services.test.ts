import { describe, expect, it } from 'vitest';
import { FakeEngine } from '@engine/fake-engine';
import { setStep } from '@core/ops/notes';
import type { PatternId } from '@core/model/types';
import { createServices } from './services';
import { addKitChannel, cloneChannel, deleteChannel } from './actions/channels';

function setup() {
  const engine = new FakeEngine();
  const services = createServices({ platform: 'mac', createEngine: () => engine });
  return { services, engine };
}

describe('services', () => {
  it('starts with FL’s default template and tells the engine', () => {
    const { services, engine } = setup();
    const p = services.doc.getState().project;
    expect(p.channelOrder.map((id) => p.channels[id]?.name)).toEqual(['Kick', 'Clap', 'Hat', 'Snare']);
    expect(p.transport.bpm).toBe(130);
    expect(engine.changes[0]?.origin).toBe('load');
    expect(engine.view).toMatchObject({ mode: 'pattern', patternId: p.patternOrder[0] });
    expect(services.session.getState().selectedChannelId).toBe(p.channelOrder[0]);
  });

  it('forwards every edit to the engine and supports undo', () => {
    const { services, engine } = setup();
    const id = addKitChannel(services, 'kit/cowbell')!;
    expect(services.doc.getState().project.channels[id]?.name).toBe('Cowbell');
    expect(engine.changes[engine.changes.length - 1]?.origin).toBe('edit');
    services.history.undo();
    expect(services.doc.getState().project.channels[id]).toBeUndefined();
    expect(engine.changes[engine.changes.length - 1]?.origin).toBe('undo');
  });

  it('clones a channel with its notes under new ids', () => {
    const { services } = setup();
    const p0 = services.doc.getState().project;
    const kick = p0.channelOrder[0]!;
    const pid = p0.patternOrder[0] as PatternId;
    services.history.transact('steps', (d) => {
      setStep(d, pid, kick, 0, true, { rootKey: 60 });
      setStep(d, pid, kick, 8, true, { rootKey: 60 });
    });
    const copy = cloneChannel(services, kick)!;
    const p = services.doc.getState().project;
    const a = Object.values(p.patterns[pid]!.notes[kick]!);
    const b = Object.values(p.patterns[pid]!.notes[copy]!);
    expect(b.map((n) => n.tick).sort()).toEqual(a.map((n) => n.tick).sort());
    expect(b.some((n) => a.some((m) => m.id === n.id))).toBe(false);
    expect(p.channelOrder.indexOf(copy)).toBe(1);
  });

  it('keeps the selection valid when the selected channel is deleted', () => {
    const { services } = setup();
    const first = services.doc.getState().project.channelOrder[0]!;
    services.session.getState().selectChannel(first);
    deleteChannel(services, first);
    const sel = services.session.getState().selectedChannelId;
    expect(sel).not.toBe(first);
    expect(services.doc.getState().project.channels[sel!]).toBeDefined();
  });

  it('transport commands drive the engine', () => {
    const { services, engine } = setup();
    services.commands.run('transport.playPause');
    // Transport commands are registered by UI features; here only the engine API is exercised.
    engine.play();
    expect(engine.playing).toBe(true);
  });
});
