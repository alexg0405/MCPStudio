import { describe, expect, it } from 'vitest';
import { EV_ALL_OFF, EV_NOTE_OFF, EV_NOTE_ON, EV_PARAM, EV_STRIDE, EV_TRANSPORT, type ToProcessor } from '@agstudio/sdk/protocol';
import { WorkletPortImpl } from './worklet-port';

const SAMPLE_RATE = 48000;

/** Just enough of an AudioWorkletNode for the port: a message port that records what is posted. */
function fakeNode() {
  const posted: ToProcessor[] = [];
  const node = {
    port: { postMessage: (msg: ToProcessor) => posted.push(msg), onmessage: null as unknown },
    onprocessorerror: null as unknown,
    disconnect: () => {},
  };
  return { node: node as unknown as AudioWorkletNode, posted, port: node.port };
}

function makePort(isInstrument = true) {
  const fake = fakeNode();
  const port = new WorkletPortImpl(fake.node, SAMPLE_RATE, () => {}, () => {}, isInstrument);
  const fromProcessor = (msg: unknown) => (fake.port.onmessage as (e: { data: unknown }) => void)({ data: msg });
  return { port, posted: fake.posted, fromProcessor };
}

/** The packed events of every 'ev' message posted so far, as [type, frame] pairs. */
function events(posted: readonly ToProcessor[]): number[][] {
  const out: number[][] = [];
  for (const msg of posted) {
    if (msg.t !== 'ev') continue;
    for (let i = 0; i + EV_STRIDE <= msg.data.length; i += EV_STRIDE) out.push([msg.data[i] as number, msg.data[i + 1] as number]);
  }
  return out;
}

const flush = () => Promise.resolve();

describe('WorkletPortImpl sleep', () => {
  it('starts awake and falls asleep when the processor says so and nothing is in flight', async () => {
    const { port, fromProcessor } = makePort();
    expect(port.sleep.asleep).toBe(false);
    fromProcessor({ t: 'sleep', received: 0 });
    expect(port.sleep.asleep).toBe(true);
  });

  it('ignores a sleep report that was made before a message the host has since sent', async () => {
    const { port, fromProcessor } = makePort();
    port.noteOn({ time: 1, noteId: 1, key: 60, velocity: 1 });
    await flush();
    // The processor had taken in none of the messages sent so far when it fell asleep.
    fromProcessor({ t: 'sleep', received: 0 });
    expect(port.sleep.asleep).toBe(false);
    fromProcessor({ t: 'sleep', received: 1 });
    expect(port.sleep.asleep).toBe(true);
  });

  it('wakes for a note and sends it; a sleeping instrument drops a note off and an all-notes-off', async () => {
    const { port, posted, fromProcessor } = makePort();
    fromProcessor({ t: 'sleep', received: 0 });
    const woke: boolean[] = [];
    port.sleep.onChange((asleep) => woke.push(asleep));
    port.noteOff({ time: 1, noteId: 1, key: 60 });
    port.allNotesOff(1);
    await flush();
    expect(events(posted)).toEqual([]);
    expect(port.sleep.asleep).toBe(true);
    port.noteOn({ time: 2, noteId: 2, key: 62, velocity: 1 });
    await flush();
    expect(woke).toEqual([false]);
    expect(events(posted)).toEqual([[EV_NOTE_ON, 2 * SAMPLE_RATE]]);
  });

  it('an effect follows notes, so a note off or an all-notes-off wakes it', async () => {
    const { port, posted, fromProcessor } = makePort(false);
    fromProcessor({ t: 'sleep', received: 0 });
    port.noteOff({ time: 1, noteId: 1, key: 60 });
    await flush();
    expect(port.sleep.asleep).toBe(false);
    expect(events(posted)).toEqual([[EV_NOTE_OFF, SAMPLE_RATE]]);
    fromProcessor({ t: 'sleep', received: 1 });
    port.allNotesOff(2);
    await flush();
    expect(events(posted).map(([type]) => type)).toEqual([EV_NOTE_OFF, EV_ALL_OFF]);
  });

  it('holds param changes and transport anchors while asleep and sends them, in front, when a note wakes it', async () => {
    const { port, posted, fromProcessor } = makePort();
    fromProcessor({ t: 'sleep', received: 0 });
    port.param(3, 0.5, 1);
    port.param(3, 0.75, 2);
    port.transport(1, 4, true, 120, true);
    port.transport(2, 8, true, 120, false);
    await flush();
    expect(posted).toEqual([]);
    port.noteOn({ time: 3, noteId: 1, key: 60, velocity: 1 });
    await flush();
    const types = events(posted).map(([type]) => type);
    expect(types).toEqual([EV_PARAM, EV_TRANSPORT, EV_TRANSPORT, EV_NOTE_ON]);
    // Only the latest value of a param is kept.
    const first = posted[0];
    expect(first?.t === 'ev' && first.data[4]).toBe(0.75);
  });

  it('a replanned anchor makes the held ones from its time on stale, and few are kept', async () => {
    const { port, posted, fromProcessor } = makePort();
    fromProcessor({ t: 'sleep', received: 0 });
    port.transport(1, 1, true, 120, false);
    port.transport(2, 2, true, 120, false);
    port.transport(1.5, 3, true, 120, true);
    for (let i = 0; i < 20; i++) port.transport(10 + i, i, true, 120, false);
    port.noteOn({ time: 40, noteId: 1, key: 60, velocity: 1 });
    await flush();
    const frames = events(posted).filter(([type]) => type === EV_TRANSPORT);
    expect(frames.length).toBe(8);
    expect(frames.every(([, frame]) => (frame as number) >= 10 * SAMPLE_RATE)).toBe(true);
  });

  it('a message that may start sound (state, a custom message, a reset) wakes it; a sync barrier does not', async () => {
    const { port, posted, fromProcessor } = makePort();
    fromProcessor({ t: 'sleep', received: 0 });
    void port.sync();
    expect(port.sleep.asleep).toBe(true);
    expect(posted.map((m) => m.t)).toEqual(['sync']);
    port.setState({ a: 1 });
    expect(port.sleep.asleep).toBe(false);
    expect(posted.map((m) => m.t)).toEqual(['sync', 'state']);
  });

  it('releases what it held when the processor wakes by itself', async () => {
    const { port, posted, fromProcessor } = makePort(true);
    fromProcessor({ t: 'sleep', received: 0 });
    port.param(1, 0.3, 1);
    await flush();
    expect(posted).toEqual([]);
    fromProcessor({ t: 'wake' });
    await flush();
    expect(port.sleep.asleep).toBe(false);
    expect(events(posted)).toEqual([[EV_PARAM, SAMPLE_RATE]]);
  });

  it('an effect wakes when sound reaches it, which the host does not see: its params and anchors are never held back', async () => {
    const { port, posted, fromProcessor } = makePort(false);
    fromProcessor({ t: 'sleep', received: 0 });
    port.param(1, 0.3, 1);
    port.transport(1, 4, true, 120, true);
    await flush();
    expect(events(posted)).toEqual([
      [EV_PARAM, SAMPLE_RATE],
      [EV_TRANSPORT, SAMPLE_RATE],
    ]);
    // Sending them did not wake it as far as the host is concerned.
    expect(port.sleep.asleep).toBe(true);
  });
});
