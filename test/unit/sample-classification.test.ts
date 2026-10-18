/**
 * The sample browser's one-shot classifier on synthetic sounds: the engine's kit generators (11 stock sounds and the five
 * pieces of seven genre kits), the Drum Pads' built-in sounds, and randomized hand-made kicks, snares, claps, hats, cymbals,
 * toms, 808s, tonal notes, risers and a sung vowel (`test/helpers/sample-corpus.ts`). Target: at least 90 % of the clear
 * cases right; the ones a person would argue about (a shaker, a conga, a rumbling impact, a vocal) are reported but not
 * counted. The thresholds were set while looking at this corpus, so the numbers are best read as "the rules are
 * consistent", and the variants below (other sample rates, a quiet file, silence in front, a noise floor, stereo) check
 * that they do not depend on those details.
 */
import { describe, expect, it } from 'vitest';
import { analyzeSample } from '@core/samples/analyze';
import { SAMPLE_CATEGORIES } from '@core/samples/types';
import { corpusAt, engineCorpus, handmadeCorpus, type CorpusSound } from '../helpers/sample-corpus';
import { mulberry32 } from '@core/voice/test-signals';

const run = (s: CorpusSound, rate: number, tweak?: (x: Float32Array) => Float32Array) => {
  const x = tweak ? tweak(s.x) : s.x;
  return analyzeSample([x], rate);
};

function report(sounds: CorpusSound[], rate: number, tweak?: (x: Float32Array) => Float32Array) {
  const confusion = new Map<string, number>();
  let clear = 0;
  let right = 0;
  const wrong: string[] = [];
  for (const s of sounds) {
    const got = run(s, rate, tweak).category;
    if (!s.clear) continue;
    clear++;
    if (got === s.label) right++;
    else {
      wrong.push(`${s.name}: ${s.label} read as ${got}`);
      const k = `${s.label}→${got}`;
      confusion.set(k, (confusion.get(k) ?? 0) + 1);
    }
  }
  return { clear, right, accuracy: right / clear, wrong };
}

