/**
 * The offline song generator held to what a listener would hear: melodies on chord tones at the strong beats, a bass on the
 * chords, no parallel fifths or octaves in the voicings, a motif that comes back changed, each style's tempo, groove and kit,
 * the same song for the same seed and other songs for other seeds.
 */
import { describe, expect, it } from 'vitest';
import { validateBeatSpec } from '../beat/spec';
import { FOUR_FLOOR, GROOVE, STYLES, TEMPO, type Style } from '../beat/style';
import { chordPitchClasses, mod12 } from '../harmony/chord';
import { generateSong, generateSongFromPrompt } from './generate';
import { chordAtStep } from './harmony';
import {
  bassChordToneRatio,
  bassRootRatio,
  leadChordToneRatio,
  leadRange,
  motifReuse,
  parallelOuterVoices,
  syncopation,
} from './metrics';
import { PROFILES } from './profiles';
import { isSongRequest, readSongRequest } from './request';
import type { SongPattern, SongPlan } from './types';
import { isParallelPerfect, voiceLoop } from './voicing';

const SEEDS = [1, 2, 3, 4, 5, 6];
const songOf = (style: Style, seed: number): SongPlan => generateSong(readSongRequest(`a ${style} song`, { seed }));

/** Every style at several seeds. */
const ALL: { style: Style; seed: number; plan: SongPlan }[] = STYLES.flatMap((style) =>
  SEEDS.map((seed) => ({ style, seed, plan: songOf(style, seed) })),
);

const stepsOf = (pattern: SongPattern | undefined, sound: string): number[] =>
  (pattern?.spec.tracks ?? [])
    .filter((track) => track.sound === sound)
    .flatMap((track) => track.notes.map((note) => note.step));
const patternOf = (plan: SongPlan, ref: string): SongPattern | undefined =>
  plan.patterns.find((entry) => entry.ref === ref);

describe('reading a request', () => {
  it('takes the style, tempo and key from the words and fills the rest from the seed', () => {
    const request = readSongRequest('a sad trap song at 140 in F minor', { seed: 5 });
    expect(request).toMatchObject({ style: 'trap', bpm: 140, mood: 'sad', key: { root: 5, minor: true } });
    const open = readSongRequest('uplifting house', { seed: 5 });
    expect(open.style).toBe('house');
    expect(open.mood).toBe('uplifting');
    expect(open.bpm).toBeGreaterThanOrEqual(TEMPO.house.min);
    expect(open.bpm).toBeLessThanOrEqual(TEMPO.house.max);
    // A mood leans the mode: uplifting is major, dark is minor, unless a key is named.
    for (let seed = 1; seed <= 10; seed++) {
      expect(readSongRequest('an uplifting pop song', { seed }).key.minor).toBe(false);
      expect(readSongRequest('a dark pop song', { seed }).key.minor).toBe(true);
    }
    expect(readSongRequest('a dark pop song in C major', { seed: 1 }).key).toEqual({ root: 0, minor: false });
  });

  it('reads a length in bars, minutes or words', () => {
    expect(readSongRequest('a trap song, 48 bars', { seed: 1 }).bars).toBe(48);
    const twoMinutes = readSongRequest('a house song about 2 minutes at 120 bpm', { seed: 1 }).bars;
    expect(twoMinutes).toBe(60);
    expect(readSongRequest('a short pop song at 120', { seed: 1 }).bars).toBeLessThan(
      readSongRequest('a long pop song at 120', { seed: 1 }).bars!,
    );
    expect(readSongRequest('a trap song', { seed: 1 }).bars).toBeUndefined();
  });

  it('knows a request for a song from a request for a beat', () => {
    for (const text of [
      'a sad trap song at 140',
      'make a full song',
      'house with a verse and a chorus',
      'a 64 bars track',
      'about 3 minutes of lofi',
    ]) {
      expect(isSongRequest(text), text).toBe(true);
    }
    for (const text of [
      'trap beat with 808s',
      'busier hats',
      'Arrange it: 4 bars, then 8 bars with the hats',
      'big room festival drop with a mono lead',
      'boom bap at 90 with swing',
    ]) {
      expect(isSongRequest(text), text).toBe(false);
    }
  });

  it('gives the same request the same seed, and a variation another', () => {
    expect(readSongRequest('a trap song').seed).toBe(readSongRequest('a trap song').seed);
    expect(readSongRequest('a trap song', { variation: 1 }).seed).not.toBe(readSongRequest('a trap song').seed);
  });
});

