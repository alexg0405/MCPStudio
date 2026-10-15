/**
 * Leveling the mix by ear, the way a mixer starts: render the role buses of the song's busiest
 * part (each as it reaches the master, the master's chain bypassed), measure their loudness, set
 * every bus to its style's level relative to the kick, trim them together to −16 LUFS before the
 * Limiter, and set the Limiter's input so the master lands on the style's loudness. One render of
 * the whole mix checks it (and corrects the Limiter once when it is off by more than 1 dB). The
 * math is pure (`levelMoves`, `limiterInput`); `autoLevel` does the rendering.
 */
import type { Draft } from 'immer';
import type { Style } from '@core/beat/style';
import { STYLE_LABELS } from '@core/beat/style';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { MASTER, type InsertId, type PatternId, type Project, type Tick } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { songSections } from '@core/query/sections';
import { planStems, playingChannels, stemProject, withoutMasterChain } from '@core/query/stems';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { patternLength } from '@core/query/queries';
import { renderOffline } from '@engine/render-offline';
import { Measurer } from '../analysis/measure';
import { opfsSampleProvider } from '../persistence/project-io';
import type { Services } from '../services';
import { BUS_NAMES, findMixLayout, type BusRole } from './layout';

/** The buses auto-level sets (the returns follow their sends). */
export type LeveledBus = 'kick' | 'drums' | 'bass' | 'chords' | 'lead' | 'fx';
export const LEVELED: readonly LeveledBus[] = ['kick', 'drums', 'bass', 'chords', 'lead', 'fx'];

export interface LevelTarget {
  /** Each bus's loudness relative to the kick bus, in dB. */
  drums: number;
  bass: number;
  chords: number;
  lead: number;
  fx: number;
  /** The master's integrated loudness, LUFS. */
  master: number;
}

export const LEVEL_TARGETS: Readonly<Record<Style, LevelTarget>> = {
  trap: { drums: -2, bass: 1, chords: -7, lead: -4, fx: -8, master: -10 },
  drill: { drums: -1, bass: 1, chords: -6, lead: -4, fx: -8, master: -10 },
  boombap: { drums: 0, bass: -3, chords: -5, lead: -5, fx: -10, master: -11 },
  lofi: { drums: -2, bass: -4, chords: -2, lead: -5, fx: -10, master: -13 },
  house: { drums: -4, bass: -3, chords: -5, lead: -4, fx: -8, master: -9.5 },
  edm: { drums: -4, bass: -3, chords: -5, lead: -4, fx: -8, master: -9.5 },
  reggaeton: { drums: -2, bass: -2, chords: -6, lead: -4, fx: -9, master: -10 },
  afro: { drums: -2, bass: -2, chords: -6, lead: -4, fx: -9, master: -10 },
  pop: { drums: -3, bass: -3, chords: -5, lead: -2, fx: -10, master: -11 },
};

/** Where the buses sum before the master chain. */
export const PRE_LIMITER_LUFS = -16;
/** How far one leveling may move a fader. */
export const MOVE_MIN_DB = -12;
export const MOVE_MAX_DB = 6;
/** The Limiter's input range auto-level uses. */
export const LIMITER_INPUT_MAX_DB = 10;

const offsetOf = (role: LeveledBus, t: LevelTarget) => (role === 'kick' ? 0 : t[role]);
const dbOf = (gain: number) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
const gainOf = (db: number) => Math.pow(10, db / 20);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface BusLevel {
  role: LeveledBus;
  /** Integrated loudness of the bus as it is now (−Infinity: silent). */
  lufs: number;
  /** Its fader now (linear). */
  gain: number;
  /** A fader the AI set itself: it doesn't move. */
  pinned?: boolean;
}

export interface LevelMove {
  role: LeveledBus;
  from: number;
  /** The new fader (linear, at most +5.6 dB). */
  to: number;
  /** Its loudness after the move. */
  lufs: number;
  /** Where the style wants it (LUFS). */
  target: number;
}

export interface LevelPlan {
  moves: LevelMove[];
  /** The trim every bus got so they sum to −16 LUFS (dB). */
  trimDb: number;
  /** The buses' predicted sum (LUFS, adding their powers). */
  sumLufs: number;
}

