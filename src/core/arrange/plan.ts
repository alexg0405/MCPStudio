/**
 * The arrangement plan: from sections (what plays, how long, at what energy) to everything the song
 * needs, without touching the project. Each section's beats are laid out as clips back to back (one
 * lane per source pattern); the phrase rules and the transitions add changes (fills, small changes,
 * gaps, builds), which become each clip's variant steps; the transitions add FX sounds, crashes and
 * automation, each on its own lanes so nothing overlaps; markers name the sections.
 */
import { ticksPerBar } from '../time/ppq';
import type { Style } from '../beat/style';
import type { ChannelId, PatternId, Project, Tick, VariantKind, VariantStep } from '../model/types';
import { capabilities, type VariantEnv } from './fills';
import { lengthOfPattern, type NoteSet } from './notes';
import { FILL_ROTATION, phraseEvents, type PhraseEvent, type SectionCaps } from './phrases';
import { isBassRole, isDrumRole, noteRole } from './roles';
import { layoutSections, type SectionSpan, type SectionSpec } from './sections';
import {
  boundaryRecipe,
  classifyBoundary,
  defaultEnding,
  endingRecipe,
  type AutomationItem,
  type BoundaryRecipe,
  type EndingKind,
  type EndingRecipe,
  type FxLevel,
  type FxPlacement,
} from './transitions';
import { FILL_KINDS, applySteps, normalizeStep, sortSteps, variantSeed } from './variants';

const BEAT = 960;

export interface ArrangeRequest {
  /** Where the first section starts. */
  from: Tick;
  style: Style;
  sections: SectionSpec[];
  fx: FxLevel;
  ending: 'auto' | EndingKind;
}

export interface PlanEnv {
  variant: VariantEnv;
  /** How long a crash hit rings (seconds), for its lane. */
  crashSeconds?: number;
}

/** A clip of a source pattern; `steps` (pattern ticks) make it a variant, none = the source itself. */
export interface PlannedClip {
  source: PatternId;
  start: Tick;
  length: Tick;
  steps: VariantStep[];
  section: number;
}

export interface PlannedFx extends FxPlacement {
  length: Tick;
  lane: string;
}

export interface PlannedCrash {
  at: Tick;
  velocity: number;
  lane: string;
}

export interface PlannedAutomation extends AutomationItem {
  lane: string;
}

export interface ArrangementPlan {
  from: Tick;
  to: Tick;
  style: Style;
  barTicks: Tick;
  sections: SectionSpan[];
  /** The boundary into each section (the first one is the intro). */
  boundaries: BoundaryRecipe[];
  ending: EndingRecipe;
  clips: PlannedClip[];
  fx: PlannedFx[];
  crashes: PlannedCrash[];
  automation: PlannedAutomation[];
  markers: { name: string; tick: Tick }[];
  /** Crash hits at the very start of a loop (they would crash every loop): moved into placed crashes. */
  loopCrashes: { patternId: PatternId; channelId: ChannelId; ticks: Tick[] }[];
  counts: { fills: number; builds: { riser: boolean; gap: boolean; impact: boolean }[]; breakdowns: number };
}

/** A song-wide change (song ticks) and which section it belongs to. */
export interface SongEvent extends Omit<PhraseEvent, 'why'> {
  section: number;
  why: PhraseEvent['why'];
}

/** Kinds that add notes on one instrument: they go to one clip; the drums of the others make room. */
const ADDS: ReadonlySet<VariantKind> = new Set(['snare-fill', 'tom-fill', 'hat-fill', 'kick-fill', 'snare-build', 'hat-roll', 'open-hat']);

export const FX_LANE: Record<FxPlacement['kind'], string> = {
  riser: 'FX risers',
  'reverse-crash': 'FX swells',
  downlifter: 'FX swells',
  whoosh: 'FX swells',
  impact: 'FX hits',
  'sub-drop': 'FX sub',
};
export const CRASH_LANE = 'Crashes';
export const AUTOMATION_LANE = 'Automation';

/** Lane names by group, so clips placed on one never overlap ("FX swells", "FX swells 2"…). */
export class LaneAllocator {
  private readonly busy = new Map<string, [Tick, Tick][]>();
  constructor(private readonly numbered: ReadonlySet<string> = new Set([AUTOMATION_LANE])) {}

  /** Marks a span busy on a lane (clips already there). */
  occupy(lane: string, start: Tick, end: Tick): void {
    const list = this.busy.get(lane) ?? [];
    list.push([start, end]);
    this.busy.set(lane, list);
  }

