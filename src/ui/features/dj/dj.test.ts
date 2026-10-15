import { afterEach, describe, expect, it } from 'vitest';
import { findSongs, library, moveSong, songsToMix, togglePin, type LibrarySong } from '@app/dj/library';
import { DEFAULT_DJ_OPTIONS } from '@app/dj/mix';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import { bpmText, formatLength, keyBadge, sparkPoints, statusText } from './dj-view';
import { mixOptionsFrom } from './register';

const song = (key: string, label: string): LibrarySong => ({
  key,
  ref: { id: `smp_${key}` as never, name: label, source: { kind: 'embedded', hash: key, ext: 'mp3' } },
  title: label.split(' – ').pop()!,
  label,
  fileName: `${label}.mp3`,
  addedAt: 0,
});

afterEach(() => library.setState({ songs: [], selected: [] }));

describe('DJ window helpers', () => {
  it('formats lengths, BPM, keys and status', () => {
    expect(formatLength(187.4)).toBe('3:07');
    expect(formatLength(3725)).toBe('1:02:05');
    expect(formatLength(undefined)).toBe('–');
    const a = fakeAnalysis({ bpm: 125.5, key: { root: 9, mode: 'minor' } });
    expect(bpmText(a)).toBe('125.5');
    expect(bpmText(null)).toBe('–');
    expect(keyBadge(a)).toMatchObject({ text: '8A' });
    expect(keyBadge(a).hint).toMatch(/A minor/);
    expect(keyBadge(null).color).toBeNull();
    expect(statusText(null, { state: 'running', fraction: 0.4 }, false)).toBe('Analyzing 40 %');
    expect(statusText(null, undefined, true)).toBe('Not analyzed');
    expect(statusText(a, undefined, false)).toBe('');
  });

  it('draws an energy sparkline inside its box', () => {
    const pts = sparkPoints(Array.from({ length: 200 }, (_, i) => i / 199), 64, 16).split(' ');
    expect(pts.length).toBe(48);
    for (const p of pts) {
      const [x, y] = p.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(64);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(16);
    }
    expect(Number(pts[0]!.split(',')[1])).toBeGreaterThan(Number(pts.at(-1)!.split(',')[1]));
  });

  it('reads make-mix options from args over the current ones', () => {
    expect(mixOptionsFrom({ energy: 'chill', mixTempo: 300, lengthMin: 45, order: 'bogus' }, DEFAULT_DJ_OPTIONS)).toEqual({
      ...DEFAULT_DJ_OPTIONS,
      energy: 'chill',
      mixTempo: 250,
      lengthTargetMin: 45,
    });
    expect(mixOptionsFrom(undefined, DEFAULT_DJ_OPTIONS)).toEqual(DEFAULT_DJ_OPTIONS);
  });
});

describe('music library', () => {
  it('mixes the selection, else everything, in list order', async () => {
    library.setState({ songs: [song('a', 'A – One'), song('b', 'B – Two'), song('c', 'C – Three')], selected: [] });
    expect(songsToMix(library.getState()).map((x) => x.key)).toEqual(['a', 'b', 'c']);
    library.setState({ selected: ['c', 'a'] });
    expect(songsToMix(library.getState()).map((x) => x.key)).toEqual(['a', 'c']);
    await moveSong('c', 0);
    expect(library.getState().songs.map((x) => x.key)).toEqual(['c', 'a', 'b']);
    await togglePin('a');
    expect(library.getState().songs[1]!.pinned).toBe(true);
  });

  it('finds songs by name for the Studio', () => {
    library.setState({ songs: [song('a', 'Daft Punk – One More Time'), song('b', 'Robyn – Dancing On My Own')] });
    expect(findSongs(['one more time', 'robyn', 'nope'])).toEqual({ found: [library.getState().songs[0], library.getState().songs[1]], missing: ['nope'] });
  });
});
