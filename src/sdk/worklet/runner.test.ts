import { describe, expect, it } from 'vitest';
import { EV_ALL_OFF, EV_NOTE_OFF, EV_NOTE_ON, EV_STRIDE, EV_TRANSPORT, type FromProcessor } from '../protocol';
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

  it('pads missing inputs and the sidechain with silence, reusing its buffers', () => {
    const seen: { inp: Float32Array[]; sc: Float32Array[] | undefined; silent: boolean[] }[] = [];
    class Keyed extends EffectKernel {
      process(i: Float32Array[], o: Float32Array[], n: number, _p: unknown, sc?: Float32Array[]) {
        const silent = (sc ?? []).map((ch) => ch.every((x) => x === 0));
        seen.push({ inp: [...i], sc: sc ? [...sc] : undefined, silent });
        for (let c = 0; c < o.length; c++) for (let f = 0; f < n; f++) o[c]![f] = (sc?.[c]?.[f] ?? 0) * 2;
        if (sc) sc[0]![0] = 9; // a kernel scribbling on the padding must not leak into the next block
      }
    }
    const r = new KernelRunner(new Keyed(host), () => {});
    const mono = [new Float32Array(128).fill(0.5)];
    r.process([mono, []], block(), {}, 0); // sidechain unconnected or idle
    r.process([[], []], block(), {}, 128);
    const key = [new Float32Array(128).fill(0.25)];
    const out = block();
    r.process([mono, key], out, {}, 256);
    r.process([mono], block(), {}, 384); // not a sidechain effect: no fifth argument
    expect(seen[0]!.inp).toEqual([mono[0], mono[0]]);
    expect(seen[0]!.silent).toEqual([true, true]);
    expect(seen[1]!.sc![0]).toBe(seen[0]!.sc![0]); // same buffer, zeroed again
    expect(seen[1]!.silent).toEqual([true, true]);
    expect(seen[1]!.inp[0]!.length).toBe(128);
    expect(seen[2]!.sc).toEqual([key[0], key[0]]);
    expect(out[0]![0]![5]).toBe(0.5);
    expect(seen[3]!.sc).toBeUndefined();
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

/** Records the transport as the kernel sees it at the first frame of every block. */
class BeatProbe extends InstrumentKernel {
  seen: { playing: boolean; bpm: number; beat: number; beat64: number }[] = [];
  changes = 0;
  noteOn() {}
  noteOff() {}
  override transportChanged() {
    this.changes++;
  }
  render(_out: Float32Array[], from: number) {
    if (from === 0)
      this.seen.push({
        playing: this.transport.playing,
        bpm: this.transport.bpm,
        beat: this.transport.beatAt(0),
        beat64: this.transport.beatAt(64),
      });
  }
}

class EffectProbe extends EffectKernel {
  beats: number[] = [];
  process(input: Float32Array[], output: Float32Array[], n: number) {
    for (let c = 0; c < output.length; c++) output[c]!.set(input[c]!.subarray(0, n));
    this.beats.push(this.transport.beatAt(0));
  }
}

// [EV_TRANSPORT, frame, beat, playing, bpm, replan, 0]
const anchor = (frame: number, beat: number, playing: boolean, bpm: number, replan = false) => [
  EV_TRANSPORT,
  frame,
  beat,
  playing ? 1 : 0,
  bpm,
  replan ? 1 : 0,
  0,
];

describe('kernel transport', () => {
  it('extrapolates the beat from the latest anchor while playing and holds it while stopped', () => {
    const k = new BeatProbe(host);
    const r = new KernelRunner(k, () => {});
    // 120 BPM at 48 kHz: one beat is 24 000 frames.
    r.onMessage({ t: 'ev', data: pack(anchor(0, 4, true, 120), anchor(24_000 * 2, 6, false, 120)) });
    r.process([], block(), {}, 0);
    r.process([], block(), {}, 24_000);
    r.process([], block(), {}, 24_000 * 3);
    expect(k.seen[0]).toEqual({ playing: true, bpm: 120, beat: 4, beat64: 4 + 64 / 24_000 });
    expect(k.seen[1]!.beat).toBeCloseTo(5, 12);
    // Stopped at beat 6: it holds there.
    expect(k.seen[2]).toMatchObject({ playing: false, beat: 6, beat64: 6 });
    expect(k.changes).toBe(2);
  });

  it('applies an anchor at its exact frame inside a block', () => {
    const k = new BeatProbe(host);
    const r = new KernelRunner(k, () => {});
    r.onMessage({ t: 'ev', data: pack(anchor(100, 0, true, 60)) });
    r.process([], block(), {}, 0);
    // The block's first frame came before the anchor: still stopped.
    expect(k.seen[0]).toMatchObject({ playing: false });
    r.process([], block(), {}, 128);
    // 60 BPM: one beat per second.
    expect(k.seen[1]!.beat).toBeCloseTo((128 - 100) / 48_000, 12);
  });

  it('drops queued anchors a re-planned transport supersedes', () => {
    const k = new BeatProbe(host);
    const r = new KernelRunner(k, () => {});
    r.onMessage({ t: 'ev', data: pack(anchor(0, 0, true, 120), anchor(48_000, 2, true, 120)) });
    // A seek at frame 24 000 re-plans: the anchor at 48 000 (from the old plan) is stale.
    r.onMessage({ t: 'ev', data: pack(anchor(24_000, 16, true, 120, true)) });
    r.process([], block(), {}, 0);
    r.process([], block(), {}, 24_000);
    r.process([], block(), {}, 48_000);
    expect(k.seen.map((x) => Math.round(x.beat * 1000) / 1000)).toEqual([0, 16, 17]);
  });

  it('gives effects the transport too', () => {
    const k = new EffectProbe(host);
    const r = new KernelRunner(k, () => {});
    r.onMessage({ t: 'ev', data: pack(anchor(0, 8, true, 120)) });
    const input = [[new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.25)]];
    const out = block();
    r.process(input, out, {}, 0);
    r.process(input, block(), {}, 24_000);
    expect(k.beats[0]).toBe(8);
    expect(k.beats[1]).toBeCloseTo(9, 12);
    expect(out[0]![0]![5]).toBe(0.25);
  });
});
