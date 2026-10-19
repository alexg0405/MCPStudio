import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from '@core/io/wav';
import { analyzeSample } from '@core/samples/analyze';
import type { WorkerReply, WorkerRequest } from './protocol';
import { readForAnalysis } from './read';
import { workerPoolRunner, type DecodeForAnalysis } from './runner';

/**
 * The Worker pool against a stand-in Worker that does what `analysis.worker.ts` does (after a delay set per file name),
 * so the pool's queueing, crash handling, idle stop and fallbacks can be checked in Node. The real Workers are
 * covered by `test/browser/sample-analysis.test.ts`.
 */

const SR = 44100;
const IDLE_MS = 5000;

/** What the stand-in Workers were asked to do, in order ("spawn#1", "post#1:file:1:a.wav", "terminate#1"). */
let events: string[] = [];
let workersMade = 0;
let canMakeWorkers = true;
let delayByPath: Record<string, number> = {};
/** How many files are being worked on at once, and the most there ever were. */
let busy = 0;
let mostBusy = 0;

class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly number = ++workersMade;
  private stopped = false;

  constructor() {
    if (!canMakeWorkers) throw new Error('no workers');
    events.push(`spawn#${this.number}`);
  }

  postMessage(m: WorkerRequest, transfer?: unknown[]): void {
    events.push(`post#${this.number}:${m.kind}:${m.id}:${m.path}${transfer ? ':with-audio' : ''}`);
    busy++;
    mostBusy = Math.max(mostBusy, busy);
    setTimeout(() => void this.work(m), delayByPath[m.path] ?? 10);
  }

  terminate(): void {
    this.stopped = true;
    events.push(`terminate#${this.number}`);
  }

  private answer(reply: WorkerReply): void {
    busy--;
    if (!this.stopped) this.onmessage?.({ data: reply } as MessageEvent<WorkerReply>);
  }

  private async work(m: WorkerRequest): Promise<void> {
    if (this.stopped) return void busy--;
    if (m.path.startsWith('crash')) {
      busy--;
      this.onerror?.();
      return;
    }
    if (m.kind === 'audio') {
      return this.answer({ id: m.id, ok: true, analysis: analyzeSample(m.channels, m.sampleRate, { path: m.path, durationSec: m.durationSec }) });
    }
    const read = await readForAnalysis(m.file);
    if (read.kind === 'audio') return this.answer({ id: m.id, ok: true, analysis: analyzeSample(read.channels, read.sampleRate, { path: m.path, durationSec: read.durationSec }) });
    if (read.kind === 'needs-decode') return this.answer({ id: m.id, ok: false, reason: 'needs-decode', durationSec: read.durationSec });
    this.answer({ id: m.id, ok: false, reason: 'unreadable' });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  workersMade = 0;
  canMakeWorkers = true;
  delayByPath = {};
  busy = 0;
  mostBusy = 0;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

/** A decaying sine as a WAV file. */
function tone(hz: number): File {
  const x = new Float32Array(Math.round(0.2 * SR));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR) * Math.exp((-3 * i) / x.length);
  return new File([encodeWav([x], SR, { bitDepth: 16 }).slice().buffer], 'x.wav');
}
/** Bytes no Worker can read: the browser has to decode them (an MP3, say). */
const needsBrowserDecode = () => new File([new Uint8Array(200).fill(7)], 'song.mp3');
const tooSmall = () => new File([new Uint8Array(10)], 'tiny.wav');

