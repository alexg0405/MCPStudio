/**
 * The 808's mono voice handling: one sine voice per hit, legato glides inside it, and rescheduling
 * when late events change the performance (see legato.ts for the rules and why).
 */
import { clamp, mtof, type NoteOff, type NoteOn, type ParamSignal } from '@agstudio/sdk';
import { Lane } from './lane';
import { firstDifference, LegatoTracker, type LegatoAction, type NoteAction, type Phrase } from './legato';

/** Attack ramp of a hit (the sine starts at zero phase, so this only rounds the corner). */
const ATTACK = 0.0015;
/** Release after a note-off: time constant of the fade (about -43 dB after 50 ms). */
const RELEASE_TAU = 0.01;
/** The oscillator stops this long after a release starts (the fade is below -100 dB by then). */
const RELEASE_STOP = 0.12;
/** A new hit fades out what is left of the previous one (its release tail) over this long. */
const CHOKE = 0.008;
/** Hard all-notes-off (panic, plugin swap). */
const KILL = 0.005;
/** Shortest pitch slide (glide 0 still slides over 2 ms: inaudible, and the phase stays smooth). */
const MIN_GLIDE = 0.002;
/** Shortest level change when a glide changes the velocity. */
const MIN_LEVEL_RAMP = 0.02;
/** Click level at full velocity and click = 100%. */
const CLICK_LEVEL = 0.5;
/** A "never" stop time (moves a scheduled stop out of the way when a release is rescheduled). */
const NEVER = 1e9;
/** Finished voices are disconnected this long after they stopped. */
const COLLECT_AFTER = 0.05;

/** Settings read when a voice starts (glide when a glide starts). */
export interface BassSettings {
  /** Pitch drop at the attack, in semitones. */
  punch: number;
  /** Time constant of the pitch drop (s). */
  punchTau: number;
  /** Time constant of the amplitude decay while the note is held (s). */
  decayTau: number;
  /** Click level, 0–1. */
  click: number;
  /** Glide time (s). */
  glide: number;
}

/**
 * One hit: a sine that starts at zero phase, its pitch punch and decay, and the glides of the
 * notes that slide out of it. Every AudioParam goes through a Lane, so the voice can be rewound to
 * any time that hasn't been played yet and continued differently.
 */
class Voice {
  /** Performance time of the attack (what the plan compares). */
  readonly attackTime: number;
  /** Context time the voice starts. */
  readonly start: number;
  actions: readonly LegatoAction[] = [];
  ids: readonly number[] = [];
  /** Context time the oscillator stops (Infinity: not scheduled). */
  stopAt = Infinity;
  private readonly osc: OscillatorNode;
  private readonly amp: GainNode;
  private readonly vel: GainNode;
  private readonly click: AudioBufferSourceNode | null;
  private readonly clickGain: GainNode | null;
  private readonly freq: Lane;
  private readonly pitch: Lane;
  private readonly env: Lane;
  private readonly level: Lane;
  private readonly untune: () => void;
  private releaseAt = Infinity;
  private chokeAt = Infinity;
  private chokeLength = 0;

  constructor(
    ac: BaseAudioContext,
    destination: AudioNode,
    tune: ParamSignal,
    a: NoteAction,
    t: number,
    s: BassSettings,
    clickBuffer: AudioBuffer,
  ) {
    this.attackTime = a.time;
    this.start = t;
    const f = mtof(a.key);
    // The punch is the oscillator's own starting detune, not a jump scheduled at t. In the render
    // quantum an oscillator starts in, Chrome feeds it the a-rate automation values of up to 127
    // frames earlier, so a jump at the start time is missed for up to 64 frames (measured: the first
    // half cycle 0.8 ms late when the start falls mid-quantum). Only the decay is scheduled, and
    // starting it a few frames late is inaudible.
    const punch = s.punch * 100;
    this.osc = new OscillatorNode(ac, { type: 'sine', frequency: f, detune: punch });
    this.amp = new GainNode(ac, { gain: 0 });
    this.vel = new GainNode(ac, { gain: a.velocity });
    this.osc.connect(this.amp).connect(this.vel).connect(destination);
    this.untune = tune.connect(this.osc.detune);
    this.freq = new Lane(this.osc.frequency, f);
    this.pitch = new Lane(this.osc.detune, punch);
    this.env = new Lane(this.amp.gain, 0);
    this.level = new Lane(this.vel.gain, a.velocity);
    if (punch > 0) this.pitch.targetTo(t, 0, s.punchTau);
    this.env.jumpRamp(t, 0, 1, t + ATTACK);
    this.env.targetTo(t + ATTACK, 0, s.decayTau);
    this.osc.start(t);
    if (s.click > 0) {
      this.click = new AudioBufferSourceNode(ac, { buffer: clickBuffer });
      this.clickGain = new GainNode(ac, { gain: s.click * a.velocity * CLICK_LEVEL });
      this.click.connect(this.clickGain).connect(destination);
      this.click.start(t);
    } else {
      this.click = null;
      this.clickGain = null;
    }
  }

