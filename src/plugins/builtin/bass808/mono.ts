/**
 * The 808's mono voice handling: one sine voice per hit, legato glides inside it, and rescheduling
 * when late events change the performance (see legato.ts for the rules and why).
 */
import { clamp, mtof, ParamLane as Lane, type NoteOff, type NoteOn, type ParamSignal } from '@agstudio/sdk';
import { firstDifference, LegatoTracker, type LegatoAction, type NoteAction, type Phrase } from './legato';

/** Attack ramp of a hit (the sine starts at zero phase, so this only rounds the corner). */
const ATTACK_SEC = 0.0015;
/** Release after a note-off: time constant of the fade (about -43 dB after 50 ms). */
const RELEASE_TAU_SEC = 0.01;
/** The oscillator stops this long after a release starts (the fade is below -100 dB by then). */
const RELEASE_STOP_SEC = 0.12;
/** A new hit fades out what is left of the previous one (its release tail) over this long. */
const CHOKE_SEC = 0.008;
/** Hard all-notes-off (panic, plugin swap). */
const KILL_SEC = 0.005;
/** Shortest pitch slide (glide 0 still slides over 2 ms: inaudible, and the phase stays smooth). */
const MIN_GLIDE_SEC = 0.002;
/** Shortest level change when a glide changes the velocity. */
const MIN_LEVEL_RAMP_SEC = 0.02;
/** Click level at full velocity and click = 100%. */
const CLICK_LEVEL = 0.5;
/** A "never" stop time (moves a scheduled stop out of the way when a release is rescheduled). */
const NEVER = 1e9;
/** Finished voices are disconnected this long after they stopped. */
const COLLECT_AFTER_SEC = 0.05;

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
class BassVoice {
  /** Performance time of the attack (what the plan compares). */
  readonly attackTime: number;
  /** Context time the voice starts. */
  readonly start: number;
  actions: readonly LegatoAction[] = [];
  ids: readonly number[] = [];
  /** Context time the oscillator stops (Infinity: not scheduled). */
  stopAt = Infinity;
  private readonly oscillator: OscillatorNode;
  private readonly amplitudeGain: GainNode;
  private readonly velocityGain: GainNode;
  private readonly clickSource: AudioBufferSourceNode | null;
  private readonly clickGain: GainNode | null;
  private readonly frequencyLane: Lane;
  private readonly pitchLane: Lane;
  private readonly envelopeLane: Lane;
  private readonly levelLane: Lane;
  private readonly disconnectTune: () => void;
  private releaseAt = Infinity;
  private chokeAt = Infinity;
  private chokeLength = 0;

  constructor(
    audioContext: BaseAudioContext,
    destination: AudioNode,
    tune: ParamSignal,
    attackAction: NoteAction,
    startTime: number,
    settings: BassSettings,
    clickBuffer: AudioBuffer,
  ) {
    this.attackTime = attackAction.time;
    this.start = startTime;
    const frequencyHz = mtof(attackAction.key);
    // The punch is the oscillator's own starting detune, not a jump scheduled at t. In the render
    // quantum an oscillator starts in, Chrome feeds it the a-rate automation values of up to 127
    // frames earlier, so a jump at the start time is missed for up to 64 frames (measured: the first
    // half cycle 0.8 ms late when the start falls mid-quantum). Only the decay is scheduled, and
    // starting it a few frames late is inaudible.
    const punchCents = settings.punch * 100;
    this.oscillator = new OscillatorNode(audioContext, { type: 'sine', frequency: frequencyHz, detune: punchCents });
    this.amplitudeGain = new GainNode(audioContext, { gain: 0 });
    this.velocityGain = new GainNode(audioContext, { gain: attackAction.velocity });
    this.oscillator.connect(this.amplitudeGain).connect(this.velocityGain).connect(destination);
    this.disconnectTune = tune.connect(this.oscillator.detune);
    this.frequencyLane = new Lane(this.oscillator.frequency, frequencyHz);
    this.pitchLane = new Lane(this.oscillator.detune, punchCents);
    this.envelopeLane = new Lane(this.amplitudeGain.gain, 0);
    this.levelLane = new Lane(this.velocityGain.gain, attackAction.velocity);
    if (punchCents > 0) this.pitchLane.targetTo(startTime, 0, settings.punchTau);
    this.envelopeLane.jumpRamp(startTime, 0, 1, startTime + ATTACK_SEC);
    this.envelopeLane.targetTo(startTime + ATTACK_SEC, 0, settings.decayTau);
    this.oscillator.start(startTime);
    if (settings.click > 0) {
      this.clickSource = new AudioBufferSourceNode(audioContext, { buffer: clickBuffer });
      this.clickGain = new GainNode(audioContext, { gain: settings.click * attackAction.velocity * CLICK_LEVEL });
      this.clickSource.connect(this.clickGain).connect(destination);
      this.clickSource.start(startTime);
    } else {
      this.clickSource = null;
      this.clickGain = null;
    }
  }