const powerSum = (lufs: readonly number[]) => {
  const p = lufs.reduce((a, l) => a + (Number.isFinite(l) ? Math.pow(10, l / 10) : 0), 0);
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
};

/**
 * The fader moves that put every bus at its style's level relative to the kick (the first bus
 * present stands in when there is no kick), clamped to −12…+6 dB, then one trim for all of them so
 * they sum to −16 LUFS. Faders stop at +5.6 dB: then the trim stops there for all of them (the
 * balance comes first) and the Limiter's input makes up the rest (`limiterInput(style, sumLufs)`).
 * Pinned buses keep their fader and count in the sum as they are.
 */
export function levelMoves(buses: readonly BusLevel[], style: Style): LevelPlan {
  const t = LEVEL_TARGETS[style];
  const heard = buses.filter((b) => Number.isFinite(b.lufs) && b.gain > 0);
  const ref = LEVELED.map((r) => heard.find((b) => b.role === r)).find((b) => b);
  if (!ref) return { moves: [], trimDb: 0, sumLufs: -Infinity };
  const kick = ref.lufs - offsetOf(ref.role, t);
  const base = heard.map((b) => {
    const target = kick + offsetOf(b.role, t);
    const move = b.pinned ? 0 : clamp(target - b.lufs, MOVE_MIN_DB, MOVE_MAX_DB);
    return { b, target, move };
  });
  const free = base.filter((x) => !x.b.pinned);
  const fixedPower = base.filter((x) => x.b.pinned).reduce((a, x) => a + Math.pow(10, x.b.lufs / 10), 0);
  const room = Math.pow(10, PRE_LIMITER_LUFS / 10) - fixedPower;
  const freeSum = powerSum(free.map((x) => x.b.lufs + x.move));
  let trim = !free.length ? 0 : room > 0 ? clamp(10 * Math.log10(room) - freeSum, -24, 24) : -24;
  for (const x of free) trim = Math.min(trim, dbOf(MAX_INSERT_VOLUME) - dbOf(x.b.gain) - x.move);
  const moves = base.map(({ b, target, move }): LevelMove => {
    const to = b.pinned ? b.gain : Math.min(MAX_INSERT_VOLUME, b.gain * gainOf(move + trim));
    return { role: b.role, from: b.gain, to, lufs: b.lufs + dbOf(to) - dbOf(b.gain), target };
  });
  return { moves, trimDb: trim, sumLufs: powerSum(moves.map((m) => m.lufs)) };
}

/** The Limiter's input gain that brings the buses' sum (−16 LUFS, or what they reach) to the style's loudness (0…10 dB). */
export function limiterInput(style: Style, preLimiterLufs = PRE_LIMITER_LUFS): number {
  return clamp(LEVEL_TARGETS[style].master - preLimiterLufs, 0, LIMITER_INPUT_MAX_DB);
}

/** The master's hard clipper at most this much drive once tamed (dB). */
const TAME_DRIVE_DB = 3;

/**
 * A hard clipper on the master flattens every loud hit of the whole mix, which sounds like static
 * and breaking up: leveling turns it into gentle tape saturation. Returns what it changed.
 */
export function tameMasterClipper(d: Draft<Project>): string[] {
  const out: string[] = [];
  for (const slot of d.mixer.inserts[MASTER]?.fx ?? []) {
    if (slot.plugin.pluginId !== 'agstudio.saturator' || !slot.enabled) continue;
    const params = slot.plugin.params;
    if (params.mode !== 'clip') continue;
    params.mode = 'tape';
    if (typeof params.drive === 'number' && params.drive > TAME_DRIVE_DB) params.drive = TAME_DRIVE_DB;
    out.push(`Master Saturator: hard clip → tape at ${typeof params.drive === 'number' ? params.drive : TAME_DRIVE_DB} dB drive (clipping the whole mix sounds like static)`);
  }
  return out;
}

// ---------------------------------------------------------------- the part to listen to