  /** Slides to `key` from wherever the pitch is at `t`; the level follows the new velocity. */
  glide(t: number, key: number, velocity: number, time: number): void {
    const len = Math.max(time, MIN_GLIDE);
    this.freq.rampTo(t, mtof(key), t + len, true);
    this.level.rampTo(t, velocity, t + Math.max(len, MIN_LEVEL_RAMP));
  }

  release(t: number): void {
    this.env.targetTo(t, 0, RELEASE_TAU);
    this.releaseAt = t;
    this.syncStop();
  }

  /** Fades out over `length` from `t` (a newer hit, or a hard all-notes-off). */
  choke(t: number, length: number): void {
    this.env.rampTo(t, 0, t + length);
    this.chokeAt = t;
    this.chokeLength = length;
    this.syncStop();
  }

  /** Forgets everything scheduled from `t` on (the curves running at `t` go on). */
  rewind(t: number): void {
    this.freq.rewind(t);
    this.pitch.rewind(t);
    this.env.rewind(t);
    this.level.rewind(t);
    if (this.releaseAt >= t) this.releaseAt = Infinity;
    if (this.chokeAt >= t) this.chokeAt = Infinity;
    this.syncStop();
  }

  dispose(): void {
    for (const src of [this.osc, this.click]) {
      try {
        src?.stop();
      } catch {
        /* already stopped */
      }
    }
    this.untune();
    for (const n of [this.osc, this.amp, this.vel, this.click, this.clickGain]) n?.disconnect();
  }

  private syncStop(): void {
    const end = Math.min(this.releaseAt + RELEASE_STOP, this.chokeAt + this.chokeLength + 0.002);
    if (end === this.stopAt) return;
    this.stopAt = end;
    try {
      this.osc.stop(Number.isFinite(end) ? end : NEVER);
    } catch {
      /* already stopped */
    }
  }
}

export interface MonoBassOptions {
  audioContext: BaseAudioContext;
  /** Where voices play into. */
  destination: AudioNode;
  /** Transposition in cents, added to every voice's detune. */
  tune: ParamSignal;
  /** Voices start this much before the note time (the output chain's latency). */
  lead: number;
  click: AudioBuffer;
  settings(): BassSettings;
}

/**
 * Mono legato controller. Every event updates the tracked notes; the performance derived from them
 * is compared with the one already scheduled and only what changed is rescheduled, from the first
 * difference on (voices planned after it are dropped, earlier ones are rewound and continued).
 * Events can only change the future: anything later than "now" is clamped to now.
 */
export class MonoBass {
  private readonly tracker = new LegatoTracker();
  private voices: Voice[] = [];
  /** Voices cut by a hard all-notes-off, fading out. */
  private dying: Voice[] = [];

  constructor(private readonly o: MonoBassOptions) {}

  /** Tracked notes and live voices (diagnostics and tests). */
  get stats(): { notes: number; voices: number } {
    return { notes: this.tracker.size, voices: this.voices.length + this.dying.length };
  }

  noteOn(e: NoteOn): void {
    this.tracker.noteOn(e.noteId, e.key, clamp(e.velocity, 0, 1), this.snap(e.time), this.performanceNow());
    this.sync();
  }

  noteOff(e: NoteOff): void {
    if (this.tracker.noteOff(e.noteId, this.snap(e.time), this.performanceNow())) this.sync();
  }