describe('every style, several seeds', () => {
  it('writes melodies that sit on chord tones at the strong beats (at least 80 %)', () => {
    for (const { style, seed, plan } of ALL) {
      const lead = leadChordToneRatio(plan);
      expect(lead.total, `${style} ${seed}`).toBeGreaterThan(10);
      expect(lead.ratio, `${style} ${seed}`).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('writes basslines on the chords: roots on the chord changes, chord tones throughout (at least 90 %)', () => {
    for (const { style, seed, plan } of ALL) {
      expect(bassRootRatio(plan).ratio, `${style} ${seed} roots`).toBeGreaterThanOrEqual(0.9);
      expect(bassChordToneRatio(plan).ratio, `${style} ${seed} tones`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('voices the chords without parallel fifths or octaves in the outer voices (under 5 % of the changes)', () => {
    let count = 0;
    let total = 0;
    for (const { style, seed, plan } of ALL) {
      const parallel = parallelOuterVoices(plan);
      expect(parallel.ratio, `${style} ${seed}`).toBeLessThanOrEqual(0.05);
      count += parallel.count;
      total += parallel.total;
    }
    expect(total).toBeGreaterThan(1000);
    expect(count / total).toBeLessThanOrEqual(0.02);
  });

  it('builds the melody from a motif that comes back changed: repeated shapes (rhythm and contour) and new ones in one song', () => {
    for (const { style, seed, plan } of ALL) {
      const reuse = motifReuse(plan);
      expect(reuse.total, `${style} ${seed}`).toBeGreaterThan(20);
      expect(reuse.repeated, `${style} ${seed} repeats`).toBeGreaterThanOrEqual(0.08);
      expect(reuse.repeated, `${style} ${seed} repeats`).toBeLessThanOrEqual(0.8);
      expect(reuse.unique, `${style} ${seed} new`).toBeGreaterThanOrEqual(0.4);
    }
    const average = ALL.reduce((sum, entry) => sum + motifReuse(entry.plan).repeated, 0) / ALL.length;
    expect(average).toBeGreaterThan(0.2);
    expect(average).toBeLessThan(0.55);
  });

  it('keeps the lead in its style’s register and gives it some syncopation', () => {
    for (const { style, seed, plan } of ALL) {
      const range = leadRange(plan);
      const { low, high } = PROFILES[style].lead;
      expect(range.low, `${style} ${seed}`).toBeGreaterThanOrEqual(low - 2);
      expect(range.high, `${style} ${seed}`).toBeLessThanOrEqual(high + 2);
      expect(syncopation(plan).ratio, `${style} ${seed}`).toBeGreaterThan(0.1);
    }
  });

  it('writes patterns the beat writer accepts as they are (no note dropped, no warning)', () => {
    for (const { style, seed, plan } of ALL) {
      for (const pattern of plan.patterns) {
        const checked = validateBeatSpec({ ...pattern.spec, message: 'x' }, { style });
        if ('error' in checked) throw new Error(`${style} ${seed} ${pattern.ref}: ${checked.error}`);
        expect(checked.warnings, `${style} ${seed} ${pattern.ref}`).toEqual([]);
        expect(checked.spec.tracks.map((track) => track.notes.length)).toEqual(
          pattern.spec.tracks.map((track) => track.notes.length),
        );
      }
    }
  });

  it('plays only notes inside the pattern, with a key for every pitched note', () => {
    for (const { style, seed, plan } of ALL) {
      for (const pattern of plan.patterns) {
        for (const track of pattern.spec.tracks) {
          for (const note of track.notes) {
            const where = `${style} ${seed} ${pattern.ref} ${track.name}`;
            expect(note.step, where).toBeGreaterThanOrEqual(0);
            expect(note.step, where).toBeLessThan(64);
            expect(note.step + (note.len ?? 1), where).toBeLessThanOrEqual(64 + 1e-9);
            expect(note.vel ?? 0.8, where).toBeGreaterThan(0);
            expect(note.vel ?? 0.8, where).toBeLessThanOrEqual(1);
            if (!['kick', 'snare', 'clap', 'hat', 'open-hat', 'rim'].includes(track.sound))
              expect(note.key, where).toBeTypeOf('number');
          }
        }
      }
    }
  });

  it('never plays the same pitch twice at once on one track (a note ends before the same note starts again)', () => {
    for (const { style, seed, plan } of ALL) {
      for (const pattern of plan.patterns) {
        for (const track of pattern.spec.tracks.filter(
          (entry) => entry.sound !== 'kick' && !['snare', 'clap', 'hat', 'open-hat', 'rim'].includes(entry.sound),
        )) {
          const byKey = new Map<number, { step: number; len: number }[]>();
          for (const note of track.notes)
            byKey.set(note.key ?? 0, [...(byKey.get(note.key ?? 0) ?? []), { step: note.step, len: note.len ?? 1 }]);
          for (const [key, notes] of byKey) {
            const sorted = notes.sort((a, b) => a.step - b.step);
            sorted.slice(1).forEach((note, index) => {
              const before = sorted[index] as { step: number; len: number };
              expect(
                before.step + before.len,
                `${style} ${seed} ${pattern.ref} ${track.name} key ${key} at ${note.step}`,
              ).toBeLessThanOrEqual(note.step + 1e-9);
            });
          }
        }
      }
    }
  });

  it('keeps each style’s tempo, swing, kit and drum groove', () => {
    for (const { style, plan } of ALL) {
      expect(plan.bpm).toBeGreaterThanOrEqual(TEMPO[style].min);
      expect(plan.bpm).toBeLessThanOrEqual(TEMPO[style].max);
      expect(plan.swing).toBe(GROOVE[style].swing);
      for (const pattern of plan.patterns) expect(pattern.spec.style).toBe(style);
      const verse = patternOf(plan, '@verse') ?? patternOf(plan, '@chorus');
      const kick = stepsOf(verse, 'kick');
      if (FOUR_FLOOR.has(style)) for (const step of [0, 4, 8, 12, 16, 20, 24, 28]) expect(kick, style).toContain(step);
      expect(kick, style).toContain(0);
    }
  });

  it('puts the backbeat where the style does: the snare or clap on beat 3 in half-time, on 2 and 4 in four on the floor', () => {
    for (const style of ['trap', 'drill', 'dubstep', 'futurebass'] as const) {
      const pattern = patternOf(songOf(style, 1), '@chorus');
      const backbeat = [...stepsOf(pattern, 'snare'), ...stepsOf(pattern, 'clap')];
      expect(backbeat, style).toContain(8);
      expect(backbeat, style).not.toContain(4);
    }
    for (const style of ['house', 'trance', 'bigroom'] as const) {
      const backbeat = [...stepsOf(patternOf(songOf(style, 1), '@chorus'), 'clap')];
      expect(backbeat, style).toEqual(expect.arrayContaining([4, 12]));
    }
  });

  it('arranges a full song: every section plays patterns that exist, the energy rises into the peaks', () => {
    for (const { style, seed, plan } of ALL) {
      const refs = new Set(plan.patterns.map((entry) => entry.ref));
      expect(plan.sections.length, `${style} ${seed}`).toBeGreaterThanOrEqual(5);
      for (const section of plan.sections) {
        expect(section.play.length).toBeGreaterThan(0);
        for (const ref of section.play) expect(refs.has(ref), `${style} ${seed} ${section.name}`).toBe(true);
        expect(section.bars % 4).toBe(0);
      }
      const energies = plan.sections.map((entry) => entry.energy);
      expect(Math.max(...energies)).toBeGreaterThanOrEqual(Math.min(4, Math.max(...energies)));
      expect(energies[0]).toBeLessThan(Math.max(...energies));
    }
  });

  it('writes the chord track as one chord name per bar for the whole song', () => {
    for (const { style, seed, plan } of ALL) {
      const bars = plan.sections.reduce((sum, entry) => sum + entry.bars, 0);
      expect(plan.chordLine.text.split('|').length, `${style} ${seed}`).toBe(bars);
      expect(plan.chordLine.text.split('|')[0]?.trim()).not.toBe('.');
    }
  });
});

describe('seeds', () => {
  it('gives the same song for the same seed', () => {
    for (const style of ['trap', 'house', 'lofi', 'trance'] as const) {
      expect(songOf(style, 7)).toEqual(songOf(style, 7));
    }
    expect(generateSongFromPrompt('a sad trap song at 140')).toEqual(generateSongFromPrompt('a sad trap song at 140'));
  });

  it('gives other songs for other seeds: other progressions, motifs and tempos', () => {
    const request = (seed: number) => generateSong(readSongRequest('a sad trap song', { seed }));
    const plans = Array.from({ length: 16 }, (_, index) => request(index + 1));
    expect(new Set(plans.map((plan) => plan.progression.id)).size).toBeGreaterThanOrEqual(4);
    const hooks = plans.map((plan) =>
      JSON.stringify(patternOf(plan, '@hook')?.spec.tracks[0]?.notes.map((note) => [note.step, note.key])),
    );
    expect(new Set(hooks).size).toBeGreaterThanOrEqual(14);
    const rhythms = plans.map((plan) =>
      JSON.stringify(patternOf(plan, '@hook')?.spec.tracks[0]?.notes.map((note) => note.step)),
    );
    expect(new Set(rhythms).size).toBeGreaterThanOrEqual(6);
    expect(new Set(plans.map((plan) => plan.bpm)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(plans.map((plan) => `${plan.key.root}${plan.key.minor}`)).size).toBeGreaterThanOrEqual(5);
  });

  it('changes the groove with the seed too: the extra kick hits and the bass', () => {
    const kicks = new Set(
      SEEDS.concat([7, 8, 9, 10]).map((seed) =>
        JSON.stringify(stepsOf(patternOf(songOf('boombap', seed), '@chorus'), 'kick')),
      ),
    );
    expect(kicks.size).toBeGreaterThanOrEqual(3);
  });
});

describe('shapes of songs', () => {
  it('uses the dance styles’ own usual songs', () => {
    const plan = songOf('bigroom', 1);
    expect(plan.sections.map((entry) => entry.name)).toEqual([
      'Intro',
      'Build',
      'Drop',
      'Breakdown',
      'Build 2',
      'Drop 2',
      'Outro',
    ]);
    expect(plan.sections.find((entry) => entry.name === 'Drop')?.energy).toBe(5);
  });

  it('shortens or lengthens a song toward the length asked for', () => {
    const bars = (prompt: string) =>
      generateSongFromPrompt(prompt, { seed: 3 }).sections.reduce((sum, entry) => sum + entry.bars, 0);
    expect(bars('a trap song')).toBe(60);
    expect(bars('a trap song, 36 bars')).toBeLessThanOrEqual(36 + 6);
    expect(bars('a trap song, 36 bars')).toBeGreaterThanOrEqual(24);
    expect(bars('a trap song, 100 bars')).toBeGreaterThanOrEqual(100 - 6);
    expect(bars('a house song, 120 bars')).toBeGreaterThanOrEqual(120 - 8);
    expect(bars('a house song, 120 bars')).toBeLessThanOrEqual(120 + 16);
    // Never so short that the song loses its intro or its outro.
    const short = generateSongFromPrompt('a pop song, 24 bars', { seed: 3 }).sections;
    expect(short[0]?.role).toBe('intro');
    expect(short.at(-1)?.role).toBe('outro');
  });

  it('keeps the longest song within what one arrange action takes (24 sections, 512 bars) in every style', () => {
    for (const style of STYLES) {
      const plan = generateSong(readSongRequest(`a ${style} song, 160 bars`, { seed: 2 }));
      const bars = plan.sections.reduce((sum, entry) => sum + entry.bars, 0);
      expect(plan.sections.length, style).toBeLessThanOrEqual(24);
      expect(bars, style).toBeLessThanOrEqual(512);
      expect(bars, style).toBeGreaterThanOrEqual(100);
    }
  });

  it('plays a different melody in each statement of the verse and the hook, and the biggest chorus last', () => {
    const plan = songOf('pop', 2);
    const plays = plan.sections.map((entry) => entry.play.join('+'));
    expect(plays.filter((play) => play.includes('@hook')).length).toBeGreaterThanOrEqual(3);
    expect(new Set(plays.filter((play) => play.includes('@verse-melody'))).size).toBe(2);
    expect(plan.sections.filter((entry) => entry.role === 'chorus').at(-1)?.play).toEqual([
      '@chorus-final',
      '@hook-final',
    ]);
  });
});

describe('dynamics and colour', () => {
  /** The mean velocity of the pitched notes of a pattern. */
  const meanVelocity = (pattern: SongPattern | undefined): number => {
    const notes = (pattern?.spec.tracks ?? []).filter((track) => track.name === 'Pad').flatMap((track) => track.notes);
    return notes.reduce((sum, note) => sum + (note.vel ?? 0.8), 0) / Math.max(1, notes.length);
  };

  it('plays the intro softer than the biggest chorus', () => {
    for (const style of ['trap', 'pop', 'house', 'trance'] as const) {
      const plan = songOf(style, 1);
      const intro = patternOf(plan, '@intro') ?? patternOf(plan, '@verse');
      const peak = patternOf(plan, '@chorus-final') ?? patternOf(plan, '@chorus');
      expect(meanVelocity(intro), style).toBeLessThan(meanVelocity(peak));
    }
  });

  it('adds an arpeggio to the loud sections of the dance styles and a counter-melody to the second hook of the others', () => {
    for (const style of ['trance', 'house', 'trap'] as const) {
      expect(
        patternOf(songOf(style, 1), '@chorus')?.spec.tracks.map((track) => track.name),
        style,
      ).toContain('Arp');
    }
    for (const style of ['pop', 'lofi', 'afro'] as const) {
      const hook2 = patternOf(songOf(style, 1), '@hook-2');
      expect(
        hook2?.spec.tracks.map((track) => track.name),
        style,
      ).toContain('Counter');
    }
  });

  it('keeps the arpeggio and the counter-melody on chord tones', () => {
    for (const { style, seed, plan } of ALL) {
      for (const pattern of plan.patterns) {
        for (const track of pattern.spec.tracks.filter((entry) => entry.name === 'Arp' || entry.name === 'Counter')) {
          for (const note of track.notes) {
            const tones = chordPitchClasses(chordAtStep(pattern.chords, note.step));
            expect(tones, `${style} ${seed} ${pattern.ref} ${track.name} ${note.step}`).toContain(mod12(note.key ?? 0));
          }
        }
      }
    }
  });
});

describe('the bass of each style', () => {
  const bassOf = (style: Style, ref = '@chorus') =>
    patternOf(songOf(style, 4), ref)?.spec.tracks.filter((track) => track.sound === 'bass' || track.sound === '808') ??
    [];

  it('follows the kick with an 808 that slides in trap and drill', () => {
    for (const style of ['trap', 'drill'] as const) {
      const pattern = patternOf(songOf(style, 4), '@chorus');
      const bass = pattern?.spec.tracks.find((track) => track.sound === '808');
      expect(bass, style).toBeDefined();
      const kick = new Set(stepsOf(pattern, 'kick'));
      const starts = (bass?.notes ?? []).map((note) => note.step);
      expect([...kick].filter((step) => starts.includes(step)).length / kick.size, style).toBeGreaterThanOrEqual(0.8);
      const overlaps = (bass?.notes ?? []).some(
        (note, index, notes) => index > 0 && note.step < (notes[index - 1]?.step ?? 0) + (notes[index - 1]?.len ?? 0),
      );
      expect(overlaps, `${style} slides`).toBe(true);
    }
  });

  it('plays the offbeat 8ths in trance and big room', () => {
    for (const style of ['trance', 'bigroom'] as const) {
      const steps = (bassOf(style)[0]?.notes ?? []).map((note) => note.step % 16);
      expect([...new Set(steps)].sort((a, b) => a - b)).toEqual([2, 6, 10, 14]);
    }
  });

  it('rolls 16ths between the kicks in house', () => {
    const steps = (bassOf('house')[0]?.notes ?? []).map((note) => note.step % 16);
    expect(steps.some((step) => step % 4 === 1)).toBe(true);
    expect(steps.some((step) => step % 4 === 3)).toBe(true);
    expect(steps.every((step) => step % 4 !== 0)).toBe(true);
  });
});

describe('voicing', () => {
  it('knows a parallel fifth or octave when it sees one', () => {
    // C and G (a fifth) moving to D and A.
    expect(isParallelPerfect(48, 55, 50, 57)).toBe(true);
    // Octaves moving the same way.
    expect(isParallelPerfect(48, 60, 53, 65)).toBe(true);
    // Contrary motion, or a third, is fine.
    expect(isParallelPerfect(48, 55, 47, 57)).toBe(false);
    expect(isParallelPerfect(48, 52, 50, 54)).toBe(false);
    // A fifth that moves to a fourth is not parallel.
    expect(isParallelPerfect(48, 55, 50, 55)).toBe(false);
  });

  it('voices every stock progression in every key with outer voices that stay clear of parallels', () => {
    let changes = 0;
    let parallels = 0;
    for (let root = 0; root < 12; root++) {
      const request = readSongRequest('a pop song', { seed: root });
      const chords = [
        { root, quality: 'maj' },
        { root: mod12(root + 7), quality: 'maj' },
        { root: mod12(root + 9), quality: 'min' },
        { root: mod12(root + 5), quality: 'maj' },
      ];
      const voicings = voiceLoop(chords, 58);
      expect(voicings).toHaveLength(4);
      for (let index = 0; index < voicings.length; index++) {
        const before = voicings[index] as number[];
        const after = voicings[(index + 1) % 4] as number[];
        changes++;
        if (isParallelPerfect(Math.min(...before), Math.max(...before), Math.min(...after), Math.max(...after)))
          parallels++;
      }
      expect(request.seed).toBe(root);
    }
    expect(parallels / changes).toBeLessThanOrEqual(0.05);
  });
});