  /** Slides to `key` from wherever the pitch is at `t`; the level follows the new velocity. */
  glide(atTime: number, key: number, velocity: number, glideSec: number): void {
    const slideSec = Math.max(glideSec, MIN_GLIDE_SEC);
    this.frequencyLane.rampTo(atTime, mtof(key), atTime + slideSec, true);
    this.levelLane.rampTo(atTime, velocity, atTime + Math.max(slideSec, MIN_LEVEL_RAMP_SEC));
  }

  release(atTime: number): void {
    this.envelopeLane.targetTo(atTime, 0, RELEASE_TAU_SEC);
    this.releaseAt = atTime;
    this.syncStop();
  }

  /** Fades out over `length` from `t` (a newer hit, or a hard all-notes-off). */
  choke(atTime: number, fadeSec: number): void {
    this.envelopeLane.rampTo(atTime, 0, atTime + fadeSec);
    this.chokeAt = atTime;
    this.chokeLength = fadeSec;
    this.syncStop();
  }

  /** Forgets everything scheduled from `t` on (the curves running at `t` go on). */
  rewind(atTime: number): void {
    this.frequencyLane.rewind(atTime);
    this.pitchLane.rewind(atTime);
    this.envelopeLane.rewind(atTime);
    this.levelLane.rewind(atTime);
    if (this.releaseAt >= atTime) this.releaseAt = Infinity;
    if (this.chokeAt >= atTime) this.chokeAt = Infinity;
    this.syncStop();
  }

  dispose(): void {
    for (const source of [this.oscillator, this.clickSource]) {
      try {
        source?.stop();
      } catch {
        /* already stopped */
      }
    }
    this.disconnectTune();
    for (const node of [this.oscillator, this.amplitudeGain, this.velocityGain, this.clickSource, this.clickGain])
      node?.disconnect();
  }