export interface LevelWindow {
  mode: 'song' | 'pattern';
  patternId: PatternId | null;
  fromTick: Tick;
  bars: number;
}

/** At most this long a window (a slow lo-fi song's 8 bars are 27 s). */
const MAX_SECONDS = 20;

/** The busiest part of the song: the section (or 8 bars) with the most channels playing. */
export function busiestWindow(p: Project, currentPattern: PatternId | null, fromTick?: Tick, bars?: number): LevelWindow | null {
  const bar = ticksPerBar(p.transport.timeSig);
  const end = songLength(p);
  const fit = (mode: 'song' | 'pattern', from: Tick, want: number): number => {
    const tempo = tempoMapOf(p, mode);
    const barSeconds = (tempo.tickToSeconds(from + bar) - tempo.tickToSeconds(from)) || 2;
    return Math.max(1, Math.min(want, Math.floor(MAX_SECONDS / barSeconds)));
  };
  if (end <= 0) {
    const pattern = currentPattern ? p.patterns[currentPattern] : undefined;
    if (!pattern) return null;
    // The pattern on a loop: whole repeats, about 8 bars.
    const len = patternLength(pattern, p.transport.timeSig) / bar;
    const reps = Math.max(1, Math.round(fit('pattern', 0, bars ?? 8) / len));
    return { mode: 'pattern', patternId: pattern.id, fromTick: 0, bars: reps * len };
  }
  if (fromTick !== undefined) {
    const from = Math.max(0, Math.min(fromTick, end - bar));
    return { mode: 'song', patternId: null, fromTick: from, bars: fit('song', from, bars ?? 8) };
  }
  const sections = songSections(p);
  const spans = sections.length
    ? sections.map((s) => ({ from: s.from, to: s.to }))
    : Array.from({ length: Math.ceil(end / (8 * bar)) }, (_, i) => ({ from: i * 8 * bar, to: Math.min(end, (i + 1) * 8 * bar) }));
  let best = spans[0]!;
  let bestScore = -1;
  for (const span of spans) {
    // Within the section's first 8 bars, what plays (every channel counts, notes break ties).
    const to = Math.min(span.to, span.from + 8 * bar);
    const playing = playingChannels(p, { mode: 'song', patternId: null, fromTick: span.from, toTick: to }).size;
    let notes = 0;
    for (const c of Object.values(p.playlist.clips))
      if (c.kind === 'pattern' && c.start < to && c.start + c.length > span.from && !c.muted) {
        const pat = p.patterns[c.patternId];
        if (pat) for (const byCh of Object.values(pat.notes)) notes += Object.keys(byCh).length;
      }
    const score = playing * 10000 + notes;
    if (score > bestScore) {
      bestScore = score;
      best = span;
    }
  }
  const length = Math.max(1, Math.round((Math.min(best.to, best.from + 8 * bar) - best.from) / bar));
  return { mode: 'song', patternId: null, fromTick: best.from, bars: fit('song', best.from, bars ?? length) };
}

// ---------------------------------------------------------------- rendering and measuring

/** Lets the UI breathe between renders (not setTimeout: hidden tabs throttle it to a second). */
const yieldToUi = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
};

export interface AutoLevelOptions {
  style: Style;
  /** The part to listen to (default: the busiest section, 8 bars). */
  fromTick?: Tick;
  bars?: number;
  /** Mixer tracks whose faders the AI set itself (left alone). */
  pinned?: ReadonlySet<InsertId>;
  /** Fold the edit into this undo entry while it is the newest (the AI answer's); null: its own step. */
  entry?: number | null;
  signal?: AbortSignal;
  progress?(label: string, fraction: number): void;
  /**
   * Resolves when nothing is playing. Rendering competes with playback for the CPU (it gets choppy)
   * and the new levels would jump in mid-song, so each render and the edit wait for it. Without it,
   * leveling stops playback first.
   */
  whenQuiet?(): Promise<void>;
  sampleRate?: number;
}

export interface BusReading {
  role: LeveledBus;
  /** Measured before leveling, and where the moves put it (LUFS). */
  before: number;
  after: number;
  /** Its style target (LUFS, relative to the kick as measured). */
  target: number;
  fromDb: number;
  toDb: number;
}

