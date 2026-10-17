/**
 * The arranger's generators: what each variant step does to a pattern's notes over its span. Fills
 * and builds REPLACE the drums in their span (they never layer on the groove), rolls replace the
 * hats, gaps and dropouts also cut notes still held at the span's start (a held 808 would ring
 * through the gap). Velocities scale with the section's energy, plus a seeded ±0.03 jitter, and
 * crescendos keep rising to their last (loudest) hit. Kit channels (Drum Pads, Drum Synth) are read
 * and played by General MIDI key.
 */
import { FOUR_FLOOR, GROOVE, type Style } from '../beat/style';
import type { ChannelId, Tick, VariantStep } from '../model/types';
import { cutHeldAt, listOf, removeWhere, startsIn, type NoteSet, type WorkNote } from './notes';
import { jitter } from './random';
import { inPart, isBassRole, isDrumRole, isHatRole, noteRole, partName, type Role } from './roles';

const STEP = 240;
const BEAT = 960;
const EIGHTH = 480;
const THIRTY_SECOND = 120;

/** GM keys a kit channel plays each drum on (Drum Pads' default layout). */
export const KIT_KEYS = { kick: 36, snare: 38, clap: 39, hat: 42, openHat: 46, crash: 49, toms: [48, 45, 41] } as const;

/** What the generators know about the project's channels. */
export interface VariantEnv {
  roles: ReadonlyMap<ChannelId, Role>;
  /** Root key per channel (drum samplers play their root key), channel order, and a tom's height (2 high … 0 low). */
  channels: ReadonlyMap<ChannelId, { rootKey: number; order: number; height?: number }>;
  style: Style;
  /** The song key's root and scale intervals (an 808 slide that can't move an octave stays in the scale). */
  scale?: { root: number; intervals: readonly number[] } | null;
}

export interface StepContext {
  env: VariantEnv;
  rand: () => number;
  /** The pattern's length in ticks. */
  length: Tick;
}

/** An instrument a generator plays: a channel and the key its notes go on. */
export interface Voice {
  channelId: ChannelId;
  key: number;
}

interface Voices {
  kick?: Voice;
  snare?: Voice;
  hat?: Voice;
  openHat?: Voice;
  /** High, mid, low. */
  toms: Voice[];
}

const roleOf = (env: VariantEnv, cid: ChannelId): Role => env.roles.get(cid) ?? 'other';

const clampVel = (v: number) => Math.min(1, Math.max(0.05, v));

/** A base velocity at the section's energy (5 = as written, 1 = 80%), with the seeded jitter. */
function vel(base: number, energy: number, rand: () => number, jit = 0.03): number {
  return clampVel(base * (0.75 + 0.05 * Math.min(5, Math.max(1, energy))) + jitter(rand, jit));
}

/** Velocities that keep rising to the last hit (the loudest), after jitter. */
function crescendo(values: number[]): number[] {
  for (let i = 1; i < values.length; i++) values[i] = Math.max(values[i]!, values[i - 1]! + 0.004);
  const peak = values.length ? Math.max(...values) : 0;
  if (values.length) values[values.length - 1] = clampVel(Math.max(peak, values[values.length - 1]!));
  return values.map(clampVel);
}

/** Does the set play any drum note? (Fills only go where there is a groove to replace.) */
export function hasDrums(set: NoteSet, env: VariantEnv): boolean {
  for (const [cid, list] of set) if (list.length && isDrumRole(roleOf(env, cid))) return true;
  return false;
}

function notesOfRole(set: NoteSet, env: VariantEnv, want: (r: Role) => boolean): number {
  let n = 0;
  for (const [cid, list] of set) {
    const r = roleOf(env, cid);
    for (const x of list) if (want(noteRole(r, x.key))) n++;
  }
  return n;
}

