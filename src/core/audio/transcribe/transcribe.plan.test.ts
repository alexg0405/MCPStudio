/**
 * Planning notes from what was heard: the clip's trim and tempo follow, the grid and swing, the way notes end, the drum
 * keys and pads, the mode suggestion, determinism. The listening here is real (synthetic recordings from
 * `test/helpers/transcribe-signals.ts`); the clip and settings are plain data.
 */
import { describe, expect, it } from 'vitest';
import { swingTick } from '../../time/swing';
import {
  BEATS,
  bassLine,
  chordPads,
  drumLoop,
  progression,
  sungMelody,
  timelineOf,
  TRANSCRIBE_RATE,
} from '../../../../test/helpers/transcribe-signals';
import { sing } from '../../../../test/helpers/sung';
import { listen } from './listen';
import { planTranscription, TranscribePlanError } from './plan';
import { GM_KEY } from './plan-drums';
import { suggestMode } from './suggest';
import { settingsFor, type Heard, type HeardNote } from './types';

const SR = TRANSCRIBE_RATE;
/** Seconds per tick at a tempo. */
const secPerTick = (bpm: number) => 60 / (960 * bpm);

/** Notes exactly where they are said, so the planner is tested without the listening's small errors. */
function said(...notes: [fromSec: number, toSec: number, pitch: number, level?: number][]): Heard {
  return { kind: 'notes', mode: 'melody', notes: notes.map(([fromSec, toSec, pitch, level = 0.8]): HeardNote => ({ fromSec, toSec, pitch, level })) };
}

const noQuantize = { gridTicks: 0, strength: 1, swing: 'straighten' as const };

describe('the clip decides where notes land', () => {
  it('leaves out what the trim cuts off and puts the rest at its own time: the clip starts 1.5 s into the sound', () => {
    const heard = said([0.5, 0.9, 60], [1.2, 1.4, 62], [1.6, 2.0, 64], [3.0, 3.5, 65]);
    const plan = planTranscription(heard, timelineOf({ bpm: 120, offsetSec: 1.5, length: 960 * 2 }), settingsFor('melody', { quantize: noQuantize }));
    // 120 BPM: a second is 1920 ticks. The clip is 2 beats (1 s) long: 1.6 s → 0.1 s into it, and 3.0 s is past its end.
    expect(plan.notes.map((n) => n.key)).toEqual([64]);
    expect(plan.notes[0]?.tick).toBeCloseTo(0.1 / secPerTick(120), -1);
  });

  it('cuts a note at the end of the clip and keeps one that was already sounding when the trim starts', () => {
    const heard = said([0.9, 1.9, 60], [1.95, 3.2, 62]);
    const plan = planTranscription(heard, timelineOf({ bpm: 120, offsetSec: 1.5, length: 1920 }), settingsFor('melody', { quantize: noQuantize }));
    // The first note sounds from 0.9 to 1.9 s: 0.4 s of it is inside the clip (from its start).
    expect(plan.notes[0]).toMatchObject({ key: 60, tick: 0 });
    expect(plan.notes[0]?.length).toBeCloseTo(0.4 / secPerTick(120), -1);
    // The second starts 0.45 s in and is cut where the clip ends (1 s in).
    const second = plan.notes[1];
    expect((second?.tick ?? 0) + (second?.length ?? 0)).toBeLessThanOrEqual(1920);
  });

  it('follows the tempo: with tempo follow on the notes land by the sound\'s own beats, without it by seconds', () => {
    const heard = said([1, 1.5, 60]);
    const settings = settingsFor('melody', { quantize: noQuantize });
    const off = planTranscription(heard, timelineOf({ bpm: 90 }), settings);
    expect(off.notes[0]?.tick).toBeCloseTo(1 / secPerTick(90), -1);
    // Recorded at 120 BPM and following the song (90 BPM) by time-stretching: 1 s of the sound is 2 beats = 1920 ticks of the song.
    const stretch = planTranscription(heard, timelineOf({ bpm: 90, follow: { sourceBpm: 120, stretch: 'stretch' } }), settings);
    expect(stretch.notes[0]?.tick).toBeCloseTo(1 / secPerTick(120), -1);
    expect(stretch.notes[0]?.key).toBe(60);
  });

  it('writes the pitch the song hears: the channel\'s pitch and a resampling follow move the keys', () => {
    const heard = said([0.5, 1.0, 60]);
    const settings = settingsFor('melody', { quantize: noQuantize });
    // At half the source tempo a resampling clip plays an octave down.
    const down = planTranscription(heard, timelineOf({ bpm: 60, follow: { sourceBpm: 120, stretch: 'resample' } }), settings);
    expect(down.notes[0]?.key).toBe(48);
  });
});

