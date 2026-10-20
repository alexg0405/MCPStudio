/**
 * Chords: a polyphonic part (keys, pads, guitar, a mixed loop) read as one chord at a time. The listening is the DJ
 * chromagram (`detectChroma`, the slow part, for a Worker); the reading is the harmony code's own: the chroma of every beat
 * (or half bar, or bar) of the clip goes through `detectSpansFromChroma`, a lone window that disagrees with both neighbours
 * is smoothed away, and the chords are written as notes with the harmony voicing code (smooth voice leading, an optional
 * bass note, a rhythm). Pure and deterministic.
 */
import { chromagram, type Chromagram } from '../../dj/chroma';
import { sameChord } from '../../harmony/chord';
import { detectSpansFromChroma, type DetectedSpan } from '../../harmony/detect';
import { clipChromaWindows } from '../../harmony/audio';
import { compNotes, voiceChords } from '../../harmony/voicing';
import { clipEndTick, type ClipTimeline } from './timeline';
import type { PlannedChord, PlannedNote, TranscribeSettings } from './types';

/** The chromagram of a mono recording: what the chord reading is made from. */
export function detectChroma(mono: Float32Array, sampleRate: number): Chromagram {
  return chromagram(mono, sampleRate);
}

/** A window that is the only one of its chord, between two windows of another chord, is smoothed away, unless the reading is this sure. */
const SURE_CONFIDENCE = 0.8;

/** The ticks a window of a resolution lasts. */
function windowTicksOf(resolution: TranscribeSettings['chordResolution'], timeline: ClipTimeline): number {
  if (resolution === 'bar') return timeline.barTicks;
  if (resolution === 'half') return Math.round(timeline.barTicks / 2);
  return timeline.beatTicks;
}

/** One reading per window (the spans split back into windows), so smoothing sees every window. */
function perWindow(spans: readonly DetectedSpan[], windowTicks: number): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const span of spans) {
    for (let tick = span.tick; tick < span.tick + span.length - 1; tick += windowTicks) {
      out.push({ ...span, tick, length: Math.min(windowTicks, span.tick + span.length - tick) });
    }
  }
  return out;
}

/** Neighbouring windows that read the same chord, as one span. */
function joined(windows: readonly DetectedSpan[]): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const window of windows) {
    const last = out[out.length - 1];
    if (last && last.tick + last.length === window.tick && sameChord(last.chord, window.chord)) {
      const total = last.length + window.length;
      last.confidence = (last.confidence * last.length + window.confidence * window.length) / total;
      last.length = total;
    } else out.push({ ...window });
  }
  return out;
}

/** Windows of a chord that lasts one window between two windows of one other chord take that chord (a flicker, not a change). */
function withoutFlicker(windows: readonly DetectedSpan[]): DetectedSpan[] {
  const out = windows.map((w) => ({ ...w }));
  for (let i = 1; i + 1 < out.length; i++) {
    const before = out[i - 1] as DetectedSpan;
    const here = out[i] as DetectedSpan;
    const after = out[i + 1] as DetectedSpan;
    const isLone = !sameChord(here.chord, before.chord) && !sameChord(here.chord, after.chord);
    if (isLone && sameChord(before.chord, after.chord) && here.confidence < SURE_CONFIDENCE) {
      out[i] = { ...here, chord: before.chord, confidence: Math.min(before.confidence, after.confidence) };
    }
  }
  return out;
}

/**
 * A span as a plain chord, without a slash bass: the bass of a mixed sound moves with every note it plays, so a slash chord
 * read from audio is mostly a passing bass note (the voicing's own inversions cover what a player would do).
 */
function withoutSlash(span: DetectedSpan): DetectedSpan {
  return { ...span, chord: { root: span.chord.root, quality: span.chord.quality } };
}

/** The chords of a clip, one reading per window, flickers smoothed, neighbours joined (song ticks). */
export function readChords(chroma: Chromagram, timeline: ClipTimeline, settings: Pick<TranscribeSettings, 'chordResolution'>): DetectedSpan[] {
  const windowTicks = windowTicksOf(settings.chordResolution, timeline);
  const windows = clipChromaWindows(chroma, timeline.clip, timeline.mode, timeline.tempo, windowTicks);
  const spans = detectSpansFromChroma(windows).map(withoutSlash);
  return joined(withoutFlicker(perWindow(spans, windowTicks)));
}

/** The chords as the chord track takes them. */
export function plannedChords(spans: readonly DetectedSpan[]): PlannedChord[] {
  return spans.map((span) => ({
    tick: span.tick,
    length: span.length,
    root: span.chord.root,
    quality: span.chord.quality,
    ...(span.chord.bass !== undefined ? { bass: span.chord.bass } : {}),
    confidence: Math.round(span.confidence * 100) / 100,
  }));
}

/** The keys of the chord notes sit around middle C: the hand a keyboard player would use. */
const HAND_CENTER = 60;
/** Loudness of the written chords: a chord part is played at a steady, comfortable level. */
const CHORD_VELOCITY = 0.8;

/** The chords as notes of a pattern (ticks from the clip's start): voiced with voice leading, played in the chosen rhythm. */
export function chordNotes(spans: readonly DetectedSpan[], timeline: ClipTimeline, settings: Pick<TranscribeSettings, 'chordRhythm' | 'chordBass'>): PlannedNote[] {
  const start = timeline.clip.start;
  const end = clipEndTick(timeline);
  const inside = spans.filter((span) => span.tick < end && span.tick + span.length > start);
  const voicings = voiceChords(inside.map((span) => span.chord), { center: HAND_CENTER, bass: settings.chordBass });
  const notes = compNotes(
    inside.map((span) => ({ tick: Math.max(start, span.tick) - start, length: Math.min(end, span.tick + span.length) - Math.max(start, span.tick) })),
    voicings,
    { rhythm: settings.chordRhythm, beat: timeline.beatTicks, velocity: CHORD_VELOCITY },
  );
  return notes.map((note) => ({ tick: note.tick, length: note.length, key: note.key, velocity: note.velocity }));
}
