/**
 * Writing arrangements into the project (inside a History recipe): variants of the source patterns,
 * clips on named lanes, transition sounds on audio clip channels that follow the tempo, crash hits,
 * automation curves (one channel per purpose, control and length, reused), markers. Also the
 * in-place edits `develop`, `transition` and `vary` make to an existing song (clips re-pointed to
 * variants, looping clips split so one repeat can change alone), rebuilding variants whose source
 * changed, and removing what the arranger made that nothing uses any more. Plain loops on the
 * draft throughout (memoized queries would go stale).
 */
import type { Draft } from 'immer';
import { resolveTarget, type SpecsResolver } from '../automation/targets';
import { fxLabel, fxName, fxSampleRef, parseFxName, type FxKind } from '../model/fx';
import { makeLane, paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import { targetKey } from '../model/targets';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type AutomationChannel,
  type AutomationClip,
  type AutoPoint,
  type ChannelId,
  type Clip,
  type ClipId,
  type InsertId,
  type LaneId,
  type ParamTarget,
  type Pattern,
  type PatternClip,
  type PatternId,
  type Project,
  type SampleRef,
  type SlotId,
  type Tick,
  type VariantStep,
} from '../model/types';
import { addMarker, removeMarker } from '../ops/markers';
import { addClips, addPattern, clearRange, splitClip } from '../ops/playlist';
import { removeChannel } from '../ops/channels';
import type { TempoMap } from '../time/ppq';
import type { VariantEnv } from './fills';
import { lengthOfPattern, notesHash, setHash, toNoteMap, toNoteSet } from './notes';
import type { ArrangementPlan, PlannedAutomation, PlannedCrash, PlannedFx, SongEvent } from './plan';
import { eventSpan, LaneAllocator, stepsForClips } from './plan';
import { isDrumRole, noteRole } from './roles';
import type { AutomationItem, AutomationPurpose, AutomationTarget } from './transitions';
import { applySteps, mergeSteps, normalizeStep, variantKey, variantName, variantSeed } from './variants';

/** What writing needs beyond the plan: the variant env, the automation targets the app found or made, sounds. */
export interface ApplyEnv {
  variant: VariantEnv;
  specsOf: SpecsResolver;
  /** The tempo map of the song (splitting audio clips at the edges of a cleared range). */
  tempo: TempoMap;
  targets: SweepTargets;
  /** The crash sound for crash hits, where it plays and how loud (default: the kit crash on the master). */
  crash?: { sample: SampleRef; output: InsertId; volume: number };
  /** Where FX sounds play (the FX bus). */
  fxOutput?: InsertId;
  /** Seconds a built-in sample lasts (crash hits), when known. */
  sampleSeconds?(ref: SampleRef): number | null;
}

/** The controls the arranger's curves move: EQ Pro bands on the chords and lead buses, the reverb send. */
export interface SweepTargets {
  chords?: { insertId: InsertId; slotId: SlotId };
  lead?: { insertId: InsertId; slotId: SlotId };
  /** The chords bus's send to the reverb return. */
  throw?: { from: InsertId; to: InsertId };
}

export interface ApplyReport {
  variants: number;
  clips: number;
  fx: number;
  crashes: number;
  automation: number;
  /** Clips that were there before and got replaced. */
  replaced: number;
  movedCrashes: { patternId: PatternId; count: number }[];
}

const EQ_BAND: Record<'low-cut' | 'high-cut', string> = { 'low-cut': 'b1Freq', 'high-cut': 'b8Freq' };

// ---------------------------------------------------------------------------------------------
// Variants

const isUnmodified = (pat: Pattern): boolean => !!pat.derived && notesHash(pat.notes) === pat.derived.hash;

/** The pattern a clip's pattern varies (an unmodified variant's source), and the steps it already has. */
export function rootOf(p: Project, pid: PatternId): { root: PatternId; steps: VariantStep[] } {
  const pat = p.patterns[pid];
  if (pat?.derived && p.patterns[pat.derived.from] && isUnmodified(pat))
    return { root: pat.derived.from, steps: pat.derived.steps.map(normalizeStep) };
  return { root: pid, steps: [] };
}

