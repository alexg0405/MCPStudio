/**
 * Punch recording through the real engine: a loopback stream (the engine's own context standing in for the
 * microphone) records over bars 2–3 only. The take must start exactly on the punch-in, keep nothing from the bars
 * before it, end at the punch-out while the song plays on, and a hit played on a beat must land on that beat in
 * the clip (calibrated like "Calibrate latency…"; M15 measured 12 ms for plain recordings).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@app/services';
import { measureRoundTrip, measurementOk } from '@core/audio/latency';
import type { AudioClip, AudioClipChannel } from '@core/model/types';
import { Engine } from '@engine/engine';
import { onsetFrames } from '../helpers/audio';

const until = async (ok: () => boolean, ms = 30_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('punch recording', () => {
  let engine: Engine | null = null;
  let s: Services;
  afterAll(async () => {
    await s?.engine.dispose();
  });

  it('keeps only the punch range, on the punch-in, with hits landing on their beats', async () => {
    let dest: MediaStreamAudioDestinationNode | null = null;
    s = createServices({
      createEngine: (o) => (engine = Engine.realtime(o)),
      openAudioStream: async () => {
        const ctx = engine!.ctx as AudioContext;
        dest = ctx.createMediaStreamDestination();
        return { stream: dest.stream, latency: 0, label: 'Loopback', deviceId: '', channelCount: 1, close: () => {} };
      },
    });
    const ctx = engine!.ctx as AudioContext;
    await s.engine.resume();
    s.history.transact('Tempo', (d) => void (d.transport.bpm = 120));
    s.prefs.getState().set({ recordAudio: true, recordNotes: false, countInBars: 1, recordLatencyOffsetMs: 0 });
    const hit = (at: number) => {
      const osc = new OscillatorNode(ctx, { frequency: 1000 });
      const g = new GainNode(ctx, { gain: 0.8 });
      osc.connect(g).connect(dest!);
      osc.start(at);
      osc.stop(at + 0.02);
    };

    // Calibrate the loopback.
    const input = await s.audioInput.open();
    expect(input).not.toBeNull();
    const cap = input!.startCapture();
    await sleep(200);
    const times = [0.3, 0.6, 0.9, 1.2, 1.5].map((t) => ctx.currentTime + t);
    for (const t of times) hit(t);
    await sleep(2000);
    const loop = await cap.stop();
    const m = measureRoundTrip(loop.channels, loop.sampleRate, loop.startTime, times);
    expect(m.found).toBeGreaterThanOrEqual(3);
    if (measurementOk(m)) expect(m.spreadMs).toBeLessThanOrEqual(8);
    s.audioInput.setMeasuredLatency(m.ms);

    // Punch over bars 2–3 (ticks 3840–11520), no loop: one bar of count-in, then the song from the start.
    s.view.getState().setPunch({ start: 3840, end: 11520 });
    s.recording.setArmed(true);
    expect(s.view.getState().mode).toBe('song');
    s.engine.play(0);
    await sleep(300);
    const R = 3840 + 1920;
    const X = 3840 + 5760;
    const now = ctx.currentTime;
    const timeOf = (tick: number) => now + (tick - s.engine.tickAt(now).tick) / 1920;
    // Before the punch-in: a hit that must not be kept.
    hit(timeOf(1920));
    hit(timeOf(R));
    hit(timeOf(X));
    // The take is finished by the punch-out itself (the song plays on).
    await until(() => ctx.currentTime > timeOf(11520) + 1.5);
    await s.audioRecorder.saved;
    expect(s.engine.playing).toBe(true);
    s.engine.stop();
    await s.audioRecorder.saved;

    const p = s.doc.getState().project;
    const clips = Object.values(p.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
    expect(clips).toHaveLength(1);
    const clip = clips[0]!;
    // Exactly on the punch-in, and no longer than the range.
    expect(clip.start).toBe(3840);
    expect(clip.length).toBeLessThanOrEqual(7680);
    expect(clip.length).toBeGreaterThan(7680 - 480);
    const ch = p.channels[clip.channelId] as AudioClipChannel;
    const data = await s.engine.sampleData(p.samples[ch.sampleId]!);
    const x = data!.channels[0]!;
    // The recording holds the range with a second of handle before it: a hit from before the punch-in is not in it.
    const hits = onsetFrames(x, data!.sampleRate, 0.05, 0.05);
    const landed = (tick: number) => {
      const want = (clip.offsetSec + (tick - clip.start) / 1920) * data!.sampleRate;
      const k = hits.reduce((best, f) => (Math.abs(f - want) < Math.abs(best - want) ? f : best), hits[0] ?? -1);
      return clip.start + (k / data!.sampleRate - clip.offsetSec) * 1920;
    };
    expect(x.length / data!.sampleRate).toBeLessThan(7);
    // The two hits inside the range are found; the one before it (at bar 1 beat 2: 1 s before the punch-in) can
    // only be in the handle, never in the clip's own part.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const errR = (landed(R) - R) / 1920;
    const errX = (landed(X) - X) / 1920;
    expect(Math.abs(errX - errR)).toBeLessThan(0.002);
    // Punch placement: within 12 ms of the beat on a quiet machine (the loopback's own delay moves by 3–6 ms between captures).
    expect(Math.abs(errR)).toBeLessThan(0.012);
    expect(Math.abs(errX)).toBeLessThan(0.012);
  });
});