  place(group: string, start: Tick, end: Tick): string {
    for (let i = 1; i < 100; i++) {
      const name = this.numbered.has(group) ? `${group} ${i}` : i === 1 ? group : `${group} ${i}`;
      const list = this.busy.get(name) ?? [];
      if (list.every(([a, b]) => b <= start || a >= end)) {
        this.occupy(name, start, end);
        return name;
      }
    }
    return `${group} 99`;
  }
}

interface Content {
  drums: number;
  hats: number;
  bass808: number;
  bassAny: number;
  caps: SectionCaps;
}

function contentOf(set: NoteSet, env: VariantEnv): Content {
  let drums = 0;
  let hats = 0;
  let bass808 = 0;
  let bassAny = 0;
  for (const [cid, list] of set) {
    const r = env.roles.get(cid) ?? 'other';
    for (const n of list) {
      const nr = noteRole(r, n.key);
      if (isDrumRole(nr)) drums++;
      if (nr === 'hat') hats++;
      if (r === '808') bass808++;
      if (isBassRole(r)) bassAny++;
    }
  }
  return { drums, hats, bass808, bassAny, caps: capabilities(set, env) };
}

const isCrashNote = (env: VariantEnv, cid: ChannelId, key: number) => noteRole(env.roles.get(cid) ?? 'other', key) === 'crash';

/** Crash hits on a pattern's first 1/32 (they'd crash on every loop). */
export function loopStartCrashes(p: Project, pid: PatternId, env: VariantEnv): { channelId: ChannelId; ticks: Tick[] }[] {
  const pat = p.patterns[pid];
  if (!pat) return [];
  const out: { channelId: ChannelId; ticks: Tick[] }[] = [];
  for (const [key, byId] of Object.entries(pat.notes)) {
    const cid = key as ChannelId;
    const ticks = Object.values(byId ?? {})
      .filter((n) => n.tick < 120 && isCrashNote(env, cid, n.key))
      .map((n) => n.tick);
    if (ticks.length) out.push({ channelId: cid, ticks });
  }
  return out;
}

/**
 * Song events → each clip's steps. Fills, builds, rolls and open hats go to the clip with the most
 * drums (or hats) where they land; the other clips' drums make room for a fill. Slides go to clips
 * with an 808; gaps, dropouts, stutters and the whole-section changes go to every clip under them.
 */
export function stepsForClips(
  events: readonly SongEvent[],
  clips: readonly { start: Tick; length: Tick; content: Content; section: number; source: PatternId | string }[],
): VariantStep[][] {
  const out: VariantStep[][] = clips.map(() => []);
  for (const e of events) {
    const under = clips
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.section === e.section && c.start < e.to && c.start + c.length > e.from);
    if (!under.length) continue;
    const part = (i: number, kind: VariantKind) => {
      const c = clips[i]!;
      const from = Math.max(e.from, c.start);
      const to = Math.min(e.to, c.start + c.length);
      const step: VariantStep = { kind, from: from - c.start, to: to - c.start, energy: e.energy };
      if (e.level !== undefined) step.level = e.level;
      if (e.parts?.length) step.parts = [...e.parts];
      const total = e.total ?? e.to - e.from;
      if (kind === 'snare-build' && (from > e.from || to < e.from + total)) {
        step.offset = from - e.from;
        step.total = total;
      }
      out[i]!.push(normalizeStep(step));
    };
    if (ADDS.has(e.kind)) {
      // One source plays it (every clip of that source under it, for a build over several loops).
      const fill = e.kind !== 'hat-roll' && e.kind !== 'open-hat';
      const score = (c: Content) => (fill ? c.drums : c.hats);
      const best = [...under].sort((a, b) => score(b.c.content) - score(a.c.content) || a.i - b.i)[0]!;
      if (score(best.c.content) === 0) continue;
      for (const u of under) {
        if (u.c.source === best.c.source) part(u.i, e.kind);
        else if (fill && u.c.content.drums > 0) part(u.i, 'clear-drums');
      }
      continue;
    }
    if (e.kind === 'slide') {
      for (const u of under) if (u.c.content.bass808 > 0) part(u.i, 'slide');
      continue;
    }
    for (const u of under) part(u.i, e.kind);
  }
  return out.map(sortSteps);
}

const cleanWithout = (parts: readonly string[]) => parts.filter((x) => x.trim()).map((x) => x.trim());