  private syncStop(): void {
    const stopTime = Math.min(this.releaseAt + RELEASE_STOP_SEC, this.chokeAt + this.chokeLength + 0.002);
    if (stopTime === this.stopAt) return;
    this.stopAt = stopTime;
    try {
      this.oscillator.stop(Number.isFinite(stopTime) ? stopTime : NEVER);
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
  /** Settings in effect at an AudioContext time (they may be automated). */
  settings(time: number): BassSettings;
}

/**
 * Mono legato controller. Every event updates the tracked notes; the performance derived from them
 * is compared with the one already scheduled and only what changed is rescheduled, from the first
 * difference on (voices planned after it are dropped, earlier ones are rewound and continued).
 * Events can only change the future: anything later than "now" is clamped to now.
 */
export class MonoBass {
  private readonly tracker = new LegatoTracker();
  private voices: BassVoice[] = [];
  /** Voices cut by a hard all-notes-off, fading out. */
  private dying: BassVoice[] = [];

  constructor(private readonly options: MonoBassOptions) {}

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
    const now = this.options.audioContext.currentTime;
    const contextAt = this.contextTime(this.snap(time), now);
    for (const voice of this.voices) this.retire(voice, contextAt);
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
  private snap(time: number): number {
    const sampleRate = this.options.audioContext.sampleRate;
    const exactFrame = time * sampleRate;
    const nearestFrame = Math.round(exactFrame);
    return Math.abs(exactFrame - nearestFrame) < 1e-6 ? nearestFrame / sampleRate : time;
  }

  /** The earliest note time that can still be heard ("now" on the note clock, which leads by `lead`). */
  private performanceNow(): number {
    return this.options.audioContext.currentTime + this.options.lead;
  }

  private contextTime(noteTime: number, now: number): number {
    return Math.max(noteTime - this.options.lead, now);
  }

  private sync(): void {
    const now = this.options.audioContext.currentTime;
    this.collect(now);
    const phrases = this.tracker.phrases();
    const from = firstDifference(
      this.voices.flatMap((voice) => voice.actions),
      phrases.flatMap((phrase) => phrase.actions),
    );
    if (from < Infinity) this.reschedule(phrases, from, now);
    phrases.forEach((phrase, i) => {
      const voice = this.voices[i];
      if (voice) voice.ids = phrase.ids;
    });
  }

  /** Replaces the scheduled performance from performance time `from` on. */
  private reschedule(phrases: readonly Phrase[], from: number, now: number): void {
    const contextFrom = this.contextTime(from, now);
    const kept: BassVoice[] = [];
    for (const voice of this.voices) {
      if (voice.attackTime >= from) this.retire(voice, contextFrom);
      else {
        voice.rewind(contextFrom);
        kept.push(voice);
      }
    }
    const next: BassVoice[] = [];
    for (const phrase of phrases) {
      const attack = phrase.actions[0] as NoteAction;
      let voice = attack.time < from ? kept[next.length] : undefined;
      if (!voice) voice = this.attack(attack, next[next.length - 1], now);
      for (const action of phrase.actions) {
        if (action.time < from || action === attack) continue;
        if (action.type === 'release') voice.release(this.contextTime(action.time, now));
        else {
          const actionAt = this.contextTime(action.time, now);
          voice.glide(actionAt, action.key, action.velocity, this.options.settings(actionAt).glide);
        }
      }
      voice.actions = phrase.actions;
      next.push(voice);
    }
    // Kept voices always match the phrases that start before `from`; this only guards the invariant.
    for (const voice of kept) if (!next.includes(voice)) this.retire(voice, contextFrom);
    this.voices = next;
  }

  private attack(attackAction: NoteAction, previous: BassVoice | undefined, now: number): BassVoice {
    const startTime = this.contextTime(attackAction.time, now);
    if (previous && previous.stopAt > startTime) previous.choke(startTime, CHOKE_SEC);
    const options = this.options;
    return new BassVoice(
      options.audioContext,
      options.destination,
      options.tune,
      attackAction,
      startTime,
      options.settings(startTime),
      options.click,
    );
  }

  /** Takes a voice out of the performance from `at` on: unplayed voices go at once, others fade. */
  private retire(voice: BassVoice, atTime: number): void {
    if (voice.start >= atTime) {
      voice.dispose();
      return;
    }
    voice.rewind(atTime);
    voice.choke(atTime, KILL_SEC);
    this.dying.push(voice);
  }

  /** Disconnects voices that have finished playing, and forgets their notes. */
  private collect(now: number): void {
    const before = now - COLLECT_AFTER_SEC;
    while (this.voices.length > 0 && (this.voices[0] as BassVoice).stopAt < before) {
      const voice = this.voices.shift() as BassVoice;
      this.tracker.forget(voice.ids);
      voice.dispose();
    }
    this.dying = this.dying.filter((v) => {
      if (v.stopAt >= before) return true;
      v.dispose();
      return false;
    });
  }
}