describe('quantizing', () => {
  const heard = said([0.52, 0.8, 60], [0.99, 1.2, 62], [1.55, 1.9, 64]);

  it('puts every start and end on the grid at full strength, and halfway at half strength', () => {
    const full = planTranscription(heard, timelineOf({ bpm: 120 }), settingsFor('melody', { quantize: { gridTicks: 240, strength: 1, swing: 'straighten' } }));
    for (const n of full.notes) {
      expect(n.tick % 240).toBe(0);
      expect((n.tick + n.length) % 240).toBe(0);
    }
    const raw = planTranscription(heard, timelineOf({ bpm: 120 }), settingsFor('melody', { quantize: noQuantize }));
    const half = planTranscription(heard, timelineOf({ bpm: 120 }), settingsFor('melody', { quantize: { gridTicks: 240, strength: 0.5, swing: 'straighten' } }));
    half.notes.forEach((n, i) => {
      const a = raw.notes[i]?.tick ?? 0;
      const b = full.notes[i]?.tick ?? 0;
      expect(n.tick).toBeCloseTo((a + b) / 2, -1);
    });
  });

  it('snaps to the song\'s grid when the clip starts between its lines', () => {
    const plan = planTranscription(heard, timelineOf({ bpm: 120, start: 100 }), settingsFor('melody', { quantize: { gridTicks: 240, strength: 1, swing: 'straighten' } }));
    for (const n of plan.notes) expect((100 + n.tick) % 240).toBe(0);
  });

  it('keeps the cents as the note\'s fine pitch when asked, and rounds to whole semitones otherwise', () => {
    const slightly = said([0, 0.5, 60.3]);
    const timeline = timelineOf({ bpm: 120 });
    expect(planTranscription(slightly, timeline, settingsFor('melody', { quantize: noQuantize })).notes[0]).not.toHaveProperty('fine');
    const kept = planTranscription(slightly, timeline, settingsFor('melody', { quantize: noQuantize, keepCents: true }));
    expect(kept.notes[0]).toMatchObject({ key: 60, fine: 30 });
  });
});

describe('articulation', () => {
  const heard = said([0, 0.3, 60], [0.4, 0.7, 62], [1.5, 1.8, 64]);
  const timeline = timelineOf({ bpm: 120 });

  it('legato closes gaps shorter than the threshold and leaves longer ones', () => {
    const plan = planTranscription(heard, timeline, settingsFor('melody', { quantize: noQuantize, articulation: 'legato', legatoGapMs: 150 }));
    expect(plan.notes[0]?.length).toBeCloseTo(0.4 / secPerTick(120), -1);
    expect(plan.notes[1]?.length).toBeCloseTo(0.3 / secPerTick(120), -1);
  });

  it('staccato halves every note and natural keeps the lengths heard', () => {
    const natural = planTranscription(heard, timeline, settingsFor('melody', { quantize: noQuantize, articulation: 'natural' }));
    const staccato = planTranscription(heard, timeline, settingsFor('melody', { quantize: noQuantize, articulation: 'staccato' }));
    expect(staccato.notes[0]?.length).toBeCloseTo((natural.notes[0]?.length ?? 0) / 2, -1);
  });
});

describe('swing', () => {
  const loop = drumLoop({ bpm: 100, bars: 4, patterns: [BEATS.trap ?? []], swing: 0.6 });
  const heard = listen('drums', loop.mono, loop.rate);

  it('measures the swing of the recording', () => {
    const plan = planTranscription(heard, timelineOf({ bpm: 100 }), settingsFor('drums'));
    expect(plan.swingFound).not.toBeNull();
    expect(Math.abs((plan.swingFound ?? 0) - 0.6)).toBeLessThan(0.15);
  });

  it('straightens it: every hit lands on a 1/16 line, whatever the recording did', () => {
    const plan = planTranscription(heard, timelineOf({ bpm: 100 }), settingsFor('drums', { quantize: { gridTicks: 240, strength: 1, swing: 'straighten' } }));
    expect(plan.notes.length).toBeGreaterThan(20);
    for (const n of plan.notes) expect(n.tick % 240).toBe(0);
  });

  it('keeps it: the off-beat hits are late by the swing found, so they play as in the recording', () => {
    const plan = planTranscription(heard, timelineOf({ bpm: 100 }), settingsFor('drums', { quantize: { gridTicks: 240, strength: 1, swing: 'keep' } }));
    const found = plan.swingFound ?? 0;
    const offbeat = plan.notes.filter((n) => Math.round(n.tick / 240) % 2 === 1 && Math.abs(n.tick - Math.round(n.tick / 240) * 240) > 10);
    expect(offbeat.length).toBeGreaterThan(5);
    for (const n of offbeat) expect(n.tick % 240).toBeCloseTo(found * 120, -1);
  });

  it('keeps it under the song\'s own swing: what is written plays at the recording\'s swung time', () => {
    const songSwing = 0.3;
    const plan = planTranscription(heard, timelineOf({ bpm: 100, swing: songSwing }), settingsFor('drums', { quantize: { gridTicks: 240, strength: 1, swing: 'keep' } }));
    const found = plan.swingFound ?? 0;
    for (const n of plan.notes) {
      const played = swingTick(n.tick, songSwing);
      const line = Math.round(played / 240) * 240;
      const wanted = Math.round(line / 240) % 2 === 1 ? line + found * 120 : line;
      expect(Math.abs(played - wanted)).toBeLessThanOrEqual(4);
    }
  });
});

