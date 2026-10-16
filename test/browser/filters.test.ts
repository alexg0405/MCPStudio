/**
 * Sound filters on a real render: Nightcore on bars 5–8 plays that part 25 % faster and about 4
 * semitones higher (the rest of the song arrives earlier by what it saves), Telephone keeps only
 * the phone band, and Undo puts everything back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createServices, type Services } from '@app/services';
import { applyFilter, removeFilter } from '@app/filters/apply';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { tempoMapOf } from '@core/automation/tempo';
import { rangeTarget } from '@core/filters/target';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { ChannelId, ClipId, LaneId, NoteId, PatternId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { renderOffline } from '@engine/render-offline';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import { autocorrelationPitch } from '../helpers/audio';
import { onsets } from '../helpers/fixtures';
import { noise, tone } from '../helpers/tone';

const BAR = 3840;

/** 12 bars at 120 BPM: one note per bar (¾ bar long, then quiet) in three 4-bar clips on track 1. */
function song(def: PluginDef): Project {
  let p = createEmptyProject();
  const pid = p.patternOrder[0] as PatternId;
  const ch = makeInstrumentChannel(def.name, makePluginInstance(def.id, def.version, defaultValues(def.params)));
  p = produce(p, (d) => {
    d.transport.bpm = 120;
    addChannel(d, ch);
    d.patterns[pid]!.length = BAR;
    addNote(d, pid, ch.id, { id: 'n0' as NoteId, tick: 0, length: (3 * BAR) / 4, key: 60, velocity: 1 });
    const lane = d.playlist.laneOrder[0] as LaneId;
    addClips(
      d,
      [0, 1, 2].map((i) => ({ kind: 'pattern' as const, id: `c${i}` as ClipId, laneId: lane, start: i * 4 * BAR, length: 4 * BAR, patternId: pid, offset: 0 })),
    );
  });
  return p;
}

function services(project: Project): Services {
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  plugins.sync('user', [
    { path: 'tone', def: tone },
    { path: 'noise', def: noise },
  ]);
  return createServices({ project, plugins });
}

async function render(s: Services, bars: number): Promise<{ x: Float32Array; sr: number; start: number }> {
  const r = await renderOffline(s.doc.getState().project, {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: 'song', patternId: null, loop: null },
    bars,
    sampleRate: s.engine.sampleRate,
    tail: 1,
    limiter: false,
  });
  return { x: r.buffer.getChannelData(0), sr: r.buffer.sampleRate, start: Math.round((r.preRoll + r.latency) * r.buffer.sampleRate) };
}

/** Average power spectrum (Hann-windowed 8192-point frames) of x[from, to). */
function spectrum(x: Float32Array, from: number, to: number): Float64Array {
  const N = 8192;
  const out = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let at = from; at + N <= to; at += N / 2, frames++) {
    for (let i = 0; i < N; i++) {
      re[i] = (x[at + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) out[k] = out[k]! + re[k]! ** 2 + im[k]! ** 2;
  }
  for (let k = 0; k < N / 2; k++) out[k] = out[k]! / Math.max(1, frames);
  return out;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
  }
}

/** Power of a spectrum between two frequencies, in dB. */
function bandDb(spec: Float64Array, sr: number, lo: number, hi: number): number {
  const bin = sr / (spec.length * 2);
  let sum = 0;
  for (let k = Math.max(1, Math.ceil(lo / bin)); k <= Math.min(spec.length - 1, Math.floor(hi / bin)); k++) sum += spec[k]!;
  return 10 * Math.log10(sum + 1e-30);
}