/** The key a channel's notes mostly use in the set (drum samplers play one key), else its root key. */
function usualKey(set: NoteSet, env: VariantEnv, cid: ChannelId): number {
  const list = set.get(cid);
  if (!list?.length) return env.channels.get(cid)?.rootKey ?? 60;
  const counts = new Map<number, number>();
  for (const n of list) counts.set(n.key, (counts.get(n.key) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

/**
 * The channel playing a drum: one of the pattern's own channels of that role (the busiest), else
 * another channel of the project with it, else a kit channel on its GM key.
 */
function voiceFor(set: NoteSet, env: VariantEnv, roles: readonly Role[], kitKey: number): Voice | undefined {
  for (const role of roles) {
    const own = [...set].filter(([cid, list]) => list.length && roleOf(env, cid) === role).sort((a, b) => b[1].length - a[1].length);
    if (own[0]) return { channelId: own[0][0], key: usualKey(set, env, own[0][0]) };
  }
  // The pattern's own kit channel plays it on its GM key (the same kit sound), before other channels.
  const ownKit = [...set].find(([cid, list]) => list.length && roleOf(env, cid) === 'kit')?.[0];
  if (ownKit) return { channelId: ownKit, key: kitKey };
  const order = (cid: ChannelId) => env.channels.get(cid)?.order ?? 0;
  for (const role of roles) {
    const other = [...env.roles].filter(([, r]) => r === role).sort((a, b) => order(a[0]) - order(b[0]))[0];
    if (other) return { channelId: other[0], key: env.channels.get(other[0])?.rootKey ?? 60 };
  }
  const kit = [...env.roles].filter(([, r]) => r === 'kit').sort((a, b) => order(a[0]) - order(b[0]))[0]?.[0];
  return kit ? { channelId: kit, key: kitKey } : undefined;
}

function voices(set: NoteSet, env: VariantEnv): Voices {
  const out: Voices = { toms: [] };
  const kick = voiceFor(set, env, ['kick'], KIT_KEYS.kick);
  const snare = voiceFor(set, env, ['snare', 'clap', 'rim'], KIT_KEYS.snare);
  const hat = voiceFor(set, env, ['hat'], KIT_KEYS.hat);
  const openHat = voiceFor(set, env, ['open-hat'], KIT_KEYS.openHat);
  if (kick) out.kick = kick;
  if (snare) out.snare = snare;
  if (hat) out.hat = hat;
  if (openHat) out.openHat = openHat;
  const toms = [...env.roles]
    .filter(([, r]) => r === 'tom')
    .map(([cid]) => cid)
    .sort((a, b) => (env.channels.get(b)?.height ?? 1) - (env.channels.get(a)?.height ?? 1) || (env.channels.get(a)?.order ?? 0) - (env.channels.get(b)?.order ?? 0));
  if (toms.length >= 3) out.toms = toms.slice(0, 3).map((cid) => ({ channelId: cid, key: env.channels.get(cid)?.rootKey ?? 60 }));
  else if (toms.length) {
    // One tom channel played higher and lower.
    const key = env.channels.get(toms[0]!)?.rootKey ?? 60;
    out.toms = [5, 0, -5].map((d) => ({ channelId: toms[0]!, key: key + d }));
  } else {
    const kit = [...set].find(([cid, list]) => list.length && roleOf(env, cid) === 'kit')?.[0];
    if (kit) out.toms = KIT_KEYS.toms.map((key) => ({ channelId: kit, key }));
  }
  return out;
}

/** Removes the notes in [from, to) that `which` picks (by the note's own drum on kit channels). */
function clear(set: NoteSet, env: VariantEnv, from: Tick, to: Tick, which: (r: Role) => boolean, cutHeld = false): void {
  for (const [cid, list] of set) {
    const r = roleOf(env, cid);
    removeWhere(list, (n) => startsIn(n, from, to) && which(noteRole(r, n.key)));
    if (cutHeld) cutHeldAt(list, from, (n) => which(noteRole(r, n.key)));
  }
}

const isDrum = (r: Role) => isDrumRole(r);
const notFx = (r: Role) => r !== 'fx';

function add(set: NoteSet, v: Voice, tick: Tick, length: Tick, velocity: number): void {
  listOf(set, v.channelId).push({ tick: Math.round(tick), length: Math.max(1, Math.round(length)), key: v.key, velocity });
}

/** Hits at positions (1/16 steps from `from`), each lasting up to the next one. */
function hits(set: NoteSet, from: Tick, to: Tick, list: { at: number; v: Voice; vel: number }[]): void {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  sorted.forEach((h, i) => {
    const tick = from + Math.round(h.at * STEP);
    if (tick >= to) return;
    const next = sorted[i + 1] ? from + Math.round(sorted[i + 1]!.at * STEP) : to;
    add(set, h.v, tick, Math.min(STEP, Math.max(THIRTY_SECOND / 2, next - tick)), h.vel);
  });
}

const beatsOf = (step: VariantStep) => Math.max(1, Math.round((step.to - step.from) / BEAT));
const fillBeats = (b: number): 1 | 2 | 4 => (b >= 3 ? 4 : b === 2 ? 2 : 1);

/** Snare fills (positions in 1/16 steps from the fill's start, base velocity). */
export const SNARE_FILL: Record<1 | 2 | 4, readonly (readonly [number, number])[]> = {
  1: [[0, 0.62], [1, 0.7], [2, 0.78], [2.5, 0.85], [3, 0.92], [3.5, 1]],
  2: [[0, 0.55], [2, 0.62], [4, 0.7], [5, 0.76], [6, 0.82], [6.5, 0.88], [7, 0.94], [7.5, 1]],
  4: [
    [0, 0.5], [2, 0.55], [4, 0.6], [6, 0.65], [8, 0.68], [9, 0.71], [10, 0.74], [11, 0.77],
    [12, 0.8], [12.5, 0.83], [13, 0.86], [13.5, 0.89], [14, 0.92], [14.5, 0.95], [15, 0.98], [15.5, 1],
  ],
};

function snareFill(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  const snare = v.snare;
  if (!snare) return false;
  const e = step.energy ?? 4;
  const shape = SNARE_FILL[fillBeats(beatsOf(step))];
  const vels = crescendo(shape.map(([, b]) => vel(b, e, c.rand)));
  const from = step.to - fillBeats(beatsOf(step)) * BEAT;
  clear(set, c.env, step.from, step.to, isDrum);
  hits(set, Math.max(step.from, from), step.to, shape.map(([at], i) => ({ at, v: snare, vel: vels[i]! })));
  return true;
}

function tomFill(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  if (v.toms.length < 3 || !v.snare) return false;
  const e = step.energy ?? 4;
  const n = fillBeats(beatsOf(step)) * 4;
  const group = Math.ceil((n - 1) / 3);
  const list: { at: number; v: Voice; vel: number }[] = [];
  for (let i = 0; i < n - 1; i++) list.push({ at: i, v: v.toms[Math.min(2, Math.floor(i / group))]!, vel: vel(i % 2 ? 0.72 : 0.9, e, c.rand) });
  list.push({ at: n - 1, v: v.snare, vel: clampVel(vel(1, e, c.rand, 0) + 0.02) });
  const top = Math.max(...list.map((h) => h.vel));
  list[list.length - 1]!.vel = clampVel(Math.max(top + 0.01, list[list.length - 1]!.vel));
  clear(set, c.env, step.from, step.to, isDrum);
  hits(set, step.to - n * STEP, step.to, list);
  return true;
}

function hatFill(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  if (!v.hat || !v.snare) return false;
  const e = step.energy ?? 4;
  const beats = fillBeats(beatsOf(step));
  const grid = GROOVE[c.env.style].roll === 24 ? 160 : THIRTY_SECOND;
  const from = step.to - beats * BEAT;
  const count = Math.round((beats * BEAT) / grid);
  const hatVels = crescendo(Array.from({ length: count }, (_, i) => vel(0.45 + (0.5 * i) / Math.max(1, count - 1), e, c.rand)));
  clear(set, c.env, step.from, step.to, isDrum);
  for (let i = 0; i < count; i++) add(set, v.hat, from + i * grid, grid, hatVels[i]!);
  const steps = beats * 4;
  const snareVels = crescendo([vel(0.85, e, c.rand), vel(1, e, c.rand, 0)]);
  hits(set, from, step.to, [
    { at: steps - 2, v: v.snare, vel: snareVels[0]! },
    { at: steps - 1, v: v.snare, vel: Math.max(snareVels[1]!, ...hatVels) },
  ]);
  return true;
}

function kickFill(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  if (!v.kick || !v.snare) return false;
  const e = step.energy ?? 4;
  const n = fillBeats(beatsOf(step)) * 4;
  const vels = crescendo(Array.from({ length: n }, (_, i) => vel(0.6 + (0.4 * i) / Math.max(1, n - 1), e, c.rand)));
  clear(set, c.env, step.from, step.to, isDrum);
  hits(
    set,
    step.to - n * STEP,
    step.to,
    vels.map((x, i) => ({ at: i, v: i % 2 ? v.snare! : v.kick!, vel: x })),
  );
  return true;
}

/** The snare build over a build's last bars: quarters, then 8ths, 16ths and 32nds, .40 → 1.0. */
function snareBuild(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  if (!v.snare) return false;
  const total = step.total ?? step.to - step.from;
  const offset = step.offset ?? 0;
  const quarter = Math.max(STEP, Math.round(total / 4 / STEP) * STEP);
  const rates = [BEAT, EIGHTH, STEP, THIRTY_SECOND];
  const four = FOUR_FLOOR.has(c.env.style);
  clear(set, c.env, step.from, step.to, isDrum);
  const at: number[] = [];
  for (let j = 0; j < 4; j++) {
    const end = j === 3 ? total : Math.min(total, (j + 1) * quarter);
    for (let t = j * quarter; t < end; t += rates[j]!) at.push(t);
  }
  const vels = crescendo(at.map((t) => vel(0.4 + (0.6 * t) / Math.max(1, total - THIRTY_SECOND), step.energy ?? 4, c.rand)));
  at.forEach((t, i) => {
    const tick = step.from + (t - offset);
    if (tick < step.from || tick >= step.to) return;
    const next = at[i + 1] ?? total;
    add(set, v.snare!, tick, Math.min(STEP, next - t), vels[i]!);
  });
  // Four-on-the-floor styles keep the kick on the beat until the last quarter of the build.
  if (four && v.kick)
    for (let t = 0; t < 3 * quarter; t += BEAT) {
      const tick = step.from + (t - offset);
      if (tick >= step.from && tick < step.to) add(set, v.kick, tick, STEP, vel(0.9, step.energy ?? 4, c.rand));
    }
  return true;
}

function hatRoll(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  if (!v.hat) return false;
  const grid = GROOVE[c.env.style].roll === 24 ? 160 : THIRTY_SECOND;
  const count = Math.max(2, Math.round((step.to - step.from) / grid));
  const vels = crescendo(Array.from({ length: count }, (_, i) => vel(0.45 + (0.45 * i) / Math.max(1, count - 1), step.energy ?? 4, c.rand)));
  clear(set, c.env, step.from, step.to, isHatRole);
  for (let i = 0; i < count; i++) add(set, v.hat, step.from + i * grid, grid, vels[i]!);
  return true;
}

function openHat(set: NoteSet, step: VariantStep, c: StepContext, v: Voices): boolean {
  if (!v.openHat) return false;
  const from = Math.max(step.from, step.to - EIGHTH);
  clear(set, c.env, from, step.to, (r) => r === 'hat');
  add(set, v.openHat, from, step.to - from, vel(0.8, step.energy ?? 4, c.rand));
  return true;
}

/** A slide target: an octave up or down within C1–C3, else a fifth or fourth in the song's scale. */
export function slideKey(key: number, scale?: VariantEnv['scale']): number {
  if (key + 12 <= 48) return key + 12;
  if (key - 12 >= 24) return key - 12;
  const inScale = (k: number) => !scale || scale.intervals.includes((((k - scale.root) % 12) + 12) % 12);
  for (const d of [7, -5, 5, -7, 3, -3, 2, -2]) if (key + d >= 12 && key + d <= 48 && inScale(key + d)) return key + d;
  return key + (key <= 36 ? 7 : -5);
}

/**
 * 808 slide: a new note half a beat before the span's end, an octave away, with the note before it
 * stretched to overlap it by 120 ticks so the 808 glides (notes that only touch retrigger).
 */
function slide(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  const at = Math.max(step.from, step.to - EIGHTH);
  let done = false;
  for (const [cid, list] of set) {
    if (roleOf(c.env, cid) !== '808') continue;
    const before = list.filter((n) => n.tick < at && n.tick + n.length >= at - EIGHTH);
    const prev = before.sort((a, b) => b.tick - a.tick)[0];
    if (!prev) continue;
    removeWhere(list, (n) => startsIn(n, at, step.to));
    prev.length = at + THIRTY_SECOND - prev.tick;
    list.push({ tick: at, length: step.to - at, key: slideKey(prev.key, c.env.scale), velocity: prev.velocity });
    done = true;
  }
  return done;
}

/**
 * Drums and 808/bass out over the span: the pre-drop gap. A bass note held into it ends a 1/32
 * early, so its release has died away when the gap starts (the lows really go quiet).
 */
function gap(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  clear(set, c.env, step.from, step.to, (r) => isDrum(r) || isBassRole(r), true);
  const early = Math.max(0, step.from - THIRTY_SECOND);
  for (const [cid, list] of set)
    if (isBassRole(roleOf(c.env, cid))) for (const n of list) if (n.tick < early && n.tick + n.length > early) n.length = early - n.tick;
  return true;
}

/** Everything out over the span; held bass and music notes are cut at its start. */
function dropout(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  clear(set, c.env, step.from, step.to, notFx, true);
  return true;
}

/** Repeats the start of the span (a 1/16, or a 1/32 for short spans) to its end, getting louder. */
function stutter(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  const seg = step.to - step.from <= EIGHTH ? THIRTY_SECOND : STEP;
  const n = Math.floor((step.to - step.from) / seg);
  if (n < 2) return false;
  for (const [cid, list] of set) {
    const r = roleOf(c.env, cid);
    if (!notFx(r)) continue;
    const slice: WorkNote[] = [];
    for (const x of list) {
      if (startsIn(x, step.from, step.from + seg)) slice.push({ ...x, tick: x.tick - step.from, length: Math.min(x.length, seg - (x.tick - step.from)) });
      else if (!isDrumRole(r) && x.tick < step.from && x.tick + x.length > step.from)
        slice.push({ ...x, tick: 0, length: Math.min(seg, x.tick + x.length - step.from) });
    }
    removeWhere(list, (x) => startsIn(x, step.from, step.to));
    cutHeldAt(list, step.from);
    for (let k = 0; k < n; k++)
      for (const s of slice)
        list.push({ ...s, tick: step.from + k * seg + s.tick, velocity: clampVel(s.velocity * (0.7 + (0.3 * k) / (n - 1)) + jitter(c.rand, 0.02)) });
  }
  return true;
}

/** Thinner drums: 1 drops ghost notes, percussion and hats off the 8ths; 2 keeps kick, snare and hats on the beat. */
function thin(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  const level = (step.level ?? 1) >= 2 ? 2 : 1;
  for (const [cid, list] of set) {
    const cr = roleOf(c.env, cid);
    if (!isDrumRole(cr)) continue;
    removeWhere(list, (n) => {
      if (!startsIn(n, step.from, step.to)) return false;
      const r = noteRole(cr, n.key);
      const strong = n.velocity >= 0.5;
      if (level === 1) {
        if (r === 'kick') return false;
        if (r === 'snare' || r === 'clap' || r === 'rim') return !strong;
        if (r === 'hat') return n.tick % EIGHTH !== 0;
        if (r === 'crash' || r === 'open-hat') return false;
        return true;
      }
      if (r === 'kick' || r === 'snare' || r === 'clap') return n.tick % BEAT !== 0 || n.velocity < 0.6;
      if (r === 'hat') return n.tick % BEAT !== 0;
      return r !== 'crash';
    });
  }
  return true;
}

/** Closed hats on the 8ths get a softer hat on the 16th between them. */
function doubleHats(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  let added = false;
  for (const [cid, list] of set) {
    const cr = roleOf(c.env, cid);
    const hats = list
      .filter((n) => startsIn(n, step.from, step.to) && noteRole(cr, n.key) === 'hat')
      .sort((a, b) => a.tick - b.tick);
    for (let i = 0; i + 1 < hats.length; i++) {
      const a = hats[i]!;
      const b = hats[i + 1]!;
      if (b.tick - a.tick !== EIGHTH) continue;
      list.push({ ...a, tick: a.tick + STEP, length: Math.min(a.length, STEP), velocity: clampVel(Math.min(a.velocity, b.velocity) * 0.65 + jitter(c.rand, 0.03)) });
      added = true;
    }
  }
  return added;
}

/** Leaves parts (or channels) out over the span. */
function without(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  const parts = (step.parts ?? []).map((p) => partName(p) ?? p);
  if (!parts.length) return false;
  for (const [cid, list] of set) {
    const r = roleOf(c.env, cid);
    const drop = (n: WorkNote) => parts.some((p) => p === cid || inPart(p, r, n.key));
    removeWhere(list, (n) => startsIn(n, step.from, step.to) && drop(n));
    cutHeldAt(list, step.from, drop);
  }
  return true;
}

/** Drums out over the span (room for a fill that plays on another track). */
function clearDrums(set: NoteSet, step: VariantStep, c: StepContext): boolean {
  clear(set, c.env, step.from, step.to, isDrum, true);
  return true;
}

/** Fills that can't be played with the drums at hand fall back to one that can. */
const FILL_FALLBACK: Record<'snare-fill' | 'tom-fill' | 'hat-fill' | 'kick-fill', readonly ('snare-fill' | 'tom-fill' | 'hat-fill' | 'kick-fill')[]> = {
  'snare-fill': ['snare-fill', 'hat-fill', 'kick-fill'],
  'tom-fill': ['tom-fill', 'snare-fill', 'hat-fill'],
  'hat-fill': ['hat-fill', 'snare-fill', 'kick-fill'],
  'kick-fill': ['kick-fill', 'snare-fill', 'hat-fill'],
};

/**
 * Applies one step to the notes (in place). Steps that need a groove (fills, rolls, open hats,
 * double hats) do nothing on a pattern without drums; a slide needs an 808.
 */
export function applyStep(set: NoteSet, step: VariantStep, c: StepContext): void {
  if (step.to <= step.from) return;
  switch (step.kind) {
    case 'snare-fill':
    case 'tom-fill':
    case 'hat-fill':
    case 'kick-fill': {
      if (!hasDrums(set, c.env)) return;
      const v = voices(set, c.env);
      for (const kind of FILL_FALLBACK[step.kind]) {
        const fn = kind === 'snare-fill' ? snareFill : kind === 'tom-fill' ? tomFill : kind === 'hat-fill' ? hatFill : kickFill;
        if (fn(set, step, c, v)) return;
      }
      return;
    }
    case 'snare-build':
      if (hasDrums(set, c.env)) snareBuild(set, step, c, voices(set, c.env));
      return;
    case 'hat-roll':
      if (notesOfRole(set, c.env, (r) => r === 'hat') > 0) hatRoll(set, step, c, voices(set, c.env));
      return;
    case 'open-hat':
      if (notesOfRole(set, c.env, (r) => r === 'hat') > 0) openHat(set, step, c, voices(set, c.env));
      return;
    case 'slide':
      slide(set, step, c);
      return;
    case 'gap':
      gap(set, step, c);
      return;
    case 'dropout':
      dropout(set, step, c);
      return;
    case 'stutter':
      stutter(set, step, c);
      return;
    case 'thin':
      thin(set, step, c);
      return;
    case 'double-hats':
      doubleHats(set, step, c);
      return;
    case 'without':
      without(set, step, c);
      return;
    case 'clear-drums':
      clearDrums(set, step, c);
      return;
  }
}

/** What a generator can play on these notes (the phrase planner picks small changes with it). */
export function capabilities(set: NoteSet, env: VariantEnv): { drums: boolean; hats: boolean; openHat: boolean; slide: boolean } {
  const drums = hasDrums(set, env);
  const hats = notesOfRole(set, env, (r) => r === 'hat') > 0;
  const v = drums ? voices(set, env) : { toms: [] };
  let has808 = false;
  for (const [cid, list] of set) if (list.length && roleOf(env, cid) === '808') has808 = true;
  return { drums, hats, openHat: hats && !!v.openHat, slide: has808 };
}
