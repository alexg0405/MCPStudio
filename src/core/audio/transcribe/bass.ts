/**
 * Bassline: the lowest line of a mixed loop. The recording is low-passed at 260 Hz and its pitch followed with the same
 * tracker and note cutting the melody path uses (tuned for 30–260 Hz), then three things a bass under a kit needs:
 *
 * - a note is also cut where the low band gets a new attack (a bass note struck on the tail of the one before, or of a kick)
 * - a kick (a start in the sub view with a click in the high view beside it) is not a bass note: a note that starts with a
 *   kick at the kick's own pitch is dropped (the kick's tail rings like a bass note), one at another pitch is a bass note
 *   struck with the kick
 * - the pitch tracker needs about two periods of a note before it hears it, so a note starts where the low band's attack was
 *
 * Approximate by design: a bass note at the kick's pitch struck exactly with a kick is lost, and a kick without a click
 * (an 808 on its own) reads as a bass note. Pure and deterministic.
 */
import { butterworth, filterInPlace } from '../../voice/filters';
import { hzToMidi, trackPitch } from '../../voice/pitch';
import { cleanF0, segmentNotes, type PitchNote } from '../../voice/pitch-notes';
import { envelopeOf, findOnsets, topDb, type BandOnset, type Envelope } from './drum-bands';
import { heardNotesFrom } from './notes-heard';
import type { HeardNote } from './types';

/** Settings of the bass listener. */
export interface BassOptions {
  /** 0..1: how much is picked up (default 0.5). */
  sensitivity?: number;
}

/** The bass is looked for below this (Hz): its notes and their first overtones. */
const LOW_PASS_HZ = 260;
const MIN_HZ = 30;
const MAX_HZ = 260;
/** The pitch frames are this far apart (s). */
const HOP_SEC = 0.005;
/** The kick's click is looked for above this (Hz). */
const CLICK_HZ = 7000;
/** Seconds the low band's level curve holds each peak: half a cycle of the lowest bass. */
const LOW_HOLD_SEC = 0.016;
/** A new attack in the low band: a rise of this much (dB), nothing within this long of the last (s). */
const ATTACK_RISE_DB = 3;
const ATTACK_GAP_SEC = 0.07;

/** The low-passed copy of a signal. */
function lowBand(mono: Float32Array, sampleRate: number): Float32Array {
  const out = Float32Array.from(mono);
  filterInPlace(out, butterworth('lowpass', 4, LOW_PASS_HZ, sampleRate));
  return out;
}

/** The starts of new attacks in the low band (seconds). */
function lowAttacks(low: Float32Array, sampleRate: number, sensitivity: number): BandOnset[] {
  const env = envelopeOf(low, sampleRate, LOW_HOLD_SEC);
  return findOnsets(env, { lookBack: 14, riseDb: ATTACK_RISE_DB, rangeDb: 24 + 20 * sensitivity, minGapBlocks: Math.round(ATTACK_GAP_SEC / env.blockSec) }, topDb(env));
}

/** A click is gone this long after its peak (s), by this many dB: a hat's attack on the same beat is not (it rings on). */
const CLICK_GONE_SEC = 0.008;
const CLICK_GONE_DB = 15;

/** True when a start in the high view is a click: its level 8 ms after the peak is far under it. */
function isClick(env: Envelope, onset: BandOnset): boolean {
  const later = env.db[Math.min(env.db.length - 1, onset.peakBlock + Math.round(CLICK_GONE_SEC / env.blockSec))] as number;
  return later < onset.peakDb - CLICK_GONE_DB;
}

/** The starts of kicks: a sub-view attack with a click (a sharp rise in the high view) at the same moment. */
function kickMarks(mono: Float32Array, sampleRate: number): number[] {
  const sub = Float32Array.from(mono);
  filterInPlace(sub, butterworth('lowpass', 4, 100, sampleRate));
  const high = Float32Array.from(mono);
  filterInPlace(high, butterworth('highpass', 4, Math.min(CLICK_HZ, sampleRate * 0.4), sampleRate));
  const subEnv = envelopeOf(sub, sampleRate, LOW_HOLD_SEC);
  const highEnv = envelopeOf(high, sampleRate, 0.002);
  const subStarts = findOnsets(subEnv, { lookBack: 12, riseDb: 3, rangeDb: 30, minGapBlocks: 30 }, topDb(subEnv));
  const clicks = findOnsets(highEnv, { lookBack: 6, riseDb: 15, rangeDb: 35, minGapBlocks: 10 }, topDb(highEnv)).filter((c) => isClick(highEnv, c));
  return subStarts.filter((s) => clicks.some((c) => Math.abs(c.timeSec - s.timeSec) <= 0.012)).map((s) => s.timeSec);
}

