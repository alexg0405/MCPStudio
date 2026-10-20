/**
 * Planning the notes of a drum part: every heard hit lands on a General MIDI drum key (the keys Drum Pads' default kit
 * plays), in song ticks through the clip's playback maths, snapped to the grid. Toms are told apart by the pitch of their
 * body, one key per drum. The clean examples picked from the recording become pads (which key is which pad is Drum Pads'
 * own layout: pad n plays key 35 + n), so the notes can play the recording's own kit. Pure.
 */
import { songTickAt, type ClipTimeline } from './timeline';
import { makeQuantizer, measureSwing } from './quantize';
import { tomGroups } from './drum-cuts';
import type { DrumKind, HeardHit, KitCut, PlannedNote, PlannedPad, TranscribeSettings } from './types';

/** The General MIDI key of each kind of hit that has one key. */
export const GM_KEY: Readonly<Record<Exclude<DrumKind, 'tom'>, number>> = {
  kick: 36,
  snare: 38,
  clap: 39,
  hat: 42,
  'open-hat': 46,
  cymbal: 49,
  perc: 37,
};

/** The toms' keys for one to six drums, from the lowest drum up (General MIDI toms: 41, 43, 45, 47, 48, 50). */
const TOM_KEYS: readonly (readonly number[])[] = [[45], [41, 48], [41, 45, 48], [41, 43, 47, 50], [41, 43, 45, 47, 50], [41, 43, 45, 47, 48, 50]];

/** The first key of Drum Pads' pads: pad 1 plays key 36. */
const FIRST_PAD_KEY = 36;
const PAD_COUNT = 16;

/** How long a note of each kind is written (ticks): the pad plays its whole sound anyway, so this only has to look right. */
const NOTE_TICKS: Readonly<Record<DrumKind, number>> = { kick: 240, snare: 240, clap: 240, hat: 120, 'open-hat': 240, tom: 240, cymbal: 480, perc: 120 };
/** A hit's velocity: from this up to 1 for the loudest hits of its kind. */
const MIN_VELOCITY = 0.25;

/** The key of each tom hit: the toms are grouped by pitch and the groups get the toms' keys from the lowest up. */
function tomKeyOf(toms: readonly HeardHit[]): Map<HeardHit, number> {
  const groups = tomGroups(toms);
  const keys = TOM_KEYS[Math.min(groups.length, TOM_KEYS.length) - 1] ?? [];
  const keyOf = new Map<HeardHit, number>();
  groups.forEach((group, i) => {
    const key = keys[Math.min(i, keys.length - 1)] as number;
    for (const tom of group) keyOf.set(tom, key);
  });
  return keyOf;
}

/** The key of every hit. */
function keysOf(hits: readonly HeardHit[]): Map<HeardHit, number> {
  const keyOf = tomKeyOf(hits.filter((h) => h.kind === 'tom'));
  for (const hit of hits) if (hit.kind !== 'tom') keyOf.set(hit, GM_KEY[hit.kind]);
  return keyOf;
}

/** What planning a drum part gives. */
export interface PlannedDrums {
  notes: PlannedNote[];
  pads: PlannedPad[];
  swingFound: number | null;
}

/** The notes (and the pads that would play the recording's own sounds) for a drum recording and a clip. */
export function planDrums(hits: readonly HeardHit[], cuts: readonly KitCut[], timeline: ClipTimeline, settings: TranscribeSettings): PlannedDrums {
  const keyOf = keysOf(hits);
  const start = timeline.clip.start;
  const inside = hits
    .map((hit) => ({ hit, tick: songTickAt(timeline, hit.timeSec) - start }))
    .filter((h) => h.tick >= -1 && h.tick < timeline.clip.length);
  const swingFound = measureSwing(inside.map((h) => h.tick));
  const quantize = makeQuantizer(settings.quantize, { songSwing: timeline.songSwing, swingFound, clipStart: start });
  const seen = new Set<string>();
  const notes: PlannedNote[] = [];
  for (const { hit, tick } of inside) {
    const key = keyOf.get(hit) as number;
    const at = Math.max(0, quantize(Math.max(0, tick)));
    const id = `${key}:${at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const velocity = Math.round((MIN_VELOCITY + (1 - MIN_VELOCITY) * hit.strength) * 1000) / 1000;
    notes.push({ tick: at, length: Math.min(NOTE_TICKS[hit.kind], timeline.clip.length - at), key, velocity });
  }
  notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
  return { notes, pads: padsFor(hits, cuts, keyOf), swingFound };
}

/** The pad each used key plays: the clean example cut of its kind (a tom: of its pitch group). */
function padsFor(hits: readonly HeardHit[], cuts: readonly KitCut[], keyOf: Map<HeardHit, number>): PlannedPad[] {
  const pads: PlannedPad[] = [];
  const usedKeys = new Set(keyOf.values());
  for (const key of usedKeys) {
    const pad = key - FIRST_PAD_KEY + 1;
    if (pad < 1 || pad > PAD_COUNT) continue;
    const sample = [...keyOf].find(([, k]) => k === key)?.[0] as HeardHit;
    const cut = cutFor(sample, hits, cuts, keyOf, key);
    if (cut) pads.push({ pad, kind: sample.kind, fromSec: cut.fromSec, toSec: cut.toSec, ...(cut.with ? { with: cut.with } : {}) });
  }
  return pads.sort((a, b) => a.pad - b.pad);
}

/** The cut that holds a key's sound: its kind's cut, or for toms the cut whose pitch is nearest the key's toms. */
function cutFor(sample: HeardHit, hits: readonly HeardHit[], cuts: readonly KitCut[], keyOf: Map<HeardHit, number>, key: number): KitCut | undefined {
  const ofKind = cuts.filter((c) => c.kind === sample.kind);
  if (sample.kind !== 'tom') return ofKind[0];
  const pitches = hits.filter((h) => keyOf.get(h) === key).map((h) => h.bodyHz ?? 0);
  const target = pitches.reduce((a, b) => a + b, 0) / Math.max(1, pitches.length);
  return ofKind.reduce<KitCut | undefined>((best, c) => (!best || Math.abs((c.bodyHz ?? 0) - target) < Math.abs((best.bodyHz ?? 0) - target) ? c : best), undefined);
}
