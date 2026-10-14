import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, AudioClipChannel } from '@core/model/types';
import type { FakeAudioInput } from '@engine/fake-engine';
import { createTestServices } from './testing';

const SR = 48000;

function setup() {
  vi.useFakeTimers();
  const s = createTestServices({
    openAudioStream: async () => ({
      stream: {} as MediaStream,
      latency: 0,
      label: 'Test mic',
      deviceId: '',
      channelCount: 1,
      close: () => {},
    }),
  });
  const engine = s.fakeEngine;
  engine.tempo = 120; // 1920 ticks per second
  engine.inputLatency = 0.02;
  s.prefs.getState().set({ recordAudio: true, recordNotes: false, recordLatencyMs: -1, recordLatencyOffsetMs: 0 });
  /** Audio arriving from the mic over `seconds`, 50 ms at a time (as the capture's drain sees it). */
  const feed = (seconds: number) => {
    const input = engine.inputs[engine.inputs.length - 1] as FakeAudioInput;
    for (let t = 0; t < seconds - 1e-9; t += 0.05) {
      input.feed([new Float32Array(Math.round(0.05 * SR))]);
      vi.advanceTimersByTime(50);
    }
  };
  const audio = () => {
    const p = s.doc.getState().project;
    const clips = Object.values(p.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
    const channel = clips[0] ? (p.channels[clips[0].channelId] as AudioClipChannel) : undefined;
    return { clips: clips.sort((a, b) => a.start - b.start), channel };
  };
  return { s, engine, feed, audio };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('audio recording', () => {
  it('records while playing and places the take where it was played, latency compensated', async () => {
    const { s, engine, feed, audio } = setup();
    s.recording.setArmed(true);
    // Arming with audio on switches to song mode (audio goes into the playlist) and runs open-ended.
    expect(s.view.getState().mode).toBe('song');
    expect(engine.openEnded).toBe(true);
    await vi.waitFor(() => expect(s.audioInput.isOpen).toBe(true));
    // The capture starts at 0.5 s (the count-in); playback of bar 2 starts at 1 s.
    engine.clockTime = 0.5;
    engine.startTime = 1;
    engine.startTick = 3840;
    engine.play();
    feed(3);
    engine.stop();
    await s.audioRecorder.saved;
    const { clips, channel } = audio();
    expect(clips).toHaveLength(1);
    expect(channel).toMatchObject({ name: 'Recording 1', output: 'master', volume: 1 });
    expect(clips[0]).toMatchObject({ start: 3840 });
    // Bar 2 was heard 1 s in and recorded 20 ms later: 0.52 s into the capture.
    expect(clips[0]!.offsetSec).toBeCloseTo(0.52, 2);
    expect(s.history.status().undoLabel).toBe('Record audio');
    const ref = s.doc.getState().project.samples[channel!.sampleId];
    expect(ref).toMatchObject({ sampleRate: SR, channels: 1 });
    expect(ref?.durationSec).toBeCloseTo(3, 2);
    s.history.undo();
    expect(audio().clips).toHaveLength(0);
  });

  it('keeps each loop pass as a take on its own track, the newest on top and the only one playing', async () => {
    const { s, engine, feed, audio } = setup();
    s.view.getState().setMode('song');
    s.view.getState().setLoop({ start: 0, end: 3840 });
    s.recording.setArmed(true);
    await vi.waitFor(() => expect(s.audioInput.isOpen).toBe(true));
    // A looping transport: 2 s passes from 0.
    engine.tickAt = (t: number) => {
      const e = Math.max(0, (t - 1) * 1920);
      return { tick: e % 3840, iter: Math.floor(e / 3840) };
    };
    engine.clockTime = 1;
    engine.playing = false;
    engine.play();
    feed(6.5);
    engine.stop();
    await s.audioRecorder.saved;
    const { clips } = audio();
    const lanes = s.doc.getState().project.playlist.laneOrder;
    const row = (c: AudioClip) => lanes.indexOf(c.laneId);
    expect(clips).toHaveLength(4);
    const byTake = [...clips].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    expect(byTake.map((c) => c.name)).toEqual([
      'Recording 1 · take 1',
      'Recording 1 · take 2',
      'Recording 1 · take 3',
      'Recording 1 · take 4',
    ]);
    // Newest on top.
    expect(byTake.map(row)).toEqual([3, 2, 1, 0]);
    // Take 3 is the newest full pass: it plays; the partial 4th and the older ones are muted.
    expect(byTake.map((c) => !!c.muted)).toEqual([true, true, false, true]);
    expect(s.history.status().undoLabel).toBe('Record 4 takes');
  });

  it('says why nothing was recorded when the input can’t open', async () => {
    const s = createTestServices({
      openAudioStream: async () => {
        throw new Error('Microphone access is blocked. Allow it from the icon in the address bar, then try again.');
      },
    });
    const toasts: string[] = [];
    s.session.subscribe((st) => toasts.push(...st.toasts.map((t) => t.text)));
    s.prefs.getState().set({ recordAudio: true });
    s.recording.setArmed(true);
    await vi.waitFor(() => expect(s.audioInput.store.getState().status).toBe('error'));
    expect(toasts.join(' ')).toMatch(/Microphone access is blocked/);
  });
});