function uniqueName(d: Draft<Project>, name: string, except?: PatternId): string {
  const taken = new Set(Object.values(d.patterns).filter((x) => x.id !== except).map((x) => x.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

const channelNamer = (d: Draft<Project>) => (id: string) => d.channels[id as ChannelId]?.name;

/**
 * The variant of `sourceId` with `steps`: an existing one (rebuilt if its source changed since),
 * else a new pattern after the source. Steps that change nothing are left out; with none left the
 * source itself is the answer.
 */
export function deriveVariant(d: Draft<Project>, sourceId: PatternId, steps: readonly VariantStep[], env: VariantEnv): PatternId {
  const p = d as unknown as Project;
  const source = p.patterns[sourceId];
  if (!source || steps.length === 0) return sourceId;
  const length = lengthOfPattern(p, sourceId);
  const seed0 = variantSeed(source.name, steps);
  const { effective } = applySteps(source.notes, steps, env, { seed: seed0, length });
  if (!effective.length) return sourceId;
  const key = variantKey(sourceId, effective);
  for (const pid of d.patternOrder) {
    const pat = p.patterns[pid];
    if (!pat?.derived || pat.derived.from !== sourceId || !isUnmodified(pat)) continue;
    if (variantKey(sourceId, pat.derived.steps) !== key) continue;
    rebuild(d, pid, env);
    return pid;
  }
  const seed = variantSeed(source.name, effective);
  const { set } = applySteps(source.notes, effective, env, { seed, length });
  const id = newId.pattern();
  // After the source and its other variants.
  let at = d.patternOrder.indexOf(sourceId) + 1;
  while (at < d.patternOrder.length && p.patterns[d.patternOrder[at]!]?.derived?.from === sourceId) at++;
  const pattern: Pattern = {
    id,
    name: uniqueName(d, variantName(source.name, effective, channelNamer(d))),
    color: source.color,
    stepCount: source.stepCount,
    length,
    notes: toNoteMap(set),
    derived: { from: sourceId, steps: effective.map(normalizeStep), seed, hash: setHash(set) },
  };
  addPattern(d, pattern, at);
  return id;
}

/** Rebuilds an unmodified variant from its source's current notes; true when its notes changed. */
function rebuild(d: Draft<Project>, pid: PatternId, env: VariantEnv): boolean {
  const p = d as unknown as Project;
  const pat = d.patterns[pid];
  const der = pat?.derived;
  const source = der ? p.patterns[der.from] : undefined;
  if (!pat || !der || !source) return false;
  const length = lengthOfPattern(p, der.from);
  const { set } = applySteps(source.notes, der.steps, env, { seed: der.seed, length });
  const hash = setHash(set);
  if (pat.length !== length) pat.length = length;
  if (pat.stepCount !== source.stepCount) pat.stepCount = source.stepCount;
  if (hash === der.hash) return false;
  pat.notes = toNoteMap(set) as never;
  der.hash = hash;
  return true;
}

/**
 * Rebuilds the variants of `sources` (default: every source) from their sources' notes. Variants
 * edited by hand (notes no longer match their hash) are left alone and reported.
 */
export function refreshVariants(
  d: Draft<Project>,
  env: VariantEnv,
  sources?: ReadonlySet<PatternId>,
): { rebuilt: PatternId[]; handEdited: PatternId[] } {
  const p = d as unknown as Project;
  const rebuilt: PatternId[] = [];
  const handEdited: PatternId[] = [];
  for (const pid of [...d.patternOrder]) {
    const pat = p.patterns[pid];
    if (!pat?.derived || !p.patterns[pat.derived.from]) continue;
    if (sources && !sources.has(pat.derived.from)) continue;
    if (!isUnmodified(pat)) {
      handEdited.push(pid);
      continue;
    }
    if (rebuild(d, pid, env)) rebuilt.push(pid);
  }
  return { rebuilt, handEdited };
}

// ---------------------------------------------------------------------------------------------
// Lanes

const DEFAULT_LANE = /^Track \d+$/;

/** A lane by name: the one with that name, else the first empty "Track N", else a new one. */
export function laneNamed(d: Draft<Project>, name: string): LaneId {
  for (const id of d.playlist.laneOrder) if (d.playlist.lanes[id]?.name === name) return id;
  const used = new Set(Object.values(d.playlist.clips).map((c) => c.laneId));
  for (const id of d.playlist.laneOrder) {
    const lane = d.playlist.lanes[id];
    if (lane && !used.has(id) && DEFAULT_LANE.test(lane.name)) {
      lane.name = name.slice(0, 64);
      return id;
    }
  }
  const lane = makeLane(name.slice(0, 64));
  d.playlist.lanes[lane.id] = lane;
  d.playlist.laneOrder.push(lane.id);
  return lane.id;
}

// ---------------------------------------------------------------------------------------------
// Sounds, crashes, automation

/** The audio clip channel playing an FX sound (one per sound, reused). */
function fxChannel(d: Draft<Project>, kind: FxKind, beats: number, bpm: number, env: ApplyEnv): ChannelId {
  const generator = fxName(kind, beats, bpm);
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (ch?.kind !== 'audioClip') continue;
    const src = d.samples[ch.sampleId]?.source;
    if (src?.kind === 'builtin' && src.generator === generator) return cid;
  }
  const ref = fxSampleRef(kind, beats, bpm);
  d.samples[ref.id] = ref;
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: fxLabel(kind, beats),
    color: '#8c9aa8',
    muted: false,
    solo: false,
    volume: 0.7,
    pan: 0,
    output: env.fxOutput && d.mixer.inserts[env.fxOutput] ? env.fxOutput : MASTER,
    sampleId: ref.id,
    stretch: 'resample',
    sourceBpm: bpm,
  };
  d.channels[channel.id] = channel;
  d.channelOrder.push(channel.id);
  return channel.id;
}

const CRASH_NAME = 'Crash hits';

function crashChannel(d: Draft<Project>, env: ApplyEnv): ChannelId {
  const sample = env.crash?.sample;
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (ch?.kind === 'audioClip' && ch.name === CRASH_NAME) return cid;
  }
  const ref: SampleRef = sample ?? { id: newId.sample(), name: 'Crash', source: { kind: 'builtin', generator: 'kit/crash', version: 1 } };
  if (!d.samples[ref.id]) d.samples[ref.id] = ref;
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: CRASH_NAME,
    color: '#c9a24a',
    muted: false,
    solo: false,
    volume: env.crash?.volume ?? 0.55,
    pan: 0,
    output: env.crash?.output && d.mixer.inserts[env.crash.output] ? env.crash.output : MASTER,
    sampleId: ref.id,
  };
  d.channels[channel.id] = channel;
  d.channelOrder.push(channel.id);
  return channel.id;
}