/** Plans an arrangement. Pure: reads the project (or a draft of it) and returns what to write. */
export function planArrangement(p: Project, req: ArrangeRequest, env: PlanEnv): ArrangementPlan {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const bpb = ts.num * (4 / ts.den);
  const bpm = p.transport.bpm;
  const ctx = { bpm, beatsPerBar: bpb, barTicks: bar, style: req.style, fx: req.fx };
  const sections = layoutSections(
    req.sections.map((x) => ({ ...x, play: [...new Set(x.play)] })),
    req.from,
    bar,
  );
  const venv = env.variant;
  const rotation = { fill: 0 };

  // Each source's "home" energy: the loudest section that plays it. Quieter sections play it thinner.
  const home = new Map<PatternId, number>();
  for (const s of sections) for (const pid of s.play) home.set(pid, Math.max(home.get(pid) ?? 0, s.energy));

  // What each section's patterns hold once its whole-section changes (left-out parts, thinner drums) apply.
  const sectionWide = (s: SectionSpan, pid: PatternId): VariantStep[] => {
    const len = lengthOfPattern(p, pid);
    const steps: VariantStep[] = [];
    const without = cleanWithout(s.without);
    if (without.length) steps.push({ kind: 'without', from: 0, to: len, parts: without });
    const thin = thinLevel(s, home.get(pid) ?? s.energy);
    if (thin) steps.push({ kind: 'thin', from: 0, to: len, level: thin });
    return steps;
  };
  const contentCache = new Map<string, Content>();
  const content = (s: SectionSpan, pid: PatternId): Content => {
    const steps = sectionWide(s, pid);
    const key = `${pid}|${JSON.stringify(steps)}`;
    let c = contentCache.get(key);
    if (!c) {
      const pat = p.patterns[pid];
      const set = pat
        ? applySteps(pat.notes, steps, venv, { seed: variantSeed(pat.name, steps), length: lengthOfPattern(p, pid) }).set
        : new Map();
      contentCache.set(key, (c = contentOf(set, venv)));
    }
    return c;
  };
  const capsOf = (s: SectionSpan): SectionCaps => {
    const caps: SectionCaps = { drums: false, hats: false, openHat: false, slide: false };
    for (const pid of s.play) {
      const c = content(s, pid).caps;
      caps.drums ||= c.drums;
      caps.hats ||= c.hats;
      caps.openHat ||= c.openHat;
      caps.slide ||= c.slide;
    }
    return caps;
  };
  const loopBarsOf = (s: SectionSpan) => {
    let best = 0;
    for (const pid of s.play) {
      const c = content(s, pid);
      if (!c.drums && !c.bassAny) continue;
      const bars = lengthOfPattern(p, pid) / bar;
      if (bars > 0 && (best === 0 || bars < best)) best = bars;
    }
    return best;
  };

  // Transitions first (they own each section's last bars), then the phrase rules inside sections.
  const boundaries: BoundaryRecipe[] = sections.map((b, i) => {
    const a = i > 0 ? sections[i - 1]! : null;
    const kind = classifyBoundary(a, b);
    return boundaryRecipe(kind, b.from, a ? { ...a, caps: capsOf(a) } : null, b, ctx, rotation);
  });
  const last = sections[sections.length - 1];
  const endingKind: EndingKind = req.ending === 'auto' ? defaultEnding(req.style) : req.ending;
  const ending = last
    ? endingRecipe(endingKind, last, ctx)
    : { kind: endingKind, end: [], fx: [], crash: null, automation: [] };

  const events: SongEvent[] = [];
  const phraseCrashes: Tick[] = [];
  sections.forEach((s, i) => {
    const out = i + 1 < sections.length ? boundaries[i + 1]!.end : ending.end;
    const caps = capsOf(s);
    const res = phraseEvents(
      {
        bars: s.bars,
        barTicks: bar,
        energy: s.energy,
        style: req.style,
        vary: s.vary,
        fill: s.fill,
        caps,
        loopBars: loopBarsOf(s),
        index: i,
        without: [],
        thin: 0,
      },
      out,
      rotation,
    );
    for (const e of res.events) events.push({ ...e, from: e.from + s.from, to: e.to + s.from, section: i });
    for (const t of res.crashes) phraseCrashes.push(t + s.from);
  });
  rotateFills(events, sections, req.style);

  // Clips: each source back to back over its section (the last one cut at the section's end).
  const layout: { source: PatternId; start: Tick; length: Tick; content: Content; section: number; wide: VariantStep[] }[] = [];
  for (const s of sections)
    for (const pid of s.play) {
      const len = lengthOfPattern(p, pid);
      if (len <= 0) continue;
      const wide = sectionWide(s, pid);
      for (let at = s.from; at < s.to; at += len)
        layout.push({ source: pid, start: at, length: Math.min(len, s.to - at), content: content(s, pid), section: s.index, wide });
    }
  const perClip = stepsForClips(events, layout);
  const clips: PlannedClip[] = layout.map((c, i) => ({
    source: c.source,
    start: c.start,
    length: c.length,
    section: c.section,
    steps: sortSteps([...c.wide.map((w) => normalizeStep({ ...w, to: Math.min(w.to, c.length) })), ...perClip[i]!]),
  }));

  // FX, crashes and automation, each on lanes where nothing overlaps.
  const lanes = new LaneAllocator();
  const fx: PlannedFx[] = [];
  for (const f of [...boundaries.flatMap((b) => b.fx), ...ending.fx].sort((a, b) => a.start - b.start)) {
    const length = Math.round(f.beats * BEAT);
    if (f.start < 0) continue;
    fx.push({ ...f, length, lane: lanes.place(FX_LANE[f.kind], f.start, f.start + length) });
  }
  const crashTicks = Math.round(((env.crashSeconds ?? 2.6) * bpm * BEAT) / 60);
  const accepted: { at: Tick; velocity: number }[] = [];
  const tryCrash = (at: Tick, velocity: number) => {
    if (accepted.some((c) => Math.abs(c.at - at) < 4 * bar)) return;
    accepted.push({ at, velocity });
  };
  boundaries.forEach((b) => b.crash !== null && tryCrash(b.at, b.crash));
  if (ending.crash) tryCrash(ending.crash.at, ending.crash.velocity);
  for (const at of phraseCrashes) tryCrash(at, 0.8);
  const crashes = accepted
    .sort((a, b) => a.at - b.at)
    .map((c) => ({ ...c, lane: lanes.place(CRASH_LANE, c.at, c.at + crashTicks) }));
  const automation: PlannedAutomation[] = [];
  const byTarget = new Map<string, [Tick, Tick][]>();
  for (const item of [...boundaries.flatMap((b) => b.automation), ...ending.automation].sort((a, b) => a.start - b.start)) {
    const key = JSON.stringify(item.target);
    const spans = byTarget.get(key) ?? [];
    if (item.start < 0 || spans.some(([a, b]) => a < item.start + item.length && item.start < b)) continue;
    spans.push([item.start, item.start + item.length]);
    byTarget.set(key, spans);
    automation.push({ ...item, lane: lanes.place(AUTOMATION_LANE, item.start, item.start + item.length) });
  }

  const loopCrashes: ArrangementPlan['loopCrashes'] = [];
  const seen = new Set<PatternId>();
  for (const s of sections)
    for (const pid of s.play) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const c of loopStartCrashes(p, pid, venv)) loopCrashes.push({ patternId: pid, ...c });
    }

  return {
    from: req.from,
    to: sections.length ? sections[sections.length - 1]!.to : req.from,
    style: req.style,
    barTicks: bar,
    sections,
    boundaries,
    ending,
    clips,
    fx,
    crashes,
    automation,
    markers: sections.map((s) => ({ name: s.name, tick: s.from })),
    loopCrashes,
    counts: {
      fills: events.filter((e) => FILL_KINDS.has(e.kind) && e.kind !== 'snare-build').length,
      builds: boundaries
        .filter((b) => b.kind === 'rise')
        .map((b) => ({
          riser: b.fx.some((f) => f.kind === 'riser'),
          gap: b.end.some((e) => e.kind === 'gap'),
          impact: b.fx.some((f) => f.kind === 'impact'),
        })),
      breakdowns: boundaries.filter((b) => b.kind === 'fall').length,
    },
  };
}

/** Fills in song order take the style's rotation in turn (sections that chose a fill keep it). */
function rotateFills(events: SongEvent[], sections: readonly SectionSpan[], style: Style): void {
  const list = FILL_ROTATION[style];
  let k = 0;
  for (const e of [...events].sort((a, b) => a.from - b.from)) {
    if (!FILL_KINDS.has(e.kind) || e.kind === 'snare-build' || sections[e.section]?.fill !== 'auto') continue;
    e.kind = list[k++ % list.length]!;
  }
}

/** How thin a section plays a beat whose loudest section is `home`: 2 energy below thins it, 3 makes it sparse. */
export function thinLevel(s: Pick<SectionSpec, 'energy' | 'vary'>, home: number): number {
  if (s.vary === 'none') return 0;
  const d = home - s.energy;
  return d >= 3 ? 2 : d >= 2 ? 1 : 0;
}
