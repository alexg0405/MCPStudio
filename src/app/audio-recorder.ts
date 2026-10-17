/**
 * Audio recording (record mode with "Audio" on): while playback runs, the input is captured on the
 * engine's clock; when it stops, the recording becomes one sample and an audio clip channel, with a
 * clip per loop pass (a take) where it was played, latency compensated. Several takes become a take group
 * (core/ops/comp.ts): a comp lane that plays the newest full pass, with the take lanes folded under it
 * (muted), ready to be comped. A punch range keeps only that part of the capture (and, when there is no
 * loop, finishes the take at the punch-out while the song plays on). One undo step.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { tempoMapOf } from '@core/automation/tempo';
import { audibleTake, planTakes, tickAtFrame, trimToTakes, type CaptureAnchor } from '@core/audio/takes';
import { paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { AudioClip, AudioClipChannel, Tick } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addTakeGroup, newTakeGroup } from '@core/ops/comp';
import { addClips, addLane } from '@core/ops/playlist';
import { makeLane } from '@core/model/defaults';
import type { LaneId } from '@core/model/types';
import { freeLaneRun } from '@core/query/lanes';
import type { AudioCapture } from '@engine/api';
import type { AudioInputService } from './audio-input';
import { encodeOffThread } from './export/encode';
import { importSampleBytes } from './persistence/sample-import';
import type { Recorder } from './recording';
import type { Services } from './services';

const ANCHOR_MS = 50;

/** What the playlist shows while a take records (a growing clip with its waveform). */
export interface LiveTake {
  /** Track index it will land on (the newest take's). */
  lane: number;
  /** Where this pass started and the tick being recorded now. */
  start: Tick;
  now: Tick;
  capture: AudioCapture;
  /** Capture frame at `start` (the waveform starts there). */
  startFrame: number;
}