  allNotesOff(time: number, hard = false): void {
    if (!hard) {
      if (this.tracker.allNotesOff(this.snap(time), this.performanceNow())) this.sync();
      return;
    }
    const now = this.o.audioContext.currentTime;
    const at = this.contextTime(this.snap(time), now);
    for (const v of this.voices) this.retire(v, at);
    this.voices = [];
    this.tracker.clear();
  }

  dispose(): void {
    for (const v of [...this.voices, ...this.dying]) v.dispose();
    this.voices = [];
    this.dying = [];
    this.tracker.clear();
  }

  /**
   * Event times carry floating-point noise that depends on how the scheduler planned its window (a
   * few ulps: a chunked export plans differently from another chunk size). When a note lands on a
   * sample frame, which happens all the time at round tempos, that noise decides which frame a
   * native node starts on. Times within 1e-6 frames of a frame are moved onto it.
   */
  private snap(t: number): number {
    const sr = this.o.audioContext.sampleRate;
    const f = t * sr;
    const n = Math.round(f);
    return Math.abs(f - n) < 1e-6 ? n / sr : t;
  }

  /** The earliest note time that can still be heard ("now" on the note clock, which leads by `lead`). */
  private performanceNow(): number {
    return this.o.audioContext.currentTime + this.o.lead;
  }

  private contextTime(t: number, now: number): number {
    return Math.max(t - this.o.lead, now);
  }

  private sync(): void {
    const now = this.o.audioContext.currentTime;
    this.collect(now);
    const phrases = this.tracker.phrases();
    const from = firstDifference(
      this.voices.flatMap((v) => v.actions),
      phrases.flatMap((p) => p.actions),
    );
    if (from < Infinity) this.reschedule(phrases, from, now);
    phrases.forEach((p, i) => {
      const v = this.voices[i];
      if (v) v.ids = p.ids;
    });
  }

  /** Replaces the scheduled performance from performance time `from` on. */
  private reschedule(phrases: readonly Phrase[], from: number, now: number): void {
    const at = this.contextTime(from, now);
    const kept: Voice[] = [];
    for (const v of this.voices) {
      if (v.attackTime >= from) this.retire(v, at);
      else {
        v.rewind(at);
        kept.push(v);
      }
    }
    const next: Voice[] = [];
    for (const p of phrases) {
      const attack = p.actions[0] as NoteAction;
      let voice = attack.time < from ? kept[next.length] : undefined;
      if (!voice) voice = this.attack(attack, next[next.length - 1], now);
      for (const a of p.actions) {
        if (a.time < from || a === attack) continue;
        if (a.type === 'release') voice.release(this.contextTime(a.time, now));
        else voice.glide(this.contextTime(a.time, now), a.key, a.velocity, this.o.settings().glide);
      }
      voice.actions = p.actions;
      next.push(voice);
    }
    // Kept voices always match the phrases that start before `from`; this only guards the invariant.
    for (const v of kept) if (!next.includes(v)) this.retire(v, at);
    this.voices = next;
  }

  private attack(a: NoteAction, previous: Voice | undefined, now: number): Voice {
    const t = this.contextTime(a.time, now);
    if (previous && previous.stopAt > t) previous.choke(t, CHOKE);
    const o = this.o;
    return new Voice(o.audioContext, o.destination, o.tune, a, t, o.settings(), o.click);
  }

  /** Takes a voice out of the performance from `at` on: unplayed voices go at once, others fade. */
  private retire(v: Voice, at: number): void {
    if (v.start >= at) {
      v.dispose();
      return;
    }
    v.rewind(at);
    v.choke(at, KILL);
    this.dying.push(v);
  }

  /** Disconnects voices that have finished playing, and forgets their notes. */
  private collect(now: number): void {
    const before = now - COLLECT_AFTER;
    while (this.voices.length > 0 && (this.voices[0] as Voice).stopAt < before) {
      const v = this.voices.shift() as Voice;
      this.tracker.forget(v.ids);
      v.dispose();
    }
    this.dying = this.dying.filter((v) => {
      if (v.stopAt >= before) return true;
      v.dispose();
      return false;
    });
  }
}
