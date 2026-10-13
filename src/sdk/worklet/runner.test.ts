import { describe, expect, it } from 'vitest';
import { EV_ALL_OFF, EV_NOTE_OFF, EV_NOTE_ON, EV_STRIDE, type FromProcessor } from '../protocol';
import { EventQueue } from './event-queue';
import { EffectKernel, InstrumentKernel, type KernelHost } from './kernel';
import { KernelRunner } from './runner';
import { VoicePool, type Voice } from './voice-pool';

const host: KernelHost = { sampleRate: 48000, state: undefined, post: () => {}, rand: () => 0.5 };

/** Writes 1.0 at each note-on frame and records calls. */
class Impulse extends InstrumentKernel {
  calls: string[] = [];
  private pending = false;
  noteOn(key: number, _v: number, id: number) {
    this.calls.push(`on:${id}:${key}`);
    this.pending = true;
  }
  noteOff(id: number) {
    this.calls.push(`off:${id}`);
  }
  override allNotesOff(hard: boolean) {
    this.calls.push(`all:${hard}`);
  }
  render(out: Float32Array[], from: number, to: number) {
    if (this.pending && from < to) {
      for (const ch of out) ch[from] = 1;
      this.pending = false;
    }
  }
}

function pack(...events: number[][]): Float64Array {
  const data = new Float64Array(events.length * EV_STRIDE);
  events.forEach((e, i) => data.set(e, i * EV_STRIDE));
  return data;
}

function block(n = 128) {
  return [[new Float32Array(n), new Float32Array(n)]];
}

describe('EventQueue', () => {
  it('keeps events sorted and stable for equal frames', () => {
    const q = new EventQueue(2);
    q.push(EV_NOTE_ON, 300, 1, 60, 1, 0);
    q.push(EV_NOTE_ON, 100, 2, 61, 1, 0);
    q.push(EV_NOTE_ON, 300, 3, 62, 1, 0);
    q.push(EV_NOTE_ON, 200, 4, 63, 1, 0); // forces growth
    const ev = { type: 0, frame: 0, id: 0, key: 0, vel: 0, pan: 0, fine: 0 };
    const ids: number[] = [];
    while (q.shift(ev)) ids.push(ev.id);
    expect(ids).toEqual([2, 4, 1, 3]);
  });

  it('cancels a pending note when its noteOff is at or before its start', () => {
    const q = new EventQueue();
    q.push(EV_NOTE_ON, 500, 7, 60, 1, 0);
    q.push(EV_NOTE_OFF, 500, 7, 60, 0, 0);
    expect(q.length).toBe(0);
    q.push(EV_NOTE_ON, 500, 8, 60, 1, 0);
    q.push(EV_NOTE_OFF, 900, 8, 60, 0, 0);
    expect(q.length).toBe(2);
  });

  it('allNotesOff drops already-queued later events', () => {
    const q = new EventQueue();
    q.push(EV_NOTE_ON, 100, 1, 60, 1, 0);
    q.push(EV_NOTE_ON, 900, 2, 60, 1, 0);
    q.push(EV_ALL_OFF, 500, 0, 0, 0, 0);
    q.push(EV_NOTE_ON, 600, 3, 60, 1, 0); // arrives after: kept
    const ev = { type: 0, frame: 0, id: 0, key: 0, vel: 0, pan: 0, fine: 0 };
    const seen: string[] = [];
    while (q.shift(ev)) seen.push(`${ev.type}@${ev.frame}`);
    expect(seen).toEqual([`${EV_NOTE_ON}@100`, `${EV_ALL_OFF}@500`, `${EV_NOTE_ON}@600`]);
  });
});

