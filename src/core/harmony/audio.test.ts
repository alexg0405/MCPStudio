import { describe, expect, it } from 'vitest';
import { playbackMode } from '../audio/playback';
import { chromagram } from '../dj/chroma';
import { constantTempo } from '../time/ppq';
import { formatChord, parseChord, sameChord } from './chord';
import { detectClipChords } from './audio';

const SAMPLE_RATE = 22050;
const BPM = 120;
const BAR_TICKS = 3840;
const BAR_SECONDS = 2;

/** A chord as a sum of sines with a few harmonics each, one bar long. */
function chordAudio(chordNames: readonly string[]): Float32Array {
  const samplesPerBar = BAR_SECONDS * SAMPLE_RATE;
  const out = new Float32Array(samplesPerBar * chordNames.length);
  chordNames.forEach((name, bar) => {
    const chord = parseChord(name)!;
    const intervals = chord.quality === 'min' ? [0, 3, 7] : chord.quality === 'maj' ? [0, 4, 7] : [0, 4, 7, 10];
    const keys = [...intervals.map((interval) => 48 + ((chord.root - 48 + 120) % 12) + interval), 36 + ((chord.root - 36 + 120) % 12)];
    for (const key of keys) {
      const hz = 440 * Math.pow(2, (key - 69) / 12);
      for (let i = 0; i < samplesPerBar; i++) {
        const t = i / SAMPLE_RATE;
        let value = 0;
        for (let harmonic = 1; harmonic <= 4; harmonic++) value += Math.sin(2 * Math.PI * hz * harmonic * t) / harmonic;
        out[bar * samplesPerBar + i] = (out[bar * samplesPerBar + i] as number) + value * 0.1;
      }
    }
  });
  return out;
}

describe('chords from audio', () => {
  it('reads the chords of a clip a bar at a time, following the clip’s own timing', () => {
    const names = ['C', 'F', 'G', 'Am'];
    const analysis = chromagram(chordAudio(names), SAMPLE_RATE);
    const clip = { start: BAR_TICKS * 4, length: BAR_TICKS * 4, offsetSec: 0 };
    const spans = detectClipChords(analysis, clip, playbackMode({}), constantTempo(BPM), { bar: BAR_TICKS });
    const readings = spans.map((span) => formatChord(span.chord));
    const matches = spans.filter((span) => names.some((name) => sameChord(span.chord, parseChord(name)))).length;
    expect(spans.length).toBe(4);
    expect(matches, readings.join(' ')).toBeGreaterThanOrEqual(4);
    expect(spans[0]!.tick).toBe(BAR_TICKS * 4);
    expect(sameChord(spans[0]!.chord, parseChord('C'))).toBe(true);
  });
});