const dbGain = (db: number) => Math.min(4, Math.pow(10, db / 20));

export function placeFx(d: Draft<Project>, items: readonly PlannedFx[], env: ApplyEnv): ClipId[] {
  const bpm = d.transport.bpm;
  const out: ClipId[] = [];
  for (const f of items) {
    const channelId = fxChannel(d, f.kind, f.beats, bpm, env);
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId: laneNamed(d, f.lane),
      start: Math.max(0, Math.round(f.start)),
      length: Math.max(1, Math.round(f.length)),
      channelId,
      offsetSec: 0,
    };
    const gain = dbGain(f.gainDb);
    if (Math.abs(gain - 1) > 1e-9) clip.gain = gain;
    addClips(d, [clip]);
    out.push(clip.id);
  }
  return out;
}

export function placeCrashes(d: Draft<Project>, items: readonly PlannedCrash[], env: ApplyEnv): ClipId[] {
  if (!items.length) return [];
  const channelId = crashChannel(d, env);
  const ch = d.channels[channelId] as Draft<AudioClipChannel>;
  const ref = d.samples[ch.sampleId] as SampleRef | undefined;
  const seconds = (ref && env.sampleSeconds?.(ref)) ?? 2.6;
  const ticks = Math.max(1, Math.round((seconds * d.transport.bpm * 960) / 60));
  const out: ClipId[] = [];
  for (const c of items) {
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId: laneNamed(d, c.lane),
      start: Math.max(0, Math.round(c.at)),
      length: ticks,
      channelId,
      offsetSec: 0,
    };
    if (Math.abs(c.velocity - 1) > 1e-9) clip.gain = Math.max(0, Math.min(1, c.velocity));
    addClips(d, [clip]);
    out.push(clip.id);
  }
  return out;
}

