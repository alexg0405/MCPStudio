import { butterworth, filterInPlace } from '../filters';
import { sanitize } from '../pitch';
import { classifyEvent } from './classify';
import { Envelopes } from './envelopes';
import { SpectralFeatures } from './features';
import { dbToAmp, median } from './math';
import { OnsetDetector } from './onsets';
import { PitchFrames } from './pitch-frames';
import { BLOCK_SEC, HOP_SEC, VOICE_THRESHOLDS } from './thresholds';
import { mergeLegato, splitByPitch } from './tonal';
import type { AnalyzeOptions, Measured, Onset, VoiceEvent, VoiceMode } from './types';

const T = VOICE_THRESHOLDS;

/** The level is an 11 ms centered RMS: it stops this long before the next onset (s) so it never sees it. */
const LEVEL_STOP_BEFORE_NEXT_SEC = 0.007;
/** The default smallest gap between onsets (s). */
const DEFAULT_MIN_GAP_SEC = 0.05;
/** The pitch of a tonal event is measured over its frames; fewer than this and it has no pitch. */
const MIN_PITCHED_FRAMES = 3;
/** The end pitch is the median of the last quarter of the pitched frames (pitched count ÷ this)… */
const END_PITCH_DIVISOR = 4;
/** …but over at least this many frames (and at most the hold time). */
const MIN_END_PITCH_FRAMES = 3;

/** One analysis run over one recording. Create it, call `run()` once. */
export class Analysis {
  private readonly sampleRate: number;
  private readonly sensitivity: number;
  private readonly minGapSec: number;
  private readonly mode: VoiceMode;
  /** The recording after DC and rumble are removed. */
  private readonly samples: Float32Array;
  private readonly envelopes: Envelopes;
  private readonly pitch: PitchFrames;
  private readonly features: SpectralFeatures;

  constructor(samples: Float32Array, sampleRate: number, options: AnalyzeOptions) {
    this.sampleRate = sampleRate;
    this.sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5));
    this.minGapSec = Math.max(0, options.minGapSec ?? DEFAULT_MIN_GAP_SEC);
    this.mode = options.mode ?? 'auto';
    this.samples = sanitize(samples);
    filterInPlace(this.samples, butterworth('highpass', 2, T.highPassHz, sampleRate));
    this.envelopes = new Envelopes(this.samples, sampleRate);
    this.pitch = new PitchFrames(this.samples, sampleRate);
    this.features = new SpectralFeatures(this.samples, sampleRate);
  }

  /** The events found in the recording, in time order; empty for silence. */
  run(): VoiceEvent[] {
    if (!(this.envelopes.peakLevel > dbToAmp(T.silenceDbfs))) return [];
    const detector = new OnsetDetector(this.samples, this.sampleRate, this.envelopes, this.pitch, {
      sensitivity: this.sensitivity,
      minGapSec: this.minGapSec,
    });
    const onsets = detector.detect();
    if (onsets.length === 0) return [];
    const totalSec = this.samples.length / this.sampleRate;
    let events = onsets.map((onset, i) =>
      this.measure(onset, onsets[i - 1]?.time ?? -Infinity, onsets[i + 1]?.time ?? totalSec),
    );
    if (this.mode !== 'drums') {
      const measure = this.measure.bind(this);
      events = mergeLegato(events, measure);
      events = splitByPitch(events, measure, this.pitch);
    }
    return this.finish(events);
  }

  /** Measures the sound from `onset` to `endSec`: level, decay, sustain and features, then classifies it. */
  private measure(onset: Onset, prevSec: number, endSec: number): Measured {
    const env = this.envelopes;
    const startSec = onset.time;
    const startBlock = env.blockAt(startSec);
    const endBlock = Math.max(startBlock, env.blockAt(endSec - LEVEL_STOP_BEFORE_NEXT_SEC));
    const { at: peakAt, value: peak } = env.maxIn(env.level, startBlock, endBlock);
    const decayLevel = Math.max(peak * dbToAmp(-T.decayDb), env.noise * dbToAmp(T.decayAboveNoiseDb));
    const sustainLevel = peak * dbToAmp(-T.sustainDropDb);
    // A sound still going at the next onset lasts until it (the level stops 7 ms short).
    const until = (block: number) => (block < 0 ? endSec : Math.min(endSec, env.blockStart(block)));
    const periodicity = this.pitch.periodicity(startSec, endSec);
    const measured: Measured = {
      onset,
      prev: prevSec,
      end: endSec,
      peak,
      duration: Math.max(BLOCK_SEC, until(env.firstBelow(peakAt, endBlock, decayLevel)) - startSec),
      sustainSec: Math.max(0, until(env.firstBelow(peakAt, endBlock, sustainLevel)) - startSec),
      features: this.features.measure(onset, prevSec, endSec, periodicity),
      kind: 'snare',
      confidence: 0,
    };
    classifyEvent(measured, this.mode, this.pitch);
    return measured;
  }

  /** The public events: strength relative to the loudest, and the pitch of tonal ones. */
  private finish(events: Measured[]): VoiceEvent[] {
    let loudest = 0;
    for (const event of events) loudest = Math.max(loudest, event.peak);
    return events.map((event) => {
      const { pitch, pitchEnd } = this.pitchOf(event);
      return {
        time: event.onset.time,
        duration: event.duration,
        strength: loudest > 0 ? event.peak / loudest : 0,
        kind: event.kind,
        confidence: Math.max(0, Math.min(1, event.confidence)),
        pitch,
        pitchEnd,
        features: event.features,
      };
    });
  }

  /** The median pitch and the pitch near the end of a tonal event; both null for other kinds or too few pitched frames. */
  private pitchOf(event: Measured): { pitch: number | null; pitchEnd: number | null } {
    if (event.kind !== 'tonal') return { pitch: null, pitchEnd: null };
    const { midi } = this.pitch.midiTrack(event.onset.time, event.end, event.peak);
    const pitched = Array.from(midi).filter((v) => !Number.isNaN(v));
    if (pitched.length < MIN_PITCHED_FRAMES) return { pitch: null, pitchEnd: null };
    const holdFrames = Math.round(T.splitHoldSec / HOP_SEC);
    const tail = Math.max(MIN_END_PITCH_FRAMES, Math.min(holdFrames, Math.ceil(pitched.length / END_PITCH_DIVISOR)));
    return { pitch: median(pitched), pitchEnd: median(pitched.slice(-tail)) };
  }
}