describe('KernelRunner', () => {
  it('renders events on their exact frame inside a block', () => {
    const k = new Impulse(host);
    const r = new KernelRunner(k, () => {});
    r.onMessage({ t: 'ev', data: pack([EV_NOTE_ON, 1000 + 37, 1, 60, 1, 0], [EV_NOTE_ON, 1000 + 99, 2, 62, 1, 0]) });
    const out = block();
    r.process([], out, {}, 1000);
    const ch = out[0]![0]!;
    expect([...ch.keys()].filter((i) => ch[i] === 1)).toEqual([37, 99]);
    expect(k.calls).toEqual(['on:1:60', 'on:2:62']);
  });

  it('plays late events at the start of the next block', () => {
    const k = new Impulse(host);
    const r = new KernelRunner(k, () => {});
    r.onMessage({ t: 'ev', data: pack([EV_NOTE_ON, 10, 1, 60, 1, 0]) });
    const out = block();
    r.process([], out, {}, 5000);
    expect(out[0]![0]![0]).toBe(1);
  });

  it('works with non-128 blocks and compensates a stale currentFrame', () => {
    const k = new Impulse(host);
    const r = new KernelRunner(k, () => {});
    r.process([], block(256), {}, 0);
    // Stale frame: the runner assumes it advanced by one block (256).
    r.onMessage({ t: 'ev', data: pack([EV_NOTE_ON, 256 + 5, 1, 60, 1, 0]) });
    const out = block(256);
    r.process([], out, {}, 0);
    expect(out[0]![0]![5]).toBe(1);
  });

  it('isolates exceptions and reports one fault', () => {
    class Boom extends InstrumentKernel {
      noteOn() {
        throw new Error('bad note');
      }
      noteOff() {}
      render(out: Float32Array[], from: number, to: number) {
        for (const ch of out) ch.fill(0.5, from, to);
      }
    }
    const msgs: FromProcessor[] = [];
    const r = new KernelRunner(new Boom(host), (m) => msgs.push(m));
    r.onMessage({ t: 'ev', data: pack([EV_NOTE_ON, 64, 1, 60, 1, 0]) });
    const out = block();
    expect(r.process([], out, {}, 0)).toBe(true);
    expect(msgs).toEqual([{ t: 'fault', error: 'Error: bad note' }]);
    expect(out[0]!.every((ch) => ch.every((x) => x === 0))).toBe(true); // a faulted instrument goes silent
    r.process([], block(), {}, 128);
    expect(msgs).toHaveLength(1);
  });

  it('scrubs NaN and bypasses a broken effect', () => {
    class Nan extends EffectKernel {
      resets = 0;
      process(_i: Float32Array[], o: Float32Array[]) {
        o[0]![3] = NaN;
      }
      override reset() {
        this.resets++;
      }
    }
    const msgs: FromProcessor[] = [];
    const k = new Nan(host);
    const r = new KernelRunner(k, (m) => msgs.push(m));
    const input = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.25)];
    const out = block();
    r.process([input], out, {}, 0);
    expect(out[0]!.every((ch) => ch.every((x) => x === 0))).toBe(true);
    expect(k.resets).toBe(1);
    expect(msgs).toEqual([{ t: 'nan' }]);

    class Throws extends EffectKernel {
      process() {
        throw new Error('nope');
      }
    }
    const r2 = new KernelRunner(new Throws(host), () => {});
    const out2 = block();
    r2.process([input], out2, {}, 0);
    expect(out2[0]![1]![10]).toBe(0.25);
  });

  it('answers sync barriers in order and stops when disposed', () => {
    const msgs: FromProcessor[] = [];
    const r = new KernelRunner(new Impulse(host), (m) => msgs.push(m));
    r.onMessage({ t: 'sync', id: 4 });
    r.onMessage({ t: 'dispose' });
    expect(msgs).toEqual([{ t: 'sync', id: 4 }]);
    expect(r.process([], block(), {}, 0)).toBe(false);
  });
});

describe('VoicePool', () => {
  class V implements Voice {
    noteId = -1;
    key = 0;
    active = false;
    releasing = false;
    age = 0;
  }

  it('reuses free voices, then steals releasing, then oldest', () => {
    const pool = new VoicePool(2, () => new V());
    const a = pool.start(1, 60);
    const b = pool.start(2, 62);
    expect(a).not.toBe(b);
    pool.release(2);
    expect(pool.start(3, 64)).toBe(b); // releasing voice stolen first
    expect(pool.start(4, 65)).toBe(a); // then the oldest
    pool.free(a);
    expect(pool.activeCount).toBe(1);
    expect(pool.find(3)).toBe(b);
  });
});