export interface AutoLevelResult {
  message: string;
  changes: string[];
  warnings: string[];
  style: Style;
  buses: BusReading[];
  /** The master as rendered after leveling. */
  master: { lufs: number; truePeakDb: number | null; target: number };
  /** The Limiter's input gain it set (dB), or null without a Limiter. */
  limiterInput: number | null;
}

const RATE = 48000;

/**
 * Levels the project's role mix (see the file comment) as one edit: amended into `entry` when
 * given. Resolves null when there is nothing to level; rejects with an AbortError when stopped.
 */
export async function autoLevel(s: Services, opts: AutoLevelOptions): Promise<AutoLevelResult | null> {
  const rate = opts.sampleRate ?? RATE;
  const style = opts.style;
  const warnings: string[] = [];
  let project = s.doc.getState().project;
  const layout = findMixLayout(project);
  const busIds = LEVELED.map((role) => [role, layout.buses[role]] as const).filter((x): x is [LeveledBus, InsertId] => !!x[1]);
  const window = busiestWindow(project, s.view.getState().currentPatternId, opts.fromTick, opts.bars);
  if (!window) return null;
  const toTick = window.fromTick + window.bars * ticksPerBar(project.transport.timeSig);
  const seconds = (() => {
    const tempo = tempoMapOf(project, window.mode);
    return tempo.tickToSeconds(toTick) - tempo.tickToSeconds(window.fromTick);
  })();
  const frames = Math.round(seconds * rate);
  const engineOpts = { plugins: s.plugins, samples: opfsSampleProvider() };
  const raw = withoutMasterChain(project);
  // Every stem mutes the others (channels outside the buses too); only the buses are rendered.
  const all = planStems(raw, { mode: window.mode, patternId: window.patternId, fromTick: window.fromTick, toTick });
  const stems = all.filter((st) => busIds.some(([, id]) => id === st.insertId));
  // A mix without role buses (built by hand, imported; a track named "Kick" doesn't make one): only
  // its loudness is set, its balance stays. Role leveling needs the buses to carry most of what plays.
  const count = (list: readonly { channels: readonly unknown[] }[]) => list.reduce((n, st) => n + st.channels.length, 0);
  const loudnessOnly = !stems.length || count(stems) < (2 / 3) * count(all);
  if (loudnessOnly && !all.length) return null;
  const steps = loudnessOnly ? 3 : stems.length + 2;
  let step = 0;
  const report = (label: string, f = 0) => opts.progress?.(label, Math.min(1, (step + f) / steps));

  const render = async (p: Project, limiter: boolean, label: string, truePeak: boolean) => {
    await opts.whenQuiet?.();
    opts.signal?.throwIfAborted();
    const r = await renderOffline(p, {
      ...engineOpts,
      view: { mode: window.mode, patternId: window.patternId, loop: null },
      bars: window.bars,
      fromTick: window.fromTick,
      sampleRate: rate,
      tail: 0,
      limiter,
      onProgress: (f) => report(label, f * 0.8),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const start = Math.round((r.preRoll + r.latency) * rate);
    const left = r.buffer.getChannelData(0).subarray(start, start + frames);
    const right = r.buffer.numberOfChannels > 1 ? r.buffer.getChannelData(1).subarray(start, start + frames) : left;
    const m = new Measurer(rate, truePeak);
    for (let i = 0; i < left.length; i += rate) {
      m.push(left, right, i, Math.min(left.length, i + rate));
      await yieldToUi();
      opts.signal?.throwIfAborted();
    }
    step++;
    return m.result();
  };

  if (!opts.whenQuiet) s.engine.stop();
  if (loudnessOnly) return levelLoudness(s, opts, raw, render, warnings);
  const levels: BusLevel[] = [];
  for (const stem of stems) {
    const role = busIds.find(([, id]) => id === stem.insertId)![0];
    const m = await render(stemProject(raw, all, stem), false, BUS_NAMES[role], false);
    const ins = project.mixer.inserts[stem.insertId]!;
    levels.push({ role, lufs: m.silent ? -Infinity : m.lufs, gain: ins.volume, pinned: opts.pinned?.has(stem.insertId) ?? false });
  }
  const plan = levelMoves(levels, style);
  if (!plan.moves.length) return null;

  // One edit: the faders and the Limiter's input.
  const masterFx = project.mixer.inserts[MASTER]?.fx ?? [];
  const limiter = layout.limiter ? masterFx.find((f) => f.id === layout.limiter) : undefined;
  if (!limiter) warnings.push('level mix: the master has no Limiter, so its loudness stays as it is (set up the mix first)');
  // From where the buses sum (−16 LUFS unless the faders ran out of room) to the style's loudness.
  let input = limiter ? limiterInput(style, Math.min(PRE_LIMITER_LUFS, plan.sumLufs)) : null;
  // The answer's undo step (or one of its own, which the correction then joins).
  let entry = opts.entry ?? null;
  const tamed: string[] = [];
  const commit = () => {
    s.history.transact(
      'Level the mix',
      (d) => {
        if (!tamed.length) tamed.push(...tameMasterClipper(d));
        for (const m of plan.moves) {
          const id = layout.buses[m.role];
          if (id && d.mixer.inserts[id] && !opts.pinned?.has(id)) d.mixer.inserts[id]!.volume = m.to;
        }
        if (limiter && input !== null) {
          const slot = d.mixer.inserts[MASTER]?.fx.find((f) => f.id === limiter.id);
          if (slot) slot.plugin.params.input = Math.round(input * 100) / 100;
        }
      },
      entry !== null ? { amend: entry } : {},
    );
    if (entry === null) entry = s.history.status().cursor;
  };
  await opts.whenQuiet?.();
  opts.signal?.throwIfAborted();
  commit();

  // Listen to the result once, and correct the Limiter once when the master is off.
  const target = LEVEL_TARGETS[style].master;
  project = s.doc.getState().project;
  let master = await render(project, true, 'The mix', true);
  if (limiter && input !== null && Number.isFinite(master.lufs) && Math.abs(master.lufs - target) > 1) {
    const corrected = clamp(input + (target - master.lufs), 0, LIMITER_INPUT_MAX_DB);
    if (Math.abs(corrected - input) > 0.05) {
      input = corrected;
      await opts.whenQuiet?.();
      opts.signal?.throwIfAborted();
      commit();
      master = await render(s.doc.getState().project, true, 'The mix', true);
    }
  }
  opts.progress?.('Done', 1);

  const buses: BusReading[] = plan.moves.map((m) => ({
    role: m.role,
    before: levels.find((l) => l.role === m.role)!.lufs,
    after: m.lufs,
    target: m.target,
    fromDb: dbOf(m.from),
    toDb: dbOf(m.to),
  }));
  const fmt = (x: number) => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(1)}`;
  const changes = buses
    .filter((b) => Math.abs(b.toDb - b.fromDb) >= 0.05)
    .map((b) => `${BUS_NAMES[b.role as BusRole]} fader ${fmt(b.fromDb)} → ${fmt(b.toDb)} dB`);
  if (input !== null) changes.push(`Limiter input ${fmt(input)} dB`);
  changes.push(...tamed);
  const tp = master.truePeakDb !== null && Number.isFinite(master.truePeakDb) ? `, true peak ${fmt(master.truePeakDb)} dBTP` : '';
  const message = `Leveled the mix for ${STYLE_LABELS[style].toLowerCase()}: each bus sits at its level around the kick, and the master plays at ${
    Number.isFinite(master.lufs) ? `${fmt(master.lufs)} LUFS` : 'silence'
  } (the target is ${fmt(target)}${tp}).`;
  return {
    message,
    changes,
    warnings,
    style,
    buses,
    master: { lufs: master.lufs, truePeakDb: master.truePeakDb, target },
    limiterInput: input,
  };
}

/**
 * Leveling a mix without role buses: everything that reaches the master moves together (the routes
 * into the master and the channels that play straight into it) so the mix sums to −16 LUFS before
 * the master chain, then the Limiter's input sets the style's loudness. The balance between tracks
 * stays as the musician made it. Without a Limiter only the trim happens.
 */
async function levelLoudness(
  s: Services,
  opts: AutoLevelOptions,
  raw: Project,
  render: (p: Project, limiter: boolean, label: string, truePeak: boolean) => Promise<{ lufs: number; silent: boolean; truePeakDb: number | null }>,
  warnings: string[],
): Promise<AutoLevelResult | null> {
  const style = opts.style;
  const before = await render(raw, false, 'The mix before the master', false);
  if (before.silent || !Number.isFinite(before.lufs)) return null;
  const trimDb = clamp(PRE_LIMITER_LUFS - before.lufs, -24, 6);
  const project = s.doc.getState().project;
  const limiter = findMixLayout(project).limiter;
  let input: number | null = limiter ? limiterInput(style) : null;
  if (!limiter) warnings.push('level mix: the master has no Limiter, so the mix was only trimmed (set up the mix for a Limiter)');
  let entry = opts.entry ?? null;
  const tamed: string[] = [];
  const commit = (trim: number) => {
    const g = gainOf(trim);
    s.history.transact(
      'Level the mix',
      (d) => {
        if (!tamed.length) tamed.push(...tameMasterClipper(d));
        for (const ins of Object.values(d.mixer.inserts))
          for (const r of ins.routes) if (r.to === MASTER) r.level = Math.min(MAX_INSERT_VOLUME, r.level * g);
        for (const ch of Object.values(d.channels))
          if (ch.kind !== 'automation' && ch.output === MASTER) ch.volume = Math.min(MAX_INSERT_VOLUME, ch.volume * g);
        if (limiter && input !== null) {
          const slot = d.mixer.inserts[MASTER]?.fx.find((f) => f.id === limiter);
          if (slot) slot.plugin.params.input = Math.round(input * 100) / 100;
        }
      },
      entry !== null ? { amend: entry } : {},
    );
    if (entry === null) entry = s.history.status().cursor;
  };
  await opts.whenQuiet?.();
  opts.signal?.throwIfAborted();
  commit(trimDb);

  const target = LEVEL_TARGETS[style].master;
  let master = await render(s.doc.getState().project, true, 'The mix', true);
  if (limiter && input !== null && Number.isFinite(master.lufs) && Math.abs(master.lufs - target) > 1) {
    const corrected = clamp(input + (target - master.lufs), 0, LIMITER_INPUT_MAX_DB);
    if (Math.abs(corrected - input) > 0.05) {
      input = corrected;
      await opts.whenQuiet?.();
      opts.signal?.throwIfAborted();
      commit(0);
      master = await render(s.doc.getState().project, true, 'The mix', true);
    }
  }
  // Still too loud with the Limiter's input at 0 dB: something before it (a clipper, a hot saturator) pushes it.
  if (Number.isFinite(master.lufs) && master.lufs > target + 2)
    warnings.push(
      `level mix: the master still plays at ${master.lufs.toFixed(1)} LUFS: an effect on the master before the Limiter (a clipper or saturator with a lot of drive) is pushing it; lower its drive`,
    );
  opts.progress?.('Done', 1);
  const fmt = (x: number) => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(1)}`;
  const changes = [`Everything into the master ${fmt(trimDb)} dB (the balance between tracks stays)`];
  if (input !== null) changes.push(`Limiter input ${fmt(input)} dB`);
  changes.push(...tamed);
  const tp = master.truePeakDb !== null && Number.isFinite(master.truePeakDb) ? `, true peak ${fmt(master.truePeakDb)} dBTP` : '';
  return {
    message: `Set the loudness for ${STYLE_LABELS[style].toLowerCase()}: the mix was ${fmt(before.lufs)} LUFS going into the master, and now plays at ${
      Number.isFinite(master.lufs) ? `${fmt(master.lufs)} LUFS` : 'silence'
    } (the target is ${fmt(target)}${tp}). Your balance between tracks is unchanged.`,
    changes,
    warnings,
    style,
    buses: [],
    master: { lufs: master.lufs, truePeakDb: master.truePeakDb, target },
    limiterInput: input,
  };
}
