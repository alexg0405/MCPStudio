/**
 * Accuracy sweep over synthetic songs: seven styles, each at a few tempos around its usual one
 * (including fractional BPMs) with random offsets, and keys in all modes. Prints the numbers the
 * docs quote and asserts the bars they must clear.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../voice/test-signals';
import { analyzeTrack } from './analyze';
import { keyName } from './key';
import { MAJOR, MINOR, PATTERNS, chord, renderTestSong, type DrumPattern } from './test-songs';

const SR = 22050;
const STYLES: [string, number, DrumPattern][] = [
  ['house', 124, PATTERNS.house],
  ['boom bap', 88, { ...PATTERNS.boomBap, swing: 0.63 }],
  ['trap', 142, PATTERNS.trap],
  ['dnb', 172, PATTERNS.dnb],
  ['dembow', 96, PATTERNS.dembow],
  ['pop', 112, PATTERNS.pop],
  ['lo-fi', 78, { ...PATTERNS.boomBap, swing: 0.6 }],
];

describe('accuracy sweep', () => {
  it('finds tempo, downbeat and key across styles', () => {
    const rand = mulberry32(42);
    let n = 0;
    let bpmOk = 0;
    let octaveOk = 0;
    let downbeatOk = 0;
    let keyOk = 0;
    const bpmErr: number[] = [];
    const dbErr: number[] = [];
    const dbSigned: number[] = [];
    const misses: string[] = [];
    for (const [name, base, pattern] of STYLES)
      for (const delta of [-2.5, 0, 3.3]) {
        const bpm = Math.round((base + delta) * 100) / 100;
        const root = Math.floor(rand() * 12);
        const minor = rand() < 0.5;
        const r = 48 + root;
        const chords = minor
          ? [chord(r, MINOR), chord(r + 5, MINOR), chord(r + 7, MAJOR), chord(r, MINOR)]
          : [chord(r, MAJOR), chord(r + 5, MAJOR), chord(r + 7, MAJOR), chord(r, MAJOR)];
        const offset = 0.05 + rand() * 2;
        const song = renderTestSong({
          sampleRate: SR,
          bpm,
          pattern,
          chords,
          offset,
          seed: n + 3,
          parts: [{ bars: 16, kick: true, snare: true, hats: true, bass: true, pads: true }],
        });
        const a = analyzeTrack({ hash: `${n}`, mono: song.mono, sampleRate: SR, lufs: -10, truePeakDb: -1 });
        n++;
        const got = a.grid?.bpm ?? 0;
        const err = Math.abs(got - bpm);
        bpmErr.push(err);
        if (err <= 0.05) bpmOk++;
        if (Math.abs(got / bpm - 1) < 0.02) octaveOk++;
        const d = a.grid ? Math.abs(a.grid.firstDownbeat - song.downbeats[0]!) : Infinity;
        dbErr.push(d);
        if (a.grid) dbSigned.push(a.grid.firstDownbeat - song.downbeats[0]!);
        if (d < 0.02) downbeatOk++;
        const want = keyName({ root, mode: minor ? 'minor' : 'major' });
        if (a.key && keyName(a.key) === want) keyOk++;
        if (err > 0.05 || d >= 0.02 || !a.key || keyName(a.key) !== want)
          misses.push(`${name} ${bpm}: bpm ${got}, downbeat off ${d.toFixed(3)} s, key ${a.key ? keyName(a.key) : '-'} (want ${want})`);
      }
    const sorted = [...bpmErr].sort((x, y) => x - y);
    console.log(
      `accuracy over ${n} songs: BPM ±0.05 ${bpmOk}/${n} (octave ${octaveOk}/${n}, median error ${sorted[n >> 1]!.toFixed(3)}), ` +
        `first downbeat ±20 ms ${downbeatOk}/${n} (median ${(1000 * [...dbErr].sort((x, y) => x - y)[n >> 1]!).toFixed(1)} ms, mean signed ${(1000 * dbSigned.reduce((x, y) => x + y, 0) / Math.max(1, dbSigned.length)).toFixed(1)} ms), key exact ${keyOk}/${n}`,
    );
    if (misses.length) console.log(misses.join('\n'));
    expect(octaveOk).toBe(n);
    expect(bpmOk).toBeGreaterThanOrEqual(n - 1);
    expect(downbeatOk).toBeGreaterThanOrEqual(n - 2);
    expect(keyOk).toBeGreaterThanOrEqual(n - 1);
  }, 120_000);
});
