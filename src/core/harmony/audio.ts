/**
 * Chords from audio: the DJ chromagram of an audio clip's sample summed over each bar or half bar of the clip, then read
 * with the same chord detector as notes. The playback maths (where in the sample a song tick plays) is the clip's own, so
 * trims, pitch and tempo follow are respected. Pure, no DOM.
 */
import type { AudioClip, Tick } from '../model/types';
import type { Chromagram } from '../dj/chroma';
import { sourceSecondsAt, type PlaybackMode } from '../audio/playback';
import type { TempoMap } from '../time/ppq';
import { detectSpansFromChroma, type ChromaWindow, type DetectedSpan } from './detect';

const NOTES = 12;

/** Summed treble chroma and bass chroma of the frames between two times in the sample. */
function chromaOfSeconds(chromagram: Chromagram, fromSec: number, toSec: number): { chroma: Float64Array; bass: Float64Array } {
  const chroma = new Float64Array(NOTES);
  const bass = new Float64Array(NOTES);
  const first = Math.max(0, Math.round(fromSec * chromagram.frameRate));
  const last = Math.min(chromagram.frames, Math.max(first + 1, Math.round(toSec * chromagram.frameRate)));
  for (let frame = first; frame < last; frame++) {
    for (let note = 0; note < NOTES; note++) {
      const treble = chromagram.treble[frame * NOTES + note] as number;
      const low = chromagram.bass[frame * NOTES + note] as number;
      chroma[note] = (chroma[note] as number) + treble + 0.5 * low;
      bass[note] = (bass[note] as number) + low;
    }
  }
  return { chroma, bass };
}

/** The chroma of each window of the clip: `windowTicks` long, from the clip's start, in song ticks. */
export function clipChromaWindows(
  chromagram: Chromagram,
  clip: Pick<AudioClip, 'start' | 'length' | 'offsetSec'>,
  mode: PlaybackMode,
  tempo: TempoMap,
  windowTicks: Tick,
): ChromaWindow[] {
  const windows: ChromaWindow[] = [];
  const end = clip.start + clip.length;
  for (let tick = clip.start; tick < end; tick += windowTicks) {
    const stop = Math.min(end, tick + windowTicks);
    const fromSec = sourceSecondsAt(clip, mode, tempo, tick);
    const toSec = sourceSecondsAt(clip, mode, tempo, stop);
    windows.push({ tick, length: stop - tick, ...chromaOfSeconds(chromagram, fromSec, toSec) });
  }
  return windows;
}

/** The chords an audio clip plays, a reading per bar or half bar (song ticks). */
export function detectClipChords(
  chromagram: Chromagram,
  clip: Pick<AudioClip, 'start' | 'length' | 'offsetSec'>,
  mode: PlaybackMode,
  tempo: TempoMap,
  options: { bar: Tick; resolution?: 'bar' | 'half' },
): DetectedSpan[] {
  const windowTicks = options.resolution === 'half' ? Math.round(options.bar / 2) : options.bar;
  return detectSpansFromChroma(clipChromaWindows(chromagram, clip, mode, tempo, windowTicks));
}
