import { produce } from 'immer';
import { newId } from '@core/model/ids';
import type {
  AutomationChannel,
  AutoPoint,
  ChannelId,
  ClipId,
  LaneId,
  ParamTarget,
  Project,
} from '@core/model/types';

// ---------------------------------------------------------------- automated projects

export const pt = (tick: number, value: number, extra: Partial<AutoPoint> = {}): AutoPoint => ({
  tick,
  value,
  ...extra,
});

export interface ClipSpec {
  start: number;
  length: number;
  offset?: number;
  lane?: number;
  muted?: boolean;
}

/**
 * Adds an automation channel driving `target` with `points` and one playlist clip per entry of
 * `clips` (on lane `clip.lane`, default the first). Returns the project and the new ids.
 */
export function automate(
  project: Project,
  target: ParamTarget,
  points: AutoPoint[],
  clips: ClipSpec[],
  extra: Partial<AutomationChannel> = {},
): { project: Project; channelId: ChannelId; clipIds: ClipId[] } {
  const ch: AutomationChannel = {
    kind: 'automation',
    id: newId.channel(),
    name: 'Automation',
    color: '#a0c0e0',
    muted: false,
    solo: false,
    target,
    points,
    ...extra,
  };
  const clipIds: ClipId[] = [];
  const next = produce(project, (d) => {
    d.channels[ch.id] = ch;
    d.channelOrder.push(ch.id);
    for (const c of clips) {
      const id = newId.clip();
      clipIds.push(id);
      d.playlist.clips[id] = {
        kind: 'automation',
        id,
        laneId: d.playlist.laneOrder[c.lane ?? 0] as LaneId,
        channelId: ch.id,
        start: c.start,
        length: c.length,
        offset: c.offset ?? 0,
        ...(c.muted ? { muted: true } : {}),
      };
    }
  });
  return { project: next, channelId: ch.id, clipIds };
}

// ---------------------------------------------------------------- fake audio params

type Ev = { type: 'set' | 'lin' | 'target'; value: number; time: number; tau?: number };

/** Records AudioParam calls and evaluates the resulting automation like Web Audio does. */
export class FakeParam {
  events: Ev[] = [];
  /** Every call in order, for tests that check which methods were used. */
  calls: string[] = [];
  constructor(public defaultValue = 0) {}
  setValueAtTime(value: number, time: number) {
    this.calls.push('set');
    this.add({ type: 'set', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push('lin');
    this.add({ type: 'lin', value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, tau: number) {
    this.calls.push('target');
    this.add({ type: 'target', value, time, tau });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.calls.push('cancel');
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }
  exponentialRampToValueAtTime(): this {
    throw new Error('exponential ramps are not allowed');
  }
  setValueCurveAtTime(): this {
    throw new Error('value curves are not allowed');
  }
  cancelAndHoldAtTime(): this {
    throw new Error('cancelAndHold is not allowed');
  }
  set value(_v: number) {
    throw new Error('.value must not be written');
  }
  get value(): number {
    return this.at(0);
  }
  private add(e: Ev) {
    if (!Number.isFinite(e.time) || !Number.isFinite(e.value)) throw new RangeError('non-finite automation event');
    // Web Audio keeps events with equal times in insertion order.
    let i = this.events.length;
    while (i > 0 && (this.events[i - 1] as Ev).time > e.time) i--;
    this.events.splice(i, 0, e);
  }
  /** The value at time `t`. */
  at(t: number): number {
    let v = this.defaultValue;
    let prevT = 0;
    let target: Ev | null = null;
    const held = (time: number) =>
      target ? (target.value as number) + (v - target.value) * Math.exp(-(time - target.time) / (target.tau ?? 1)) : v;
    for (const e of this.events) {
      if (e.type === 'lin') {
        const from = held(prevT);
        if (e.time <= t) {
          v = e.value;
          prevT = e.time;
          target = null;
          continue;
        }
        return from + (e.value - from) * ((t - prevT) / (e.time - prevT));
      }
      if (e.time > t) break;
      if (e.type === 'set') {
        v = e.value;
        target = null;
      } else {
        v = held(e.time);
        target = e;
      }
      prevT = e.time;
    }
    return held(t);
  }
}

/** A settable clock standing in for an AudioContext. */
export function fakeContext(time = 0, sampleRate = 48000): BaseAudioContext & { currentTime: number } {
  return { currentTime: time, sampleRate, baseLatency: 0 } as unknown as BaseAudioContext & { currentTime: number };
}

// ---------------------------------------------------------------- render analysis (browser tests)

/** RMS of each `window`-frame block of channel 0, starting at frame `from`. */
export function rmsEnvelope(buffer: AudioBuffer, window: number, from = 0, to = buffer.length): number[] {
  const d = buffer.getChannelData(0);
  const out: number[] = [];
  for (let s = from; s + window <= to; s += window) {
    let sum = 0;
    for (let i = s; i < s + window; i++) sum += (d[i] as number) ** 2;
    out.push(Math.sqrt(sum / window));
  }
  return out;
}

/** Energy of channel 0 around `freq` (Goertzel over frames [from, from + n), Hann window). */
export function bandPower(buffer: AudioBuffer, freq: number, from: number, n: number): number {
  const d = buffer.getChannelData(0);
  const w = (2 * Math.PI * freq) / buffer.sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (d[from + i] ?? 0) * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
}

/** Bitwise comparison of two renders (all channels): the first differing frame, or -1. */
export function firstDifference(a: AudioBuffer, b: AudioBuffer): number {
  if (a.length !== b.length || a.numberOfChannels !== b.numberOfChannels) return 0;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c);
    const y = b.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return i;
  }
  return -1;
}