const decodesToSound: DecodeForAnalysis = async () => ({ channels: [new Float32Array(SR / 2).map((_, i) => 0.4 * Math.sin(i / 20))], sampleRate: SR, durationSec: 0.5 });
const passed = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('workerPoolRunner', () => {
  it('uses at most `size` Workers, finishes files out of order, and analyzes them all', async () => {
    const pool = workerPoolRunner(2);
    delayByPath = { 'a.wav': 50, 'b.wav': 5, 'c.wav': 30, 'd.wav': 5 };
    const done: string[] = [];
    const runs = ['a', 'b', 'c', 'd'].map((n, i) => pool.run(tone(300 + 100 * i), `${n}.wav`).then((a) => (done.push(n), a)));
    await passed(200);
    const results = await Promise.all(runs);
    expect(results.every((a) => a !== null)).toBe(true);
    expect(workersMade).toBe(2);
    expect(mostBusy).toBe(2);
    // The second Worker is free again after 5 ms and takes c (done at 35 ms) and d (at 40 ms) while the first is still on a (50 ms).
    expect(done).toEqual(['b', 'c', 'd', 'a']);
  });

  it('one Worker takes the files strictly in the order they were asked for', async () => {
    const pool = workerPoolRunner(1);
    const runs = ['a', 'b', 'c'].map((n, i) => pool.run(tone(300 + 50 * i), `${n}.wav`));
    await passed(100);
    await Promise.all(runs);
    expect(events.filter((e) => e.startsWith('post')).map((e) => e.split(':')[3])).toEqual(['a.wav', 'b.wav', 'c.wav']);
    expect(mostBusy).toBe(1);
  });

  it('answers null for a file nothing can read, and has the browser decode what a Worker cannot', async () => {
    const pool = workerPoolRunner(2, decodesToSound);
    const [tiny, song] = [pool.run(tooSmall(), 'tiny.wav'), pool.run(needsBrowserDecode(), 'song.mp3')];
    await passed(200);
    expect(await tiny).toBeNull();
    expect(await song).not.toBeNull();
    // The decoded audio went back to a Worker as a second message for the same file.
    expect(events.filter((e) => e.includes('song.mp3')).map((e) => e.split(':').slice(1, 2)[0])).toEqual(['file', 'audio']);
    expect(events.some((e) => e.endsWith('song.mp3:with-audio'))).toBe(true);
  });

  it('answers null when the browser cannot decode the file', async () => {
    for (const decode of [async () => null, async () => Promise.reject(new Error('decoder blew up'))] as DecodeForAnalysis[]) {
      const pool = workerPoolRunner(1, decode);
      const run = pool.run(needsBrowserDecode(), 'song.mp3');
      await passed(100);
      expect(await run).toBeNull();
      pool.dispose();
    }
  });

  it('loses only the file a crashed Worker was on, and starts a new Worker for the rest', async () => {
    const pool = workerPoolRunner(1);
    const runs = [pool.run(tone(300), 'a.wav'), pool.run(tone(400), 'crash.wav'), pool.run(tone(500), 'c.wav')];
    await passed(200);
    const [a, crashed, c] = await Promise.all(runs);
    expect(a).not.toBeNull();
    expect(crashed).toBeNull();
    expect(c).not.toBeNull();
    expect(workersMade).toBe(2);
    expect(events).toContain('terminate#1');
  });

  it('analyzes the queue on this thread when no Worker can be made', async () => {
    canMakeWorkers = false;
    const pool = workerPoolRunner(3, decodesToSound);
    const runs = [pool.run(tone(300), 'a.wav'), pool.run(needsBrowserDecode(), 'b.mp3'), pool.run(tooSmall(), 'c.wav')];
    await passed(100);
    const [a, b, c] = await Promise.all(runs);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();
    expect(events).toEqual([]);
  });

  it('stops the Workers when they have been idle for a while, and makes new ones later', async () => {
    const pool = workerPoolRunner(2);
    await Promise.all([pool.run(tone(300), 'a.wav'), pool.run(tone(500), 'b.wav')].map(async (run) => (await passed(100), run)));
    await passed(IDLE_MS - 200);
    expect(events.filter((e) => e.startsWith('terminate'))).toEqual([]);
    await passed(300);
    expect(events.filter((e) => e.startsWith('terminate')).sort()).toEqual(['terminate#1', 'terminate#2']);
    const again = pool.run(tone(700), 'c.wav');
    await passed(100);
    expect(await again).not.toBeNull();
    expect(workersMade).toBe(3);
  });

  it('a file asked for during the idle wait keeps the Workers alive another idle time', async () => {
    const pool = workerPoolRunner(1);
    const first = pool.run(tone(300), 'a.wav');
    await passed(100);
    await first;
    await passed(3000);
    const second = pool.run(tone(500), 'b.wav');
    await passed(100);
    await second;
    await passed(IDLE_MS - 200);
    expect(events.filter((e) => e.startsWith('terminate'))).toEqual([]);
    await passed(300);
    expect(events.filter((e) => e.startsWith('terminate'))).toEqual(['terminate#1']);
  });

  it('dispose answers queued and running files with null, stops the Workers, and the pool can be used again', async () => {
    const pool = workerPoolRunner(1);
    delayByPath = { 'a.wav': 500 };
    const runs = ['a', 'b', 'c'].map((n, i) => pool.run(tone(300 + 100 * i), `${n}.wav`));
    await passed(20);
    pool.dispose();
    expect(await Promise.all(runs)).toEqual([null, null, null]);
    expect(events).toContain('terminate#1');
    delayByPath = {};
    const again = pool.run(tone(900), 'again.wav');
    await passed(100);
    expect(await again).not.toBeNull();
    pool.dispose();
    pool.dispose();
  });
});