/** The middle value of a list (NaN for none). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[sorted.length >> 1] as number) : Number.NaN;
}

/** A note that starts within this long before and after a kick's start is struck with it (s). */
const WITH_KICK_BEFORE_SEC = 0.02;
const WITH_KICK_AFTER_SEC = 0.12;
/** A note this close (semitones) to the kicks' pitch, struck with a kick, is the kick's tail. */
const KICK_PITCH_TOLERANCE = 0.7;

/** The pitch kicks ring at (MIDI): the median pitch of the notes that start with a kick; NaN with fewer than two such notes. */
function kickPitch(notes: readonly PitchNote[], marks: readonly number[]): number {
  const struck = notes.filter((note) => marks.some((t) => note.from >= t - WITH_KICK_BEFORE_SEC && note.from <= t + WITH_KICK_AFTER_SEC));
  return struck.length < 2 ? Number.NaN : median(struck.map((note) => note.pitch));
}

/** An attack cuts a note only when it is this far (s) from the note's start and end: a ripple near an edge is no new note. */
const CUT_MARGIN_SEC = 0.1;
/** A cut needs a clear attack: this many dB (a bass struck on a kick's tail rises only a little). */
const CUT_RISE_DB = 4;

/** The median MIDI pitch of the voiced frames of a track between two times (NaN when none). */
function pitchBetween(f0: Float32Array, fromSec: number, toSec: number): number {
  const values: number[] = [];
  for (let i = Math.max(0, Math.round(fromSec / HOP_SEC)); i <= Math.min(f0.length - 1, Math.round(toSec / HOP_SEC)); i++) {
    if ((f0[i] as number) > 0) values.push(hzToMidi(f0[i] as number));
  }
  return median(values);
}

/**
 * A pitch note cut at the attacks inside it: the tracker holds one note across a bass struck on the tail of a kick (or of
 * a note of the same pitch). Each piece gets the pitch its own frames hold, from 40 ms after the attack (the tracker may
 * still be reading what came before).
 */
function cutAtAttacks(note: PitchNote, attacks: readonly BandOnset[], f0: Float32Array): PitchNote[] {
  const inside = attacks.filter((a) => a.riseDb >= CUT_RISE_DB && a.timeSec > note.from + CUT_MARGIN_SEC && a.timeSec < note.to - CUT_MARGIN_SEC).map((a) => a.timeSec);
  const edges = [note.from, ...inside, note.to];
  return edges.slice(0, -1).map((from, i) => {
    const pitch = i === 0 ? note.pitch : pitchBetween(f0, from + 0.04, edges[i + 1] as number);
    return { ...note, from, to: edges[i + 1] as number, pitch: Number.isNaN(pitch) ? note.pitch : pitch };
  });
}

/** How far before a note's heard start its attack may be (s): the tracker hears a note late. */
const ATTACK_REACH_SEC = 0.11;
/** A repeated bass note must dip this far (dB) before the level rises again. */
const REPEAT_DIP_DB = 10;

/** A note moved back to the strongest attack of the low band within 110 ms before it. */
function startAtAttack(note: PitchNote, attacks: readonly BandOnset[]): PitchNote {
  const near = attacks.filter((a) => a.timeSec <= note.from + 0.01 && a.timeSec >= note.from - ATTACK_REACH_SEC);
  if (near.length === 0) return note;
  const strongest = near.reduce((best, a) => (a.riseDb > best.riseDb ? a : best));
  return { ...note, from: Math.min(note.from, strongest.timeSec) };
}

/** True when a note is the ring of a kick: struck with one, at the pitch kicks ring at. */
function isKickTail(note: PitchNote, marks: readonly number[], ringing: number): boolean {
  if (Number.isNaN(ringing) || Math.abs(note.pitch - ringing) > KICK_PITCH_TOLERANCE) return false;
  return marks.some((t) => note.from >= t - WITH_KICK_BEFORE_SEC && note.from <= t + WITH_KICK_AFTER_SEC);
}

/** The bass notes of a mono recording (30–260 Hz), seconds on the recording's own timeline. */
export function detectBass(mono: Float32Array, sampleRate: number, options: BassOptions = {}): HeardNote[] {
  const sensitivity = options.sensitivity ?? 0.5;
  const low = lowBand(mono, sampleRate);
  const hop = Math.max(1, Math.round(HOP_SEC * sampleRate));
  const track = trackPitch(low, sampleRate, { minHz: MIN_HZ, maxHz: MAX_HZ, hop });
  const clean = cleanF0(track.f0, track.confidence);
  const notes = segmentNotes({ t0: 0, hop: hop / sampleRate, f0: clean.f0, conf: clean.conf });
  const attacks = lowAttacks(low, sampleRate, sensitivity);
  const marks = kickMarks(mono, sampleRate);
  const ringing = kickPitch(notes, marks);
  const pieces = notes.flatMap((note) => cutAtAttacks(note, attacks, clean.f0)).map((note) => startAtAttack(note, attacks));
  const bass = pieces.filter((note) => !isKickTail(note, marks, ringing));
  return heardNotesFrom(bass, low, sampleRate, sensitivity, REPEAT_DIP_DB);
}
