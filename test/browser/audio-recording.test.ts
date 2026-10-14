/**
 * Audio recording through the real engine: a MediaStream from the engine's own context stands in
 * for the microphone (a loopback, so "what the performer hears" is the transport's schedule). The
 * loopback's delay is calibrated with the same measurement as "Calibrate latency…", then a hit
 * played on a beat must land on that beat in the recorded clip (M15).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@app/services';
import { measureRoundTrip, measurementOk } from '@core/audio/latency';
import type { AudioClip, AudioClipChannel } from '@core/model/types';
import { Engine } from '@engine/engine';

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('audio recording', () => {
  let engine: Engine | null = null;
  let s: Services;
  afterAll(async () => {
    await s?.engine.dispose();
  });

  it('records a hit played on a beat onto that beat (loopback input, calibrated)', async () => {
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
      osc.stop(at + 0.005);
    };

    // Calibrate the loopback like "Calibrate latency…" does: clicks out, recorded back.
    const input = await s.audioInput.open();
    expect(input).not.toBeNull();
    const cap = input!.startCapture();
    await sleep(200);
    const times = [0.3, 0.6, 0.9, 1.2, 1.5].map((t) => ctx.currentTime + t);
    for (const t of times) hit(t);
    await sleep(2000);
    const loop = await cap.stop();
    const m = measureRoundTrip(loop.channels, loop.sampleRate, loop.startTime, times);
    expect(measurementOk(m)).toBe(true);
    s.audioInput.setMeasuredLatency(m.ms);

    // Record: one bar of count-in, then the song from bar 1; a hit on bar 2, beat 2.
    s.recording.setArmed(true);
    expect(s.view.getState().mode).toBe('song');
    s.engine.play(0);
    await sleep(300);
    const X = 3840 + 960;
    const now = ctx.currentTime;
    const at = now + (X - s.engine.tickAt(now).tick) / 1920;
    hit(at);
    await until(() => ctx.currentTime > at + 0.6);
    s.engine.stop();
    await s.audioRecorder.saved;

    const p = s.doc.getState().project;
    const clip = Object.values(p.playlist.clips).find((c): c is AudioClip => c.kind === 'audio');
    expect(clip).toBeDefined();
    const ch = p.channels[clip!.channelId] as AudioClipChannel;
    expect(clip!.start).toBe(0);
    // The count-in is in the recording, before the clip's trim.
    expect(clip!.offsetSec).toBeGreaterThan(1.9);
    const data = await s.engine.sampleData(p.samples[ch.sampleId]!);
    const x = data!.channels[0]!;
    // The hit: the loud moment nearest to where it should be (calibration clicks can trail in).
    const want = (clip!.offsetSec + (X - clip!.start) / 1920) * data!.sampleRate;
    let k = -1;
    for (let i = 0; i < x.length; i++)
      if (Math.abs(x[i]!) > 0.05 && (i === 0 || Math.abs(x[i - 1]!) <= 0.05) && (k < 0 || Math.abs(i - want) < Math.abs(k - want))) k = i;
    expect(k).toBeGreaterThan(0);
    // Where the clip plays that frame, in ticks (120 BPM: 1920 per second).
    const tick = clip!.start + (k / data!.sampleRate - clip!.offsetSec) * 1920;
    // Within 12 ms: the loopback stream's own delay moves by a few ms between captures in Chrome
    // (measured: 3–6 ms); a real interface is steadier.
    expect(Math.abs(tick - X) / 1920).toBeLessThan(0.012);
  });
});
