/**
 * Characterization of the harmony code: basslines in every style, voice-led chords and their comping,
 * chord detection from weights, notes and chroma, chord and roman-numeral parsing, progressions laid out
 * in every key, and what-comes-next suggestions, all exactly (a fingerprint of the whole result for the big
 * ones, the text itself for the small ones).
 *
 * It exists so the harmony code can be reorganised without changing what it writes or reads. If a
 * deliberate change makes it fail, review the cause and regenerate the snapshots with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import { mulberry32 } from '../voice/test-signals';
import { BASS_STYLES, makeBassline, type BassChord, type BassOptions } from './bassline';
import { formatChord, parseChord, parseChordLine, QUALITIES, transposeChord, type ChordSymbol } from './chord';
import {
  detectChordFromWeights,
  detectSpans,
  detectSpansFromChroma,
  type ChromaWindow,
  type HarmonyNote,
} from './detect';
import {
  GENRES,
  findProgressions,
  layoutProgression,
  parseRoman,
  PROGRESSIONS,
  progressionChords,
  suggestNext,
  withSeventh,
} from './progressions';
import { diatonicChords, romanOf, type KeyLike } from './scale';
import { COMP_RHYTHMS, compNotes, voiceChords, type Spread } from './voicing';

async function fingerprint(value: unknown): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
  return hash.slice(0, 12);
}

const BAR = 3840;
const BEAT = 960;

function chordList(seed: number, count: number): BassChord[] {
  const rand = mulberry32(seed);
  const qualities = QUALITIES.filter((q) => !q.noDetect);
  const out: BassChord[] = [];
  let tick = 0;
  for (let i = 0; i < count; i++) {
    const length = BAR * (rand() < 0.3 ? 2 : 1) * (rand() < 0.2 ? 0.5 : 1);
    const chord: ChordSymbol = {
      root: Math.floor(rand() * 12),
      quality: (qualities[Math.floor(rand() * qualities.length)] as { id: string }).id,
    };
    if (rand() < 0.15) chord.bass = Math.floor(rand() * 12);
    out.push({ tick, length, chord });
    tick += length;
  }
  return out;
}

const KEYS: KeyLike[] = [
  { root: 0, scale: 'major' },
  { root: 5, scale: 'minor' },
  { root: 9, scale: 'minor' },
  { root: 3, scale: 'major' },
  { root: 7, scale: 'dorian' },
];

describe('harmony characterization', () => {
  it('writes the same basslines', async () => {
    const lines: string[] = [];
    for (const style of BASS_STYLES) {
      for (let seed = 1; seed <= 6; seed++) {
        const chords = chordList(seed, 4 + (seed % 3));
        const opts: BassOptions = { style, bar: BAR, beat: BEAT, seed, key: KEYS[seed % KEYS.length] };
        const variants: [string, BassOptions][] = [
          ['plain', opts],
          ['low and quiet', { ...opts, low: 24, velocity: 0.6, key: null }],
          ['kicks', { ...opts, kicks: [0, 1440, 2400], cycle: BAR }],
          ['to bar 9', { ...opts, end: 9 * BAR }],
        ];
        for (const [label, o] of variants) {
          const notes = makeBassline(chords, o);
          lines.push(`${style} #${seed} ${label}: ${notes.length} notes ${await fingerprint(notes)}`);
        }
      }
    }
    lines.push(`none: ${makeBassline([], { style: 'roots', bar: BAR, beat: BEAT }).length}`);
    lines.push(
      `zero length: ${makeBassline([{ tick: 0, length: 0, chord: { root: 0, quality: 'maj' } }], { style: '808', bar: BAR, beat: BEAT }).length}`,
    );
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/harmony-bassline.txt');
  });

  it('voices and comps chords the same way', async () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const chords = chordList(seed, 3 + (seed % 5)).map((c) => c.chord);
      for (const spread of ['close', 'open', 'drop2'] as Spread[]) {
        for (const bass of [false, true]) {
          const voicings = voiceChords(chords, {
            spread,
            bass,
            center: 55 + seed * 2,
            inversion: seed % 3 === 0 ? seed % 3 : 'auto',
          });
          lines.push(`#${seed} ${spread} bass ${bass}: ${JSON.stringify(voicings)}`);
        }
      }
      const timing = chordList(seed, chords.length).map((c) => ({ tick: c.tick, length: c.length }));
      const voicings = voiceChords(chords);
      for (const rhythm of COMP_RHYTHMS) {
        const notes = compNotes(timing, voicings, { rhythm, beat: BEAT, gate: 0.9 });
        lines.push(`#${seed} comp ${rhythm}: ${notes.length} notes ${await fingerprint(notes)}`);
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/harmony-voicing.txt');
  });

  it('detects the same chords', async () => {
    const lines: string[] = [];
    const rand = mulberry32(42);
    for (let i = 0; i < 40; i++) {
      const weights = Array.from({ length: 12 }, () => (rand() < 0.55 ? rand() : 0));
      const bass = rand() < 0.5 ? Math.floor(rand() * 12) : null;
      const found = detectChordFromWeights(weights, bass, i % 4 === 0 ? { floor: 0.28 } : {});
      lines.push(`weights ${i}: ${found ? `${formatChord(found.chord)} ${found.confidence}` : 'none'}`);
    }
    for (let seed = 1; seed <= 8; seed++) {
      const chords = chordList(seed, 5);
      const notes: HarmonyNote[] = [];
      for (const c of chords) {
        const pcs = QUALITIES.find((q) => q.id === c.chord.quality)?.intervals ?? [0, 4, 7];
        pcs.forEach((interval, i) => {
          notes.push({
            tick: c.tick,
            length: c.length,
            key: 48 + ((c.chord.root + interval) % 12),
            velocity: 0.5 + (i % 3) * 0.2,
          });
        });
        notes.push({ tick: c.tick, length: c.length, key: 36 + (c.chord.bass ?? c.chord.root), velocity: 0.9 });
      }
      for (const resolution of ['bar', 'half'] as const) {
        const spans = detectSpans(notes, { bar: BAR, resolution, minConfidence: seed % 2 ? 0.3 : 0.6 });
        lines.push(
          `notes ${seed} ${resolution}: ${spans.map((s) => `${s.tick}+${s.length} ${formatChord(s.chord)} ${s.confidence}`).join(' | ')}`,
        );
      }
    }
    const windows: ChromaWindow[] = Array.from({ length: 12 }, (_, i) => ({
      tick: i * BAR,
      length: BAR,
      chroma: Array.from({ length: 12 }, () => rand()),
      bass: i % 3 === 0 ? undefined : Array.from({ length: 12 }, () => rand() * rand()),
    }));
    const fromChroma = detectSpansFromChroma(windows);
    lines.push(
      `chroma: ${fromChroma.map((s) => `${s.tick}+${s.length} ${formatChord(s.chord)} ${s.confidence}`).join(' | ')}`,
    );
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/harmony-detect.txt');
  });

  it('reads and writes chords and roman numerals the same way', () => {
    const lines: string[] = [];
    const chordTexts = [
      'C',
      'Am',
      'F#m7',
      'Bbmaj7',
      'G7/B',
      'Dsus4',
      'E5',
      'Cdim7',
      'Gadd9',
      'x',
      '',
      'H',
      'Am/C',
      'C#m7b5',
      'Ab',
      'Fm9',
    ];
    for (const text of chordTexts) {
      const c = parseChord(text);
      lines.push(
        `${JSON.stringify(text)} -> ${c ? `${formatChord(c)} ${JSON.stringify(c)} up 3: ${formatChord(transposeChord(c, 3))}` : 'null'}`,
      );
    }
    lines.push(JSON.stringify(parseChordLine('C Am | F G7 / nonsense Dm7')));
    const romans = [
      'I',
      'ii',
      'iii',
      'IV',
      'V',
      'vi',
      'vii°',
      'bVII',
      'bVI',
      'bIII',
      '#iv°',
      'V7',
      'ii7',
      'Imaj7',
      'i',
      'iv',
      'v',
      'III',
      'VI',
      'VII',
      'V/V',
      'Vsus4',
      'IV/I',
      'N6',
      'x',
      '',
    ];
    for (const key of KEYS) {
      for (const text of romans) {
        const c = parseRoman(text, key);
        lines.push(
          `${key.scale} ${key.root} ${JSON.stringify(text)} -> ${c ? `${formatChord(c)} ${JSON.stringify(c)} ${romanOf(key, c)}` : 'null'}`,
        );
      }
      lines.push(
        `${key.scale} ${key.root} diatonic: ${diatonicChords(key, true)
          .map((c) => formatChord(c))
          .join(' ')}`,
      );
    }
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });

  it('lays out progressions and suggests what follows the same way', async () => {
    const lines: string[] = [];
    for (const key of KEYS) {
      for (const prog of PROGRESSIONS) {
        const slots = progressionChords(prog, key);
        const built = layoutProgression(prog, key, {
          startTick: BAR,
          bar: BAR,
          bars: 6,
          sevenths: prog.id.length % 2 === 0,
        });
        lines.push(
          `${prog.id} in ${key.scale} ${key.root}: ${slots.map((s) => `${formatChord(s.chord)}x${s.bars}`).join(' ')} | ${built.map((b) => `${b.tick}+${b.length}`).join(' ')} ${await fingerprint(built)}`,
        );
      }
    }
    for (const mode of ['major', 'minor'] as const) {
      lines.push(
        `find ${mode}: ${findProgressions({ mode })
          .map((p) => p.id)
          .join(' ')}`,
      );
    }
    for (const genre of GENRES)
      lines.push(
        `find ${genre}: ${findProgressions({ genre })
          .map((p) => p.id)
          .join(' ')}`,
      );
    lines.push(
      `find text: ${findProgressions({ text: 'sad' })
        .map((p) => p.id)
        .join(' ')}`,
    );
    for (const key of KEYS) {
      const previous: (ChordSymbol | null)[] = [
        null,
        { root: key.root, quality: 'maj' },
        { root: key.root + 7, quality: '7' },
        { root: key.root + 9, quality: 'min' },
        { root: key.root + 1, quality: 'maj' },
        { root: key.root + 5, quality: 'maj7' },
      ];
      for (const prev of previous) {
        for (const sevenths of [false, true]) {
          const next = suggestNext(key, prev, { sevenths, before: previous[2] ?? null, limit: 10 });
          lines.push(
            `next ${key.scale} ${key.root} after ${prev ? formatChord(prev) : 'nothing'} 7ths ${sevenths}: ${next.map((n) => `${n.roman}:${n.score}:${n.reason}`).join(' | ')}`,
          );
        }
      }
      lines.push(
        `sevenths ${key.scale} ${key.root}: ${diatonicChords(key)
          .map((c) => formatChord(withSeventh(c, key)))
          .join(' ')}`,
      );
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/harmony-progressions.txt');
  });
});
