import { describe, expect, it } from 'vitest';
import { encodeWav } from '@core/io/wav';
import type { InstrumentChannel } from '@core/model/types';
import { createTestServices } from '../testing';
import { addAudioClip, addSampleChannels, importAudioFile, kitDuration, probeAudio, setChannelSample } from './samples';

function wavFile(name: string, seconds: number, sampleRate = 44100): File {
  const x = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 10) * 0.5;
  return new File([encodeWav([x, x], sampleRate, { bitDepth: 16 }).slice().buffer], name);
}

describe('sample actions', () => {
  it('knows how long built-in sounds last, the arranger’s FX sounds from their names', () => {
    expect(kitDuration('fx/riser/16b@150')).toBeCloseTo(6.4, 9);
    expect(kitDuration('fx/impact/9b@150')).toBeCloseTo(3.6, 9);
    expect(kitDuration('kit/kick')).toBeCloseTo(0.6, 3);
  });

  it('reads duration and layout of a WAV file', async () => {
    const bytes = new Uint8Array(await wavFile('a.wav', 0.25).arrayBuffer());
    expect(await probeAudio(bytes)).toEqual({ durationSec: 0.25, sampleRate: 44100, channels: 2 });
    expect(await probeAudio(new TextEncoder().encode('not audio'))).toBeNull();
  });

  it('imports a file as an embedded sample with its facts', async () => {
    const s = createTestServices();
    const ref = await importAudioFile(s, wavFile('Loops/Break 01.wav', 0.5));
    expect(ref).toMatchObject({
      name: 'Break 01',
      durationSec: 0.5,
      channels: 2,
      source: { kind: 'embedded', ext: 'wav', originalName: 'Break 01.wav' },
    });
  });

  it('reports files it cannot decode', async () => {
    const s = createTestServices();
    const ref = await importAudioFile(s, new File([new Uint8Array([1, 2, 3])], 'broken.wav'));
    expect(ref).toBeNull();
    expect(s.session.getState().toasts.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('adds sampler channels after the selected channel in one undo step', async () => {
    const s = createTestServices();
    const order = s.doc.getState().project.channelOrder;
    s.session.getState().selectChannel(order[0] ?? null);
    const a = (await importAudioFile(s, wavFile('A.wav', 0.1)))!;
    const b = (await importAudioFile(s, wavFile('B.wav', 0.1)))!;
    const ids = addSampleChannels(s, [a, b]);
    const p = s.doc.getState().project;
    expect(p.channelOrder.slice(1, 3)).toEqual(ids);
    expect((p.channels[ids[0]!] as InstrumentChannel).plugin.samples?.main).toBe(a.id);
    expect(p.samples[b.id]).toBeDefined();
    s.history.undo();
    expect(s.doc.getState().project.channelOrder).toEqual(order);
  });

  it("swaps a sampler channel's sample and name", async () => {
    const s = createTestServices();
    const kick = s.doc.getState().project.channelOrder[0]!;
    const ref = (await importAudioFile(s, wavFile('808.wav', 0.1)))!;
    expect(setChannelSample(s, kick, ref)).toBe(true);
    const ch = s.doc.getState().project.channels[kick] as InstrumentChannel;
    expect(ch.name).toBe('808');
    expect(ch.plugin.samples?.main).toBe(ref.id);
  });

  it('makes an audio clip as long as the sample at the current tempo', async () => {
    const s = createTestServices();
    const lane = s.doc.getState().project.playlist.laneOrder[0]!;
    const ref = (await importAudioFile(s, wavFile('Vox.wav', 1)))!;
    addAudioClip(s, ref, lane, 960);
    const p = s.doc.getState().project;
    const clip = Object.values(p.playlist.clips)[0];
    // 1 s at 130 BPM is 130/60 beats = 2080 ticks.
    expect(clip).toMatchObject({ kind: 'audio', laneId: lane, start: 960, length: 2080, offsetSec: 0 });
    if (clip?.kind !== 'audio') throw new Error('expected an audio clip');
    expect(p.channels[clip.channelId]).toMatchObject({ kind: 'audioClip', name: 'Vox' });
  });
});
