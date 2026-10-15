/**
 * Songs that flow, measured: a 36-bar 140 BPM song arranged by the `arrange` action (Intro 4,
 * Verse 8, Build 4, Drop 8, Break 4, Outro 8), rendered offline at 48 kHz in windows of at most 8
 * bars. The bar before the drop goes quiet in the lows (the gap), the riser swells, the reverse crash
 * peaks right on the downbeat, the impact hits it, and the drop is louder than the verse.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { measure } from '@app/analysis/measure';
import type { Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { LinkwitzRiley } from '@agstudio/sdk';
import { BAR, BEAT, flowSong } from '../helpers/arrange';
import { onsets } from '../helpers/fixtures';

const SR = 48000;
const LIMITER = Math.round(0.0013 * SR);

type Song = Awaited<ReturnType<typeof flowSong>>;

/** Renders [fromTick, fromTick + bars) with only the tracks `only` names audible; maps song ticks to frames. */
async function render(song: Song, fromTick: number, bars: number, only?: (lane: string) => boolean) {
  const project: Project = only
    ? produce(song.project, (d) => {
        for (const id of d.playlist.laneOrder) if (!only(d.playlist.lanes[id]!.name)) d.playlist.lanes[id]!.muted = true;
      })
    : song.project;
  const res = await renderOffline(project, {
    plugins: song.s.plugins,
    view: { mode: 'song', patternId: project.patternOrder[0]!, loop: null },
    bars,
    fromTick,
    sampleRate: SR,
    tail: 0.25,
  });
  const spt = 60 / (project.transport.bpm * 960);
  const frameOf = (tick: number) => Math.round((res.preRoll + res.latency + (tick - fromTick) * spt) * SR) + LIMITER;
  return { buffer: res.buffer, frameOf };
}

function rmsDb(chs: Float32Array[], from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (const ch of chs)
    for (let i = Math.max(0, from); i < Math.min(ch.length, to); i++) {
      sum += ch[i]! * ch[i]!;
      n++;
    }
  return 10 * Math.log10(sum / Math.max(1, n) + 1e-20);
}

/** The low band (below 150 Hz) of the mid signal. */
function lowBand(buffer: AudioBuffer): Float32Array {
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const lr = new LinkwitzRiley().set(150, SR);
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) {
    lr.split((l[i]! + r[i]!) / 2);
    out[i] = lr.low;
  }
  return out;
}

describe('a song that flows', () => {
  const songs: Song[] = [];
  afterAll(async () => {
    for (const s of songs) await s.s.engine.dispose();
  });
  const make = async () => {
    const s = await flowSong(140);
    songs.push(s);
    return s;
  };

  it('arranges without warnings', async () => {
    const song = await make();
    expect(song.res.warnings).toEqual([]);
    expect(song.res.changes[0]).toMatch(/^Arranged 36 bars: Intro 1–4 · Verse 5–12 · Build 13–16 · Drop 17–24 · Break 25–28 · Outro 29–36 · /);
  });

  it('leaves a gap before the drop: the lows of its last beat are 12 dB under the same beat a bar earlier', async () => {
    const song = await make();
    const X = song.drop;
    const { buffer, frameOf } = await render(song, X - 3 * BAR, 4);
    const low = lowBand(buffer);
    const gap = rmsDb([low], frameOf(X - BEAT), frameOf(X));
    const before = rmsDb([low], frameOf(X - BAR - BEAT), frameOf(X - BAR));
    expect(before - gap).toBeGreaterThanOrEqual(12);
  }, 120_000);

  it('the riser swells 15 dB into its last beat, the reverse crash peaks within 30 ms before the drop', async () => {
    const song = await make();
    const X = song.drop;
    const fx = await render(song, X - 4 * BAR, 5, (lane) => lane === 'FX risers' || lane === 'FX swells');
    const chs = [fx.buffer.getChannelData(0), fx.buffer.getChannelData(1)];
    const start = rmsDb(chs, fx.frameOf(X - 4 * BAR), fx.frameOf(X - 4 * BAR + BEAT));
    const last = rmsDb(chs, fx.frameOf(X - BEAT), fx.frameOf(X));
    expect(last - start).toBeGreaterThanOrEqual(15);
    // The same render twice is the same audio.
    const again = await render(song, X - 4 * BAR, 5, (lane) => lane === 'FX risers' || lane === 'FX swells');
    expect(again.buffer.getChannelData(0)).toEqual(fx.buffer.getChannelData(0));

    const swell = await render(song, X - BAR, 2, (lane) => lane === 'FX swells');
    const data = swell.buffer.getChannelData(0);
    let peak = 0;
    let at = 0;
    for (let i = 0; i < data.length; i++)
      if (Math.abs(data[i]!) > peak) {
        peak = Math.abs(data[i]!);
        at = i;
      }
    const x = swell.frameOf(X);
    expect(at).toBeGreaterThanOrEqual(x - Math.round(0.03 * SR));
    expect(at).toBeLessThanOrEqual(x + Math.round(0.002 * SR));
  }, 120_000);

  it('an impact hits on the downbeat of the drop (±5 ms)', async () => {
    const song = await make();
    const X = song.drop;
    const hits = await render(song, X - BAR, 2, (lane) => lane === 'FX hits');
    const found = onsets(hits.buffer, 0.02, 0.2);
    expect(found.length).toBeGreaterThan(0);
    expect(Math.abs(found[0]! - hits.frameOf(X))).toBeLessThanOrEqual(Math.round(0.005 * SR));
  }, 120_000);

  it('the drop is at least 2 dB louder than the verse', async () => {
    const song = await make();
    const verse = await render(song, song.verse, 8);
    const drop = await render(song, song.drop, 8);
    const lufs = (r: { buffer: AudioBuffer }) => measure(r.buffer.getChannelData(0), r.buffer.getChannelData(1), SR).lufs;
    expect(lufs(drop) - lufs(verse)).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
