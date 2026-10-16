/** Shared by the track-analysis tests (analyze.test.ts, analyze-sections.test.ts, analyze-hard.test.ts). */
import { analyzeTrack } from './analyze';
import { MAJOR, MINOR, chord, renderTestSong, type SongPart, type TestSongSpec } from './test-songs';

export const SR = 22050;
export const all: Omit<SongPart, 'bars'> = { kick: true, snare: true, hats: true, bass: true, pads: true };
export const beat: Omit<SongPart, 'bars'> = { kick: true, hats: true, level: 0.7 };
/** Am – Dm – E – Am (A minor, one chord per bar). */
export const AM = [chord(57, MINOR), chord(50, MINOR), chord(52, MAJOR), chord(57, MINOR)];

export function analyze(spec: Partial<TestSongSpec> & Pick<TestSongSpec, 'bpm' | 'pattern' | 'parts'>) {
  const song = renderTestSong({ sampleRate: SR, chords: AM, ...spec });
  const a = analyzeTrack({ hash: 'test', mono: song.mono, sampleRate: SR, lufs: -10, truePeakDb: -1 });
  return { song, a };
}

/** Distance (seconds) from the analysis' first downbeat to the true downbeat nearest it, and the bar index. */
export function downbeatError(downbeats: number[], t: number): { error: number; bar: number } {
  let bar = 0;
  for (let i = 1; i < downbeats.length; i++) if (Math.abs(downbeats[i]! - t) < Math.abs(downbeats[bar]! - t)) bar = i;
  return { error: Math.abs(downbeats[bar]! - t), bar };
}
