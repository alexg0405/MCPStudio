/**
 * A hand-made reference for tests and demos: a song with a known structure, tempo, key and tone, as the
 * numbers a project keeps (no audio involved).
 */
import { camelotOf } from '../dj/key';
import { ANALYSIS_VERSION } from '../dj/types';
import type { ReferenceSection, ReferenceTrack } from '../model/types';
import { TONE_BANDS } from './bands';

/** A section of a hand-made reference: its kind, length in bars, energy (0..1) and optionally its own tonal balance. */
export interface FakeReferenceSection {
  kind: ReferenceSection['kind'];
  bars: number;
  energy: number;
  /** Its tonal balance (default: the fixture's). */
  bands?: number[];
}

/**
 * What `fakeReference` takes to make a reference track: title, tempo, key, loudness, sections, tonal balance and so on;
 * everything left out has a default.
 */
export interface FakeReference {
  title?: string;
  bpm?: number | null;
  key?: { root: number; mode: 'major' | 'minor'; confidence?: number } | null;
  lufs?: number;
  truePeakDb?: number;
  sections?: FakeReferenceSection[];
  bands?: number[];
  width?: number;
  hash?: string;
}

/** A balanced, slightly bass-heavy tone (dB under the total, 8 bands). */
export const FAKE_BANDS = [-13, -4, -5, -8, -13, -17, -23, -33];

/** 16-bar intro, 32-bar drop, 16-bar break, 32-bar drop at 128 BPM, −8 LUFS: the shape the browser test uses. */
export const DROP_SONG: FakeReferenceSection[] = [
  { kind: 'intro', bars: 16, energy: 0.3 },
  { kind: 'drop', bars: 32, energy: 1 },
  { kind: 'break', bars: 16, energy: 0.35 },
  { kind: 'drop', bars: 32, energy: 1 },
];

/** A reference track built from numbers alone, for tests and demos (128 BPM and a drop song unless told otherwise). */
export function fakeReference(f: FakeReference = {}): ReferenceTrack {
  const bpm = f.bpm === undefined ? 128 : f.bpm;
  const barSec = bpm ? 240 / bpm : 2;
  const parts = f.sections ?? DROP_SONG;
  let at = 0;
  const sections: ReferenceSection[] = parts.map((p) => {
    const startSec = at;
    at += p.bars * barSec;
    return {
      kind: p.kind,
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round(at * 100) / 100,
      bars: p.bars,
      energy: p.energy,
      bands: p.bands ?? f.bands ?? FAKE_BANDS,
      width: f.width ?? 0.4,
    };
  });
  const key = f.key === undefined ? { root: 9, mode: 'minor' as const } : f.key;
  return {
    title: f.title ?? 'My reference',
    hash: f.hash ?? 'ab'.repeat(32),
    durationSec: Math.round(at * 100) / 100,
    bpm,
    beatsPerBar: 4,
    key: key ? { root: key.root, mode: key.mode, camelot: camelotOf(key.root, key.mode), confidence: key.confidence ?? 0.8 } : null,
    lufs: f.lufs ?? -8,
    truePeakDb: f.truePeakDb ?? -0.9,
    bands: f.bands ?? FAKE_BANDS,
    width: f.width ?? 0.4,
    energy: parts.flatMap((p) => Array.from({ length: p.bars }, () => p.energy)),
    sections,
    version: ANALYSIS_VERSION,
  };
}

/** The bands as `ToneBand` ids with their values, for readable assertions. */
export const bandsById = (bands: readonly number[]): Record<string, number> => Object.fromEntries(TONE_BANDS.map((b, i) => [b.id, bands[i]!]));
