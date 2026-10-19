/**
 * Puts a harmony voice's notes where they belong in time: each note keeps the sound around it (a consonant before, the tail
 * after), is moved by its humanize delay, silenced when the voice has no note there, and the stretches between notes (breaths,
 * noise, the other consonants of the lead) are left out, so a stack of voices does not stack the lead's breaths.
 *
 * Pure and deterministic (no DOM, no globals). Neighbouring notes are crossfaded with a partition of unity, so a stretch both
 * notes reach never changes level.
 */

/** One note of a voice on the sample's timeline. */
export interface VoicePart {
  /** Seconds the note starts and ends (on the same timeline as `start` of the audio). */
  from: number;
  to: number;
  /** Seconds the note is moved (early negative, late positive). */
  delaySec: number;
  /** The voice sings nothing here. */
  silent: boolean;
}

/** Sound kept before a note starts (a consonant), seconds. */
export const KEEP_BEFORE_SEC = 0.1;
/** Sound kept after a note ends (a tail, an "n" or "s"), seconds. */
export const KEEP_AFTER_SEC = 0.15;
/** Crossfade where two parts meet, seconds. */
const CROSSFADE_SEC = 0.012;
/** Fade where the kept sound meets silence, seconds. */
const EDGE_FADE_SEC = 0.02;

/** One part's stretch of the output and how it fades in and out (all in samples, output time). */
interface Window {
  /** Where the fade-in starts and its length. */
  inStart: number;
  inLength: number;
  /** Where the fade-out starts and its length. */
  outStart: number;
  outLength: number;
  /** Samples the part's source is moved by. */
  delay: number;
  silent: boolean;
}

/** A raised-cosine rise from 0 at `start` to 1 at `start + length`. */
function rise(n: number, start: number, length: number): number {
  if (n <= start) return 0;
  if (n >= start + length) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * (n - start)) / length);
}

/** The windows of the parts: parts that meet share a crossfade, free edges fade over `EDGE_FADE_SEC`. */
function windowsOf(parts: readonly VoicePart[], sampleRate: number, start: number): Window[] {
  const at = (t: number) => (t - start) * sampleRate;
  const before = KEEP_BEFORE_SEC * sampleRate;
  const after = KEEP_AFTER_SEC * sampleRate;
  const fade = EDGE_FADE_SEC * sampleRate;
  const cross = CROSSFADE_SEC * sampleRate;
  const windows: Window[] = parts.map((p) => {
    const delay = Math.round(p.delaySec * sampleRate);
    return {
      inStart: at(p.from) - before + delay,
      inLength: fade,
      outStart: at(p.to) + after + delay - fade,
      outLength: fade,
      delay,
      silent: p.silent,
    };
  });
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1] as VoicePart;
    const cur = parts[i] as VoicePart;
    const gap = at(cur.from) - at(prev.to);
    if (gap > before + after) continue;
    // They reach each other: the border sits between the notes, nearer the one with the shorter reach, shared by both fades.
    const border = at(prev.to) + (gap * after) / (before + after);
    const centre = border + ((windows[i - 1] as Window).delay + (windows[i] as Window).delay) / 2;
    const width = Math.max(1, Math.min(cross, Math.abs(at(cur.to) - at(prev.from)) / 2));
    (windows[i - 1] as Window).outStart = centre - width / 2;
    (windows[i - 1] as Window).outLength = width;
    (windows[i] as Window).inStart = centre - width / 2;
    (windows[i] as Window).inLength = width;
  }
  return windows;
}

/**
 * The voice's audio arranged: every part's sound (moved by its delay) inside its window, nothing between the windows.
 * `channels` begin at `start` seconds on the parts' timeline; the result is as long as the input.
 */
export function arrangeVoice(channels: readonly Float32Array[], sampleRate: number, start: number, parts: readonly VoicePart[]): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  const out = channels.map(() => new Float32Array(length));
  const windows = windowsOf(parts, sampleRate, start);
  windows.forEach((w) => {
    if (w.silent) return;
    const first = Math.max(0, Math.floor(w.inStart));
    const last = Math.min(length - 1, Math.ceil(w.outStart + w.outLength));
    for (let n = first; n <= last; n++) {
      const weight = rise(n, w.inStart, w.inLength) * (1 - rise(n, w.outStart, w.outLength));
      const from = n - w.delay;
      if (weight <= 0 || from < 0 || from >= length) continue;
      channels.forEach((channel, c) => {
        const target = out[c] as Float32Array;
        target[n] = (target[n] as number) + weight * (channel[from] as number);
      });
    }
  });
  return out;
}