const PURPOSE_LABEL: Record<AutomationPurpose, string> = {
  'sweep-up': 'Sweep up',
  'filter-open': 'Filter open',
  'intro-open': 'Intro filter',
  throw: 'Reverb throw',
  fade: 'Fade out',
};

/** Automation channels the arranger names (only those are removed when nothing plays them). */
export const ARRANGER_AUTOMATION = /^(Sweep up|Filter open|Intro filter|Reverb throw|Fade out) · /;

/** The concrete control a curve moves, or null when the song has no such control. */
export function resolveAutomationTarget(t: AutomationTarget, targets: SweepTargets): ParamTarget | null {
  if (t.kind === 'master') return { kind: 'insert', insertId: MASTER, param: 'volume' };
  if (t.kind === 'throw') return targets.throw ? { kind: 'route', insertId: targets.throw.from, to: targets.throw.to } : null;
  const bus = targets[t.bus];
  if (!bus) return null;
  return { kind: 'plugin', owner: { kind: 'fx', insertId: bus.insertId, slotId: bus.slotId }, paramId: EQ_BAND[t.band] };
}

const busName = (t: AutomationTarget) => (t.kind === 'eq' ? (t.bus === 'chords' ? 'Chords' : 'Lead') : t.kind === 'throw' ? 'Chords' : 'Master');

/** A curve's points normalized for its control ('neutral' = where the control sits). */
export function automationPoints(item: AutomationItem, res: NonNullable<ReturnType<typeof resolveTarget>>): AutoPoint[] {
  const neutral = res.toNormalized(res.base);
  const plain = (v: number | 'neutral' | 'throw'): number => {
    if (v === 'neutral') return neutral;
    if (v === 'throw') {
      // Send 10 dB above where it sits, at least −3 dB, never above 0 dB.
      const base = res.base;
      const db = base > 0 ? 20 * Math.log10(base) : -60;
      return res.toNormalized(Math.min(1, Math.pow(10, Math.max(db + 10, -3) / 20)));
    }
    if (item.purpose === 'sweep-up') return res.toNormalized(Math.max(v, res.base * 2));
    if (item.purpose === 'filter-open' || item.purpose === 'intro-open') return res.toNormalized(Math.min(v, res.base));
    return res.toNormalized(v);
  };
  return item.points.map((pt) => ({
    tick: Math.round(pt.at),
    value: Math.min(1, Math.max(0, plain(pt.value))),
    ...(pt.tension ? { tension: pt.tension } : {}),
  }));
}

const samePoints = (a: readonly AutoPoint[], b: readonly AutoPoint[]) =>
  a.length === b.length &&
  a.every((x, i) => x.tick === b[i]!.tick && Math.abs(x.value - b[i]!.value) < 1e-9 && (x.tension ?? 0) === (b[i]!.tension ?? 0) && (x.shape ?? 'curve') === (b[i]!.shape ?? 'curve'));

/** Automation clips moving the control `key` over [from, to). */
function automationBusy(p: Project, key: string, from: Tick, to: Tick): boolean {
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'automation' || c.muted || c.start >= to || c.start + c.length <= from) continue;
    const ch = p.channels[c.channelId];
    if (ch?.kind === 'automation' && ch.target && targetKey(ch.target) === key) return true;
  }
  return false;
}

/**
 * Places curves (one automation channel per purpose, control and length, reused); skips controls
 * that don't exist, and with `skipBusy` controls already automated there.
 */
