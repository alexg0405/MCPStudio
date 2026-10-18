import { describe, expect, it } from 'vitest';
import { TONE_CROSSOVERS } from '../reference/bands';
import { BandMap, octaveEdges, powerToDb, referenceCurve, sharesDb, tiltDb } from './octave';
import { formatReport, reportNotes, withAdvice, type LoudnessReport } from './report';
import { againstTarget, streamingAdvice } from './targets';

const SR = 48000;
const FFT = 8192;

/** The power spectrum `StereoSpectrum` would give for a full-scale sine centred on `bin` (Hann: 1, ¼, ¼ of the peak power). */
function sineSpectrum(bin: number): Float32Array {
  const power = new Float32Array(FFT / 2);
  power[bin] = 1;
  power[bin - 1] = 0.25;
  power[bin + 1] = 0.25;
  return power;
}

describe('1/6-octave bands', () => {
  const map = new BandMap(octaveEdges(6, 20, 20000), SR, FFT);

  it('cover 20 Hz to almost 20 kHz in 1/6-octave bands of equal width on a log axis', () => {
    expect(map.count).toBe(59);
    expect(map.lo[0]).toBeCloseTo(20, 5);
    expect(map.hi[map.count - 1]).toBeGreaterThan(17000);
    expect(map.hi[map.count - 1]).toBeLessThanOrEqual(20001);
    const ratio = (map.hi[10] as number) / (map.lo[10] as number);
    expect(ratio).toBeCloseTo(2 ** (1 / 6), 6);
  });

  it('read a full-scale sine as 0 dB in whichever band holds it, however the bins fall', () => {
    for (const bin of [40, 85, 171, 640, 1900]) {
      const out = new Float64Array(map.count);
      map.fold(sineSpectrum(bin), out);
      const total = out.reduce((a, b) => a + b, 0);
      expect(powerToDb(total), `bin ${bin}`).toBeCloseTo(0, 0);
      expect(powerToDb(Math.max(...out)), `bin ${bin}`).toBeGreaterThan(-3.2);
    }
  });

  it('add up to the total power of the spectrum (white noise keeps its power)', () => {
    const noise = new Float32Array(FFT / 2).fill(0.001);
    const out = new Float64Array(map.count);
    map.fold(noise, out);
    const total = out.reduce((a, b) => a + b, 0);
    // The bins between 20 Hz and 20 kHz, each 0.001 / 1.5.
    const bins = ((map.hi[map.count - 1] as number) - 20) / (SR / FFT);
    expect(total).toBeCloseTo((0.001 * bins) / 1.5, 1);
  });
});

describe('display math', () => {
  it('tilts around 1 kHz', () => {
    expect(tiltDb(1000, 4.5)).toBe(0);
    expect(tiltDb(2000, 3)).toBeCloseTo(3, 9);
    expect(tiltDb(500, 3)).toBeCloseTo(-3, 9);
  });

  it('turns band powers into shares under the total', () => {
    const shares = sharesDb([1, 1, 2]);
    expect(shares[2]).toBeCloseTo(-3.01, 1);
    expect(shares[0]).toBeCloseTo(-6.02, 1);
  });

  it('draws a reference balance at the live level: its bands carry its energy, spread over the display bands they cover', () => {
    const map = new BandMap(octaveEdges(6, 20, 20000), SR, FFT);
    // All the energy in the 1 kHz to 2.5 kHz band (index 4 of 8).
    const shares = [-60, -60, -60, -60, 0, -60, -60, -60];
    const curve = referenceCurve(shares, TONE_CROSSOVERS, map, -20);
    const lit = [...curve].filter((v) => v > -119);
    expect(lit.length).toBeGreaterThan(3);
    // Power sum of the lit bands is the live total (−20 dB).
    const sum = lit.reduce((a, v) => a + 10 ** (v / 10), 0);
    expect(10 * Math.log10(sum)).toBeCloseTo(-20, 1);
    // A reference without a level reads nothing.
    expect([...referenceCurve(shares, TONE_CROSSOVERS, map, -Infinity)].every((v) => v === -120)).toBe(true);
  });
});

describe('streaming advice', () => {
  const byName = (lufs: number, peak: number | null) => Object.fromEntries(streamingAdvice(lufs, peak).map((a) => [a.service, a]));

  it('turns a loud song down to each service’s level', () => {
    const advice = byName(-9, -0.5);
    expect(advice['Spotify']?.changeDb).toBe(-5);
    expect(advice['Apple Music']?.changeDb).toBe(-7);
    expect(advice['YouTube']?.text).toBe('turns it down 5.0 dB');
  });

  it('turns a quiet song up only where the service does, and only as far as the peaks allow', () => {
    const advice = byName(-20, -6);
    expect(advice['Spotify']?.changeDb).toBe(5);
    expect(advice['YouTube']?.changeDb).toBe(0);
    const tight = byName(-20, -2);
    expect(tight['Spotify']?.changeDb).toBe(1);
    expect(tight['Spotify']?.text).toContain('as far as its peaks allow');
  });

  it('says nothing for silence, and compares with a target in words', () => {
    expect(streamingAdvice(-Infinity, null)).toEqual([]);
    expect(againstTarget(-12, -14)).toBe('2.0 LU louder than the target');
    expect(againstTarget(-14.2, -14)).toBe('on target');
  });
});

describe('the loudness report', () => {
  const base = {
    projectId: 'p',
    what: 'the whole song',
    seconds: 61.2,
    fromTick: 0,
    integrated: -8.6,
    range: 2.1,
    truePeakDb: -0.4,
    truePeakAt: { sec: 12, tick: 960 * 4 * 9 },
    samplePeakDb: -0.8,
    maxMomentary: -6.5,
    maxMomentaryAt: { sec: 30, tick: 960 * 4 * 17 },
    maxShortTerm: -7.2,
    maxShortTermAt: null,
    correlation: 0.6,
    monoLossDb: -1.2,
    at: 0,
  };
  const timeSig = { num: 4, den: 4 };

  it('warns about a hot true peak, a squashed range and the loudness', () => {
    const notes = reportNotes(base);
    expect(notes.some((n) => n.includes('over −1 dBTP'))).toBe(true);
    expect(notes.some((n) => n.includes('very loud'))).toBe(true);
    expect(notes.some((n) => n.includes('loudness range is only'))).toBe(true);
    expect(reportNotes({ ...base, integrated: -Infinity })).toEqual(['Nothing audible was measured.']);
  });

  it('reads as text with the bar of each loudest moment and what the services do', () => {
    const report: LoudnessReport = withAdvice(base);
    const text = formatReport(report, timeSig);
    expect(text).toContain('Integrated loudness: −8.6 LUFS');
    expect(text).toContain('True peak: −0.4 dBTP at bar 10');
    expect(text).toContain('Loudest momentary (400 ms): −6.5 LUFS at bar 18');
    expect(text).toContain('Spotify (−14.0 LUFS): turns it down 5.4 dB');
  });
});