export class AudioRecorder implements Recorder {
  readonly id = 'audio';
  readonly kind = 'audio' as const;
  readonly live: StoreApi<{ take: LiveTake | null }> = createStore<{ take: LiveTake | null }>(() => ({ take: null }));
  private take: {
    capture: AudioCapture;
    anchors: CaptureAnchor[];
    startTick: Tick;
    loop: { start: Tick; end: Tick } | null;
    punch: { start: Tick; end: Tick } | null;
    latency: number;
    lane: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  private pending: Promise<void> = Promise.resolve();
  /** Takes saved this session (for the channel names). */
  private count = 0;

  constructor(
    private readonly s: Services,
    private readonly inputs: AudioInputService,
  ) {}

  start({ tick }: { tick: number }): void {
    const s = this.s;
    if (s.view.getState().mode !== 'song') {
      s.session.getState().toast('Audio records into the playlist: switch to Song mode (L) and record again.', 'error');
      return;
    }
    const begin = (input: NonNullable<AudioInputService['current']>) => {
      if (!s.engine.playing || this.take) return;
      const project = s.doc.getState().project;
      const loop = s.view.getState().loop;
      const punch = s.view.getState().punch;
      const capture = input.startCapture();
      const end = punch?.end ?? loop?.end ?? tick + 1e9;
      const lane = freeLaneRun(project, Math.max(punch?.start ?? 0, loop?.start ?? tick), end, 1);
      const take = {
        capture,
        anchors: [] as CaptureAnchor[],
        startTick: tick,
        loop,
        punch,
        latency: this.inputs.latency(),
        lane,
        timer: setInterval(() => this.anchor(), ANCHOR_MS),
      };
      this.take = take;
      this.anchor();
    };
    const input = this.inputs.current;
    if (input) begin(input);
    else
      void this.inputs.open().then((opened) => {
        if (opened) begin(opened);
        else
          s.session
            .getState()
            .toast(`No audio was recorded: ${this.inputs.store.getState().error ?? 'the audio input could not be opened.'}`, 'error');
      });
  }

  /** Notes which song tick the newest captured frame was played along with. */
  private anchor(): void {
    const t = this.take;
    if (!t || !this.s.engine.playing) return;
    const c = t.capture;
    if (!Number.isFinite(c.startTime)) return;
    const frame = c.frames;
    const { tick, iter } = this.s.engine.tickAt(c.startTime + frame / c.sampleRate - t.latency);
    t.anchors.push({ frame, tick, iter });
    // Without a loop, the punch-out ends the take (the song plays on).
    if (t.punch && !t.loop && tick >= t.punch.end) {
      this.finish();
      return;
    }
    const passAnchors = t.anchors.filter((a) => a.iter === iter);
    const tempo = tempoMapOf(this.s.doc.getState().project, 'song');
    const first = iter === (t.anchors[0]?.iter ?? 0);
    let passStart = first ? t.startTick : (t.loop?.start ?? t.startTick);
    if (t.punch) passStart = Math.max(passStart, t.punch.start);
    // Before the punch-in nothing is being recorded yet.
    if (t.punch && tick < t.punch.start) {
      if (this.live.getState().take) this.live.setState({ take: null });
      return;
    }
    const startFrame = Math.max(0, Math.round(this.frameAt(passAnchors, passStart, tempo, c.sampleRate)));
    this.live.setState({ take: { lane: t.lane, start: passStart, now: Math.min(tick, t.punch?.end ?? Infinity), capture: c, startFrame } });
  }

  private frameAt(anchors: CaptureAnchor[], tick: number, tempo: ReturnType<typeof tempoMapOf>, sr: number): number {
    let best = anchors[0];
    for (const a of anchors) if (best && Math.abs(a.tick - tick) < Math.abs(best.tick - tick)) best = a;
    return best ? best.frame + (tempo.tickToSeconds(tick) - tempo.tickToSeconds(best.tick)) * sr : 0;
  }

  stop(): void {
    this.finish();
  }

  /** Ends the take being recorded (Stop, or the punch-out) and saves it. */
  private finish(): void {
    const t = this.take;
    this.take = null;
    this.live.setState({ take: null });
    if (!t) return;
    clearInterval(t.timer);
    // The take ends where the last anchor's pass had got to when playback stopped.
    const tempo = tempoMapOf(this.s.doc.getState().project, 'song');
    const last = t.anchors[t.anchors.length - 1];
    const lastPass = last ? t.anchors.filter((a) => a.iter === last.iter) : [];
    const endTick = lastPass.length ? tickAtFrame(lastPass, tempo, t.capture.sampleRate, t.capture.frames) : undefined;
    // What was played just before Stop is still on its way through the input.
    this.pending = this.pending.then(() => this.save(t, endTick, tempo));
  }

  /** Resolves when the last take has been written (tests, and the UI's "saving" state). */
  get saved(): Promise<void> {
    return this.pending;
  }

  private async save(
    t: NonNullable<AudioRecorder['take']>,
    endTick: number | undefined,
    tempo: ReturnType<typeof tempoMapOf>,
  ): Promise<void> {
    const s = this.s;
    let audio;
    try {
      audio = await t.capture.stop(Math.min(0.5, t.latency + 0.05));
    } catch {
      return;
    }
    let frames = audio.channels[0]?.length ?? 0;
    let takes = planTakes({
      anchors: t.anchors,
      sampleRate: audio.sampleRate,
      frames,
      tempo,
      loop: t.loop,
      punch: t.punch,
      startTick: t.startTick,
      ...(endTick !== undefined ? { endTick } : {}),
    });
    if (takes.length === 0) {
      s.session.getState().toast(t.punch ? 'Nothing was recorded: playback did not reach the punch range.' : 'Nothing was recorded: the take was too short.');
      return;
    }
    // A punch recording keeps only what the takes play (and a second either side), not the bars before the punch-in.
    let channels = audio.channels;
    if (t.punch) {
      const kept = trimToTakes(takes, tempo, audio.sampleRate, frames, 1);
      channels = audio.channels.map((c) => c.subarray(kept.from, kept.to));
      takes = kept.takes;
      frames = kept.to - kept.from;
    }
    const project = s.doc.getState().project;
    const name = this.nextName();
    let ref;
    try {
      const bytes = await encodeOffThread(channels, audio.sampleRate, { codec: 'flac', bits: 24, kbps: 0 });
      ref = await importSampleBytes(bytes, `${name}.flac`);
    } catch (e) {
      s.session.getState().toast(`The recording couldn't be saved: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return;
    }
    const sample = { ...ref, durationSec: frames / audio.sampleRate, sampleRate: audio.sampleRate, channels: channels.length };
    const channel: AudioClipChannel = {
      kind: 'audioClip',
      id: newId.channel(),
      name,
      color: paletteColor(project.channelOrder.length),
      muted: false,
      solo: false,
      // Plays back as it was heard while monitoring (the input went through its track at unity).
      volume: 1,
      pan: 0,
      output: this.inputs.track(),
      sampleId: sample.id,
    };
    const from = Math.min(...takes.map((k) => k.start));
    const to = Math.max(...takes.map((k) => k.start + k.length));
    const seconds = Math.round((frames / audio.sampleRate) * 10) / 10;
    const lost = audio.dropped > 0 ? ` (${Math.round((audio.dropped / audio.sampleRate) * 1000)} ms were lost: the app was busy)` : '';
    if (takes.length > 1) {
      // Several takes: a comp lane that plays the newest full one, with the take lanes (muted) folded under it.
      const group = newTakeGroup();
      const first = freeLaneRun(project, from, to, takes.length + 1, Math.max(0, t.lane));
      let made: { takes: string[]; comp: string[] } = { takes: [], comp: [] };
      s.history.transact(`Record ${takes.length} takes`, (d) => {
        addSample(d, sample);
        addChannel(d, channel);
        made = addTakeGroup(d, {
          group,
          name,
          channelId: channel.id,
          takes: takes.map((k) => ({ start: k.start, length: k.length, offsetSec: k.offsetSec })),
          audible: audibleTake(takes),
          first,
          tempo,
          crossfadeMs: s.prefs.getState().compCrossfadeMs,
        });
      });
      s.editor.getState().setTakesOpen(group, true);
      s.editor.getState().selectClips(made.comp as never);
      s.session
        .getState()
        .toast(
          `Recorded ${takes.length} takes on tracks ${first + 1}–${first + takes.length + 1}: the comp track plays the newest full take. Drag across another take with the Comp tool (or Alt-drag) to use that part${lost}.`,
        );
      return;
    }
    const first = freeLaneRun(project, from, to, 1, Math.max(0, t.lane));
    const lanes = project.playlist.laneOrder;
    const newLane = first >= lanes.length ? makeLane(`Track ${lanes.length + 1}`) : null;
    const laneId = (lanes[first] ?? newLane!.id) as LaneId;
    const k = takes[0]!;
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId,
      start: k.start,
      length: k.length,
      channelId: channel.id,
      offsetSec: k.offsetSec,
    };
    s.history.transact('Record audio', (d) => {
      addSample(d, sample);
      addChannel(d, channel);
      if (newLane) addLane(d, newLane);
      addClips(d, [clip]);
    });
    s.editor.getState().selectClips([clip.id]);
    s.session.getState().toast(`Recorded “${name}” (${seconds} s) on Track ${first + 1}${lost}.`);
  }

  private nextName(): string {
    const names = new Set(Object.values(this.s.doc.getState().project.channels).map((c) => c.name));
    for (;;) {
      const name = `Recording ${++this.count}`;
      if (!names.has(name)) return name;
    }
  }
}
