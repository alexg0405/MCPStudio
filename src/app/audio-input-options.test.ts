import { describe, expect, it } from 'vitest';
import { createTestServices } from './testing';

/** What Hum to notes and the Studio's performance recorder ask the audio input service for. */
describe('audio input for performances', () => {
  it('uses the device and channel count chosen in Options › Audio input', () => {
    const s = createTestServices();
    expect(s.audioInput.micOptions()).toEqual({ channels: 1 });
    s.prefs.getState().set({ audioInputDevice: 'usb-interface', audioInputChannels: 'stereo' });
    expect(s.audioInput.micOptions()).toEqual({ deviceId: 'usb-interface', channels: 2 });
  });

  it('compensates with the calibrated round trip, else the browser’s estimate; the manual correction counts either way', () => {
    const s = createTestServices();
    // Not calibrated: the microphone's own latency estimate (the recorder adds the output latency), plus the correction.
    s.prefs.getState().set({ recordLatencyMs: -1, recordLatencyOffsetMs: 0 });
    expect(s.audioInput.performanceLatency(0.02)).toEqual({ inputLatency: 0.02 });
    s.prefs.getState().set({ recordLatencyOffsetMs: 5 });
    expect(s.audioInput.performanceLatency(0.02).inputLatency).toBeCloseTo(0.025, 9);
    s.prefs.getState().set({ recordLatencyOffsetMs: -50 });
    expect(s.audioInput.performanceLatency(0.02).inputLatency).toBe(0);
    // Calibrated: the whole measured round trip replaces the estimate, with the correction on top.
    s.prefs.getState().set({ recordLatencyMs: 38.2, recordLatencyOffsetMs: 2 });
    const l = s.audioInput.performanceLatency(0.02);
    expect(l.roundTrip).toBeCloseTo(0.0402, 9);
    expect(l.inputLatency).toBe(0.02);
  });
});