describe('one-shot classification', () => {
  const sounds = [...engineCorpus(), ...handmadeCorpus(12)];

  it('covers every category with clear examples', () => {
    for (const c of SAMPLE_CATEGORIES.filter((c) => c !== 'vocal')) expect(sounds.some((s) => s.clear && s.label === c), c).toBe(true);
    expect(sounds.filter((s) => s.clear).length).toBeGreaterThan(150);
  });

  it('gets at least 90 % of the clear cases right (44.1 kHz)', () => {
    const r = report(sounds, 44100);
    expect(r.wrong, r.wrong.join('\n')).toEqual([]);
    expect(r.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('does as well on a fresh set of hand-made sounds (other seed)', () => {
    const r = report(handmadeCorpus(30, 424242), 44100);
    expect(r.accuracy, r.wrong.join('\n')).toBeGreaterThanOrEqual(0.9);
  });

  for (const rate of [22050, 48000, 96000]) {
    it(`does as well at ${rate} Hz`, () => {
      const set = corpusAt(rate, () => [...engineCorpus(), ...handmadeCorpus(6, 11)]);
      const r = report(set, rate);
      expect(r.accuracy, r.wrong.join('\n')).toBeGreaterThanOrEqual(0.9);
    });
  }

  it('does not depend on level, leading silence, a noise floor or stereo', () => {
    const rnd = mulberry32(5);
    const variants: [string, (x: Float32Array) => Float32Array][] = [
      ['−24 dB', (x) => x.map((v) => v * 0.063)],
      ['0.3 s of silence in front', (x) => {
        const out = new Float32Array(x.length + 13230);
        out.set(x, 13230);
        return out;
      }],
      ['a −66 dBFS noise floor', (x) => x.map((v) => v + (rnd() * 2 - 1) * 0.0005)],
      ['a little DC offset', (x) => x.map((v) => v + 0.01)],
    ];
    for (const [name, tweak] of variants) {
      const r = report(sounds, 44100, tweak);
      expect(r.accuracy, `${name}: ${r.wrong.slice(0, 8).join('; ')}`).toBeGreaterThanOrEqual(0.9);
    }
    // Stereo with a different copy in the right channel (a haas-style widened sound).
    let right = 0;
    let n = 0;
    for (const s of sounds.filter((s) => s.clear)) {
      const r2 = new Float32Array(s.x.length);
      r2.set(s.x.subarray(0, s.x.length - 40), 40);
      if (analyzeSample([s.x, r2], 44100).category === s.label) right++;
      n++;
    }
    expect(right / n).toBeGreaterThanOrEqual(0.9);
  });

  it('reports a confidence: high when sure, and lower on the sounds a person would argue about', () => {
    const clear = sounds.filter((s) => s.clear).map((s) => run(s, 44100));
    const meanClear = clear.reduce((a, r) => a + r.confidence, 0) / clear.length;
    expect(meanClear).toBeGreaterThan(0.7);
    for (const r of clear) expect(r.confidence).toBeGreaterThanOrEqual(0);
    const unclear = sounds.filter((s) => !s.clear && run(s, 44100).category !== s.label);
    // Where the analyzer is wrong on those, it should not be as sure as it is on the clear ones.
    for (const s of unclear.filter((u) => u.label === 'vocal')) expect(run(s, 44100).confidence).toBeLessThan(0.9);
  });

  it('puts the note on tonal sounds, 808s and kicks (a hundredth of a semitone, octave included)', () => {
    let checked = 0;
    for (const s of sounds.filter((s) => s.midi !== undefined && (s.label === 'tonal' || s.label === '808'))) {
      const a = analyzeSample([s.x], 44100);
      expect(a.midi, s.name).toBeDefined();
      expect(Math.abs((a.midi as number) - (s.midi as number)), `${s.name}: ${a.midi} vs ${s.midi}`).toBeLessThan(0.5);
      expect(a.root, s.name).toBe((s.midi as number) % 12);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('measures loudness, peak and brightness', () => {
    const hat = sounds.find((s) => s.name === 'kit/hat-closed')!;
    const kick = sounds.find((s) => s.name === 'kit/kick')!;
    const h = analyzeSample([hat.x], 44100);
    const k = analyzeSample([kick.x], 44100);
    expect(h.brightness).toBeGreaterThan(5000);
    expect(k.brightness).toBeLessThan(400);
    // A quieter copy reads quieter by the same amount.
    const quiet = analyzeSample([kick.x.map((v) => v * 0.25)], 44100);
    expect(k.loudnessDb - quiet.loudnessDb).toBeCloseTo(12, 0);
    expect(k.peakDb - quiet.peakDb).toBeCloseTo(12, 0);
    expect(k.peakDb).toBeLessThanOrEqual(0);
  });

  it('treats silence as a one-shot with no category instead of failing', () => {
    const a = analyzeSample([new Float32Array(44100)], 44100);
    expect(a.kind).toBe('one-shot');
    expect(a.category).toBeNull();
    const tiny = analyzeSample([new Float32Array(5)], 44100);
    expect(tiny.category).toBeNull();
  });

  it('lets the file name tip a close call but not overrule a clear sound', () => {
    const snare = sounds.find((s) => s.name === 'kit/snare')!;
    const hat = sounds.find((s) => s.name === 'kit/hat-closed')!;
    // A clear snare named "kick" stays a snare; the name is a nudge.
    expect(analyzeSample([snare.x], 44100, { path: 'Drums/Kick 02.wav' }).category).toBe('snare');
    // A shaker that looks like a hat is a perc when the folder says so.
    const shaker = sounds.find((s) => s.name === 'pads/shaker')!;
    const named = analyzeSample([shaker.x], 44100, { path: 'Percussion/Shaker 1.wav' });
    expect(named.category).toBe('perc');
    expect(named.basis).toBe('name');
    expect(analyzeSample([hat.x], 44100, { path: 'Hats/Hat 01.wav' }).basis).toBe('both');
  });
});
