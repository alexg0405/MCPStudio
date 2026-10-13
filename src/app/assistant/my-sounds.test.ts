import { describe, expect, it } from 'vitest';
import type { InstrumentChannel } from '@core/model/types';
import { createTestServices } from '../testing';
import { applyBeatSpec } from './apply';
import { bestHits, importMySounds, sliceHit, type HitLike } from './my-sounds';

const SR = 48000;

describe('use my sounds', () => {
  it('picks the loudest confident hit of each kind', () => {
    const hits: HitLike[] = [
      { kind: 'kick', time: 0, duration: 0.2, strength: 0.6, confidence: 0.9 },
      { kind: 'kick', time: 0.5, duration: 0.2, strength: 0.9, confidence: 0.9 },
      { kind: 'snare', time: 1, duration: 0.2, strength: 1, confidence: 0.3 },
      { kind: 'snare', time: 1.5, duration: 0.2, strength: 0.8, confidence: 0.9 },
      { kind: 'tonal', time: 2, duration: 0.4, strength: 1 },
    ];
    const best = bestHits(hits);
    expect(best.kick?.time).toBe(0.5);
    expect(best.snare?.time).toBe(1.5);
    expect(best.hat).toBeUndefined();
  });

  it('cuts a hit with fades and normalizes it', () => {
    const audio = new Float32Array(SR).fill(0.1);
    for (let i = 24000; i < 30000; i++) audio[i] = 0.5;
    const slice = sliceHit(audio, SR, 0.5, 0.1, 0.6);
    expect(slice.length).toBe(Math.round(0.1 * SR) + Math.round(0.004 * SR));
    expect(slice[0]).toBe(0);
    expect(Math.abs(slice.at(-1)!)).toBeLessThan(0.01);
    expect(Math.max(...slice)).toBeCloseTo(0.9, 5);
  });

  it('stores the hits and builds the drums from them in their own channels', async () => {
    const s = createTestServices();
    const audio = new Float32Array(SR * 2);
    for (let i = 0; i < 4000; i++) audio[i + 4800] = Math.sin(i / 20) * (1 - i / 4000);
    const refs = await importMySounds({
      events: [{ kind: 'kick', time: 0.1, duration: 0.1, strength: 1 }],
      audio: { samples: audio, sampleRate: SR },
    });
    expect(refs.kick).toMatchObject({ name: 'Your kick', source: { kind: 'embedded', ext: 'wav' } });
    const before = s.doc.getState().project;
    const applied = applyBeatSpec(
      s,
      { title: 'Mine', bars: 1, tracks: [{ name: 'Kick', sound: 'kick', notes: [{ step: 0 }] }] },
      null,
      { samples: refs },
    );
    const p = s.doc.getState().project;
    const ch = p.channels[applied.channels.kick!] as InstrumentChannel;
    // A new channel playing the take's kick; the project's own Kick is untouched.
    expect(before.channels[ch.id]).toBeUndefined();
    expect(ch.name).toBe('Your kick');
    expect(ch.plugin.samples?.main).toBe(refs.kick!.id);
    expect(p.samples[refs.kick!.id]).toBeDefined();
  });
});