describe('sound filters', () => {
  const all: Services[] = [];
  afterAll(async () => {
    for (const s of all) await s.engine.dispose();
  });

  it('Nightcore on bars 5–8: 25 % faster, about 4 semitones higher, the rest arrives earlier; undo restores it', async () => {
    const s = services(song(tone));
    all.push(s);
    const before = s.doc.getState().project;
    const a = await render(s, 12);
    const target = rangeTarget(before, 4 * BAR, 8 * BAR)!;
    const res = await applyFilter(s, 'nightcore', target);
    const p = s.doc.getState().project;
    expect(s.history.status().undoLabel).toBe('Nightcore on bars 5–8');
    // The bars stay where they are: the clips after the part are untouched in ticks.
    expect(p.playlist.clips['c2' as ClipId]).toEqual(before.playlist.clips['c2' as ClipId]);
    expect(p.playlist.clips['c1' as ClipId]).toBeUndefined();
    const ch = p.channels[res.channelId];
    expect(ch).toMatchObject({ kind: 'audioClip', filter: { preset: 'nightcore', from: 4 * BAR, to: 8 * BAR } });
    // In time: bars 5–8 take 80 % as long, everything after starts that much earlier.
    const t0 = tempoMapOf(before, 'song');
    const t1 = tempoMapOf(p, 'song');
    const partBefore = t0.tickToSeconds(8 * BAR) - t0.tickToSeconds(4 * BAR);
    const partAfter = t1.tickToSeconds(8 * BAR) - t1.tickToSeconds(4 * BAR);
    expect(partAfter / partBefore).toBeCloseTo(0.8, 4);

    const b = await render(s, 12);
    const onsetsOf = (r: { x: Float32Array; sr: number; start: number }) => {
      const buf = new AudioBuffer({ length: r.x.length, sampleRate: r.sr });
      buf.copyToChannel(r.x as Float32Array<ArrayBuffer>, 0);
      return onsets(buf, 0.05, 0.1).map((f) => (f - r.start) / r.sr);
    };
    const oa = onsetsOf(a);
    const ob = onsetsOf(b);
    expect(oa).toHaveLength(12);
    expect(ob).toHaveLength(12);
    // Bar 9 (the first clip after the part) comes 1.6 s earlier: 20 % of the part's 8 s.
    const earlier = oa[8]! - ob[8]!;
    console.log(`Nightcore bars 5–8: bar 9 earlier by ${earlier.toFixed(4)} s (part ${partBefore} s → ${partAfter.toFixed(4)} s)`);
    expect(earlier).toBeCloseTo(0.2 * partBefore, 2);
    // Inside the part the notes come every 1.6 s instead of every 2 s.
    for (let i = 4; i < 8; i++) expect(ob[i + 1]! - ob[i]!).toBeCloseTo(1.6, 2);
    // Pitch: 1 kHz before, 1.25 kHz in the part (+3.86 semitones); unchanged before and after it.
    const pitch = (r: { x: Float32Array; sr: number; start: number }, at: number) =>
      autocorrelationPitch(r.x, r.sr, r.start + Math.round((at + 0.2) * r.sr), r.start + Math.round((at + 0.6) * r.sr), 200, 2000);
    const hzBefore = pitch(a, oa[5]!);
    const hzAfter = pitch(b, ob[5]!);
    const semis = 12 * Math.log2(hzAfter / hzBefore);
    console.log(`Nightcore pitch: ${hzBefore.toFixed(1)} Hz → ${hzAfter.toFixed(1)} Hz (${semis.toFixed(2)} semitones)`);
    expect(semis).toBeGreaterThan(3.7);
    expect(semis).toBeLessThan(4.0);
    expect(pitch(b, ob[1]!)).toBeCloseTo(hzBefore, 0);
    expect(pitch(b, ob[10]!)).toBeCloseTo(hzBefore, 0);

    // Undo puts back everything (one step).
    s.history.undo();
    const back = s.doc.getState().project;
    expect(back.playlist).toEqual(before.playlist);
    expect(back.channels).toEqual(before.channels);
    expect(back.transport).toEqual(before.transport);
    expect(back.mixer).toEqual(before.mixer);
    const c = await render(s, 12);
    expect(onsetsOf(c)).toEqual(oa);
    // Redo, then Remove filter: the same as before again.
    s.history.redo();
    expect(removeFilter(s, res.channelId).ok).toBe(true);
    expect(s.doc.getState().project.playlist.clips).toEqual(before.playlist.clips);
    expect(s.doc.getState().project.channels).toEqual(before.channels);
  });

  it('Telephone keeps the phone band: the lows below 250 Hz and the highs above 4 kHz go', async () => {
    const s = services(song(noise));
    all.push(s);
    const before = s.doc.getState().project;
    const a = await render(s, 12);
    await applyFilter(s, 'telephone', rangeTarget(before, 4 * BAR, 8 * BAR)!);
    const p = s.doc.getState().project;
    // The timing stays: no tempo change, the clip covers bars 5–8.
    expect(tempoMapOf(p, 'song').bpmAt(5 * BAR)).toBe(120);
    const b = await render(s, 12);
    // Bar 6's note (1.5 s of noise from 10 s) before and after.
    const at = (r: typeof a) => [r.start + Math.round(10.1 * r.sr), r.start + Math.round(11.4 * r.sr)] as const;
    const sa = spectrum(a.x, ...at(a));
    const sb = spectrum(b.x, ...at(b));
    const drop = (lo: number, hi: number) => bandDb(sa, a.sr, lo, hi) - bandDb(sb, b.sr, lo, hi);
    const mid = drop(800, 2000);
    const low = drop(20, 250) - mid;
    const high = drop(4000, 16000) - mid;
    console.log(`Telephone: mid band ${(-mid).toFixed(1)} dB, below 250 Hz ${(-low).toFixed(1)} dB, above 4 kHz ${(-high).toFixed(1)} dB (relative to the mid band)`);
    expect(Math.abs(mid)).toBeLessThan(10);
    expect(low).toBeGreaterThan(20);
    expect(high).toBeGreaterThan(20);
    // The rest of the song is untouched: bar 2 sounds the same.
    const bar2 = (r: typeof a) => [r.start + Math.round(2.1 * r.sr), r.start + Math.round(3.4 * r.sr)] as const;
    expect(Math.abs(bandDb(spectrum(a.x, ...bar2(a)), a.sr, 20, 16000) - bandDb(spectrum(b.x, ...bar2(b)), b.sr, 20, 16000))).toBeLessThan(0.1);
    s.history.undo();
    expect(s.doc.getState().project.playlist).toEqual(before.playlist);
    expect(s.doc.getState().project.mixer).toEqual(before.mixer);
    expect(Object.keys(s.doc.getState().project.channels)).toEqual(Object.keys(before.channels) as ChannelId[]);
  });
});