describe('drum keys and pads', () => {
  const loop = drumLoop({ bpm: 110, bars: 4, patterns: ['rock', 'rock', 'rock', 'fill'].map((p) => BEATS[p] ?? []) });
  const heard = listen('drums', loop.mono, loop.rate);
  const plan = planTranscription(heard, timelineOf({ bpm: 110 }), settingsFor('drums'));

  it('writes the General MIDI drum keys: kick 36, snare 38, closed hat 42, and one key for each tom', () => {
    const keys = new Set(plan.notes.map((n) => n.key));
    expect([GM_KEY.kick, GM_KEY.snare, GM_KEY.hat].every((k) => keys.has(k))).toBe(true);
    const tomKeys = [...keys].filter((k) => ![36, 38, 39, 42, 46, 49, 37].includes(k));
    // Three drums of different pitch: the lowest gets the lowest key, the highest the highest.
    expect(tomKeys.sort((a, b) => a - b)).toEqual([41, 45, 48]);
  });

  it('makes a pad for every key that plays, from a stretch of the recording that holds the hit', () => {
    const keys = [...new Set(plan.notes.map((n) => n.key))].sort((a, b) => a - b);
    expect(plan.pads.map((p) => p.pad)).toEqual(keys.map((k) => k - 35));
    for (const pad of plan.pads) {
      expect(pad.toSec).toBeGreaterThan(pad.fromSec);
      expect(pad.toSec).toBeLessThanOrEqual(loop.mono.length / SR + 1e-6);
    }
  });

  it('turns a loud hit into a high velocity and a quiet one into a low one', () => {
    const quiet = drumLoop({ bpm: 110, bars: 1, patterns: [[[0, 'kick', 1], [1, 'kick', 0.3], [2, 'kick', 1], [3, 'kick', 0.3]]] });
    const planned = planTranscription(listen('drums', quiet.mono, quiet.rate), timelineOf({ bpm: 110 }), settingsFor('drums'));
    const velocities = planned.notes.map((n) => n.velocity);
    expect(velocities).toHaveLength(4);
    expect(velocities[0]).toBeGreaterThan((velocities[1] ?? 1) + 0.2);
    expect(velocities[2]).toBeGreaterThan((velocities[3] ?? 1) + 0.2);
  });
});

describe('modes and errors', () => {
  it('says plainly when what was heard is not for the mode asked', () => {
    const drums = listen('drums', drumLoop({ bpm: 120, bars: 1, patterns: [BEATS.house ?? []] }).mono, SR);
    expect(() => planTranscription(drums, timelineOf(), settingsFor('melody'))).toThrow(TranscribePlanError);
  });

  it('gives an empty plan with a reason for silence', () => {
    const plan = planTranscription(listen('melody', new Float32Array(SR), SR), timelineOf(), settingsFor('melody'));
    expect(plan.notes).toEqual([]);
    expect(plan.summary[0]).toMatch(/No notes were found/);
  });

  it('suggests the mode that fits: a voice, a drum loop, a pad loop and a bass', () => {
    const voice = sing([60, 64, 67, 72, 69, 65, 62, 60].map((midi, i) => ({ from: 0.2 + i * 0.5, to: 0.2 + i * 0.5 + 0.42, midi })), SR, 4.5);
    const drums = drumLoop({ bpm: 124, bars: 4, patterns: [BEATS.house ?? []] }).mono;
    const pads = chordPads({ bpm: 100, chords: progression(['Am', 'F', 'C', 'G']) });
    const bass = bassLine({ bpm: 124, bars: 4, steps: [[[0, 0.9, 33], [1, 0.9, 33], [2, 0.9, 36], [3, 0.9, 31]]] }).mono;
    expect(suggestMode(voice, SR).mode).toBe('melody');
    expect(suggestMode(drums, SR).mode).toBe('drums');
    expect(suggestMode(pads, SR).mode).toBe('chords');
    expect(suggestMode(bass, SR).mode).toBe('bass');
  });

  it('is deterministic: listening and planning the same recording twice gives the same bits', () => {
    const melody = sungMelody({ steps: [[60, 0.4, 0.1], [64, 0.4, 0.1], [67, 0.4]] }).mono;
    const drums = drumLoop({ bpm: 120, bars: 2, patterns: [BEATS.boomBap ?? []] }).mono;
    const pads = chordPads({ bpm: 100, chords: progression(['Am', 'F']) });
    const bass = bassLine({ bpm: 120, bars: 2, steps: [[[0.5, 0.45, 33], [2.5, 0.45, 36]]] }).mono;
    const inputs = { melody, drums, chords: pads, bass } as const;
    for (const mode of ['melody', 'drums', 'chords', 'bass'] as const) {
      const x = inputs[mode];
      const a = planTranscription(listen(mode, x, SR), timelineOf({ length: 960 * 8 }), settingsFor(mode));
      const b = planTranscription(listen(mode, x, SR), timelineOf({ length: 960 * 8 }), settingsFor(mode));
      expect(JSON.stringify(a), mode).toBe(JSON.stringify(b));
      expect(a.notes.length, mode).toBeGreaterThan(0);
    }
  });
});