export function placeAutomation(
  d: Draft<Project>,
  items: readonly PlannedAutomation[],
  env: ApplyEnv,
  opts: { skipBusy?: boolean } = {},
): ClipId[] {
  const p = d as unknown as Project;
  const out: ClipId[] = [];
  for (const item of items) {
    const target = resolveAutomationTarget(item.target, env.targets);
    if (!target) continue;
    const res = resolveTarget(p, target, env.specsOf);
    if (!res) continue;
    const points = automationPoints(item, res);
    const key = targetKey(target);
    if (opts.skipBusy && automationBusy(p, key, item.start, item.start + item.length)) continue;
    let channelId: ChannelId | undefined;
    for (const cid of d.channelOrder) {
      const ch = p.channels[cid];
      if (ch?.kind === 'automation' && ch.target && targetKey(ch.target) === key && samePoints(ch.points, points)) channelId = cid;
    }
    if (!channelId) {
      const bars = Math.round((item.length / (960 * 4)) * 100) / 100;
      const channel: AutomationChannel = {
        kind: 'automation',
        id: newId.channel(),
        name: `${PURPOSE_LABEL[item.purpose]} · ${busName(item.target)}${item.purpose === 'throw' ? '' : ` (${bars} bar${bars === 1 ? '' : 's'})`}`,
        color: paletteColor(9),
        muted: false,
        solo: false,
        target,
        points,
      };
      d.channels[channel.id] = channel as Draft<AutomationChannel>;
      d.channelOrder.push(channel.id);
      channelId = channel.id;
    }
    const clip: AutomationClip = {
      kind: 'automation',
      id: newId.clip(),
      laneId: laneNamed(d, item.lane),
      start: Math.max(0, Math.round(item.start)),
      length: Math.max(1, Math.round(item.length)),
      channelId,
      offset: 0,
    };
    addClips(d, [clip]);
    out.push(clip.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Whole arrangements

/** What the arranger made that a range's clips use (removed later if nothing else uses them). */
function arrangerThings(p: Project, clips: readonly Clip[]): { patterns: Set<PatternId>; channels: Set<ChannelId> } {
  const patterns = new Set<PatternId>();
  const channels = new Set<ChannelId>();
  for (const c of clips) {
    if (c.kind === 'pattern') {
      if (p.patterns[c.patternId]?.derived) patterns.add(c.patternId);
      continue;
    }
    const ch = p.channels[c.channelId];
    if (!ch) continue;
    if (ch.kind === 'automation' && ARRANGER_AUTOMATION.test(ch.name)) channels.add(ch.id);
    if (ch.kind === 'audioClip') {
      const src = p.samples[ch.sampleId]?.source;
      if ((src?.kind === 'builtin' && parseFxName(src.generator)) || ch.name === CRASH_NAME) channels.add(ch.id);
    }
  }
  return { patterns, channels };
}

/**
 * Removes the arranger's things nothing uses any more: variants with no clips (unless edited by
 * hand), FX and crash channels and arranger automation with no clips (and their unused samples).
 */
export function collectGarbage(d: Draft<Project>, candidates: { patterns: Iterable<PatternId>; channels: Iterable<ChannelId> }): { patterns: number; channels: number } {
  const p = d as unknown as Project;
  const used = new Set<string>();
  for (const c of Object.values(p.playlist.clips)) used.add(c.kind === 'pattern' ? c.patternId : c.channelId);
  let patterns = 0;
  let channels = 0;
  for (const pid of candidates.patterns) {
    const pat = p.patterns[pid];
    if (!pat?.derived || used.has(pid) || !isUnmodified(pat) || d.patternOrder.length <= 1) continue;
    delete d.patterns[pid];
    d.patternOrder.splice(d.patternOrder.indexOf(pid), 1);
    patterns++;
  }
  for (const cid of candidates.channels) {
    const ch = p.channels[cid];
    if (!ch || used.has(cid)) continue;
    const sample = ch.kind === 'audioClip' ? ch.sampleId : null;
    removeChannel(d, cid);
    channels++;
    if (sample && !Object.values(p.channels).some((x) => x.kind === 'audioClip' && x.sampleId === sample)) delete d.samples[sample];
  }
  return { patterns, channels };
}

/** Removes loop-start crash hits from source patterns (the plan's crashes play them where they belong). */
export function moveLoopCrashes(d: Draft<Project>, plan: Pick<ArrangementPlan, 'loopCrashes'>): ApplyReport['movedCrashes'] {
  const out: ApplyReport['movedCrashes'] = [];
  for (const m of plan.loopCrashes) {
    const byId = d.patterns[m.patternId]?.notes[m.channelId];
    if (!byId) continue;
    let count = 0;
    for (const [nid, n] of Object.entries(byId)) {
      if (!m.ticks.includes(n.tick)) continue;
      delete byId[nid as keyof typeof byId];
      count++;
    }
    if (!Object.keys(byId).length) delete d.patterns[m.patternId]!.notes[m.channelId];
    if (count) {
      const prev = out.find((x) => x.patternId === m.patternId);
      if (prev) prev.count += count;
      else out.push({ patternId: m.patternId, count });
    }
  }
  return out;
}

/**
 * Writes a plan: clears its range first (`replace`), moves loop-start crashes out of the sources,
 * then the clips (variants derived as needed), FX, crashes, automation and markers; finally removes
 * the arranger's things the cleared range used that nothing plays any more. Returns what it did and
 * the ids of the clips it made.
 */
export function applyArrangement(
  d: Draft<Project>,
  plan: ArrangementPlan,
  env: ApplyEnv,
  opts: { replace: boolean; replaceTo?: Tick },
): ApplyReport & { clipIds: ClipId[] } {
  const p = d as unknown as Project;
  let replaced = 0;
  let old = { patterns: new Set<PatternId>(), channels: new Set<ChannelId>() };
  if (opts.replace) {
    const to = Math.max(plan.to, opts.replaceTo ?? plan.to);
    const inRange = Object.values(p.playlist.clips).filter((c) => c.start < to && c.start + c.length > plan.from);
    old = arrangerThings(p, inRange);
    // The arranger's own sounds and curves that start in the range go whole (their tails ring past its end).
    for (const c of inRange)
      if (c.kind !== 'pattern' && c.start >= plan.from && old.channels.has(c.channelId)) {
        delete d.playlist.clips[c.id];
        replaced++;
      }
    replaced += clearRange(d, plan.from, to, { trim: true, tempo: env.tempo }).removed;
    for (const m of Object.values(p.playlist.markers)) if (m.tick >= plan.from && m.tick < to) removeMarker(d, m.id);
  }
  const movedCrashes = moveLoopCrashes(d, plan);
  const clipIds: ClipId[] = [];
  const variants = new Set<PatternId>();
  const lanes = new Map<PatternId, LaneId>();
  for (const c of plan.clips) {
    if (!p.patterns[c.source]) continue;
    let lane = lanes.get(c.source);
    if (!lane) {
      lane = laneNamed(d, p.patterns[c.source]!.name);
      lanes.set(c.source, lane);
    }
    const pid = deriveVariant(d, c.source, c.steps, env.variant);
    if (pid !== c.source) variants.add(pid);
    const clip: PatternClip = { kind: 'pattern', id: newId.clip(), laneId: lane, start: c.start, length: c.length, patternId: pid, offset: 0 };
    addClips(d, [clip]);
    clipIds.push(clip.id);
  }
  const fx = placeFx(d, plan.fx, env);
  const crashes = placeCrashes(d, plan.crashes, env);
  const automation = placeAutomation(d, plan.automation, env);
  for (const m of plan.markers) addMarker(d, m.tick, m.name);
  collectGarbage(d, old);
  return {
    variants: variants.size,
    clips: clipIds.length,
    fx: fx.length,
    crashes: crashes.length,
    automation: automation.length,
    replaced,
    movedCrashes,
    clipIds: [...clipIds, ...fx, ...crashes, ...automation],
  };
}

// ---------------------------------------------------------------------------------------------
// In place: develop, transition, vary

/** Content tick of a clip at a song tick. */
const contentAt = (c: PatternClip, len: Tick, t: Tick) => (((t - c.start + c.offset) % len) + len) % len;

/** Splits a pattern clip so [from, to) falls in pieces that each play one repeat of the pattern. */
function isolate(d: Draft<Project>, clipId: ClipId, from: Tick, to: Tick, len: Tick, tempo: TempoMap): ClipId[] {
  const c = d.playlist.clips[clipId] as Draft<PatternClip> | undefined;
  if (!c || c.kind !== 'pattern') return [];
  // Wrap points (content tick 0) at or before `from` and every one after it up to `to`.
  const first = from - contentAt(c, len, from);
  const cuts: Tick[] = [];
  for (let t = first; t < to; t += len) if (t > c.start && t < c.start + c.length) cuts.push(t);
  const after = first + Math.ceil((to - first) / len) * len;
  if (after > c.start && after < c.start + c.length) cuts.push(after);
  const pieces: ClipId[] = [clipId];
  let current = clipId;
  for (const t of cuts.sort((a, b) => a - b)) {
    const right = newId.clip();
    splitClip(d, current, t, tempo, right);
    pieces.push(right);
    current = right;
  }
  return pieces.filter((id) => {
    const x = d.playlist.clips[id];
    return !!x && x.start < to && x.start + x.length > from;
  });
}

/** The drum and hat notes a clip's pattern plays (to pick the clip a fill goes to). */
function patternContent(p: Project, pid: PatternId, env: VariantEnv) {
  const pat = p.patterns[pid];
  let drums = 0;
  let hats = 0;
  let bass808 = 0;
  let bassAny = 0;
  for (const [cid, list] of toNoteSet(pat?.notes ?? {})) {
    const r = env.roles.get(cid) ?? 'other';
    for (const n of list) {
      const nr = noteRole(r, n.key);
      if (isDrumRole(nr)) drums++;
      if (nr === 'hat') hats++;
      if (r === '808') bass808++;
      if (r === '808' || r === 'bass') bassAny++;
    }
  }
  return { drums, hats, bass808, bassAny, caps: { drums: drums > 0, hats: hats > 0, openHat: false, slide: bass808 > 0 } };
}

/**
 * Applies song events to the clips under them: each clip (split so one repeat changes alone) gets
 * its own variant carrying the event, merged with the steps it already had. Muted clips and clips
 * on `skipLanes` and the `protect`ed ones are left alone. Returns the clips changed.
 */
export function applyEditsInPlace(
  d: Draft<Project>,
  events: readonly Omit<SongEvent, 'section'>[],
  env: ApplyEnv,
  opts: { lanes?: ReadonlySet<LaneId>; skipLanes?: ReadonlySet<LaneId>; protect?: ReadonlySet<ClipId> } = {},
): ClipId[] {
  const p = d as unknown as Project;
  const changed = new Set<ClipId>();
  for (const e of events) {
    const span = eventSpan(e);
    if (span.to <= span.from) continue;
    const under = () =>
      Object.values(p.playlist.clips).filter(
        (c): c is PatternClip =>
          c.kind === 'pattern' &&
          !c.muted &&
          !!p.patterns[c.patternId] &&
          c.start < span.to &&
          c.start + c.length > span.from &&
          (!opts.lanes || opts.lanes.has(c.laneId)) &&
          !opts.skipLanes?.has(c.laneId) &&
          !opts.protect?.has(c.id),
      );
    // Each clip under the event plays one repeat there.
    for (const c of under()) isolate(d, c.id, span.from, span.to, lengthOfPattern(p, c.patternId), env.tempo);
    const pieces = under();
    if (!pieces.length) continue;
    const clips = pieces.map((c) => {
      const { root } = rootOf(p, c.patternId);
      return { start: c.start, length: c.length, content: patternContent(p, c.patternId, env.variant), section: 0, source: `${c.laneId}|${root}` };
    });
    const parts = stepsForClips([{ ...e, section: 0 }], clips);
    pieces.forEach((c, i) => {
      const add = parts[i]!;
      if (!add.length) return;
      const len = lengthOfPattern(p, c.patternId);
      const offset = contentAt(c, len, c.start);
      // Steps from stepsForClips are relative to the clip's start; shift them to content ticks.
      const shifted = add.map((s) => normalizeStep({ ...s, from: s.from + offset, to: Math.min(len, s.to + offset) }));
      const { root, steps } = rootOf(p, c.patternId);
      const next = deriveVariant(d, root, mergeSteps(steps, shifted), env.variant);
      if (next !== c.patternId) {
        (d.playlist.clips[c.id] as Draft<PatternClip>).patternId = next;
        changed.add(c.id);
      }
    });
  }
  return [...changed];
}

/** Free lanes of a group for new FX, crashes and automation next to what is already on the song. */
export function laneAllocatorFor(p: Project): LaneAllocator {
  const lanes = new LaneAllocator();
  const names = new Map(p.playlist.laneOrder.map((id) => [id, p.playlist.lanes[id]?.name ?? '']));
  for (const c of Object.values(p.playlist.clips)) lanes.occupy(names.get(c.laneId) ?? '', c.start, c.start + c.length);
  return lanes;
}

