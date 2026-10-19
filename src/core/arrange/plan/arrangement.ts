import { ticksPerBar } from '../../time/ppq';
import type { PatternId, Project, Tick, VariantStep } from '../../model/types';
import { lengthOfPattern } from '../notes';
import { phraseEvents } from '../phrases';
import { layoutSections, type SectionSpan } from '../sections';
import {
  boundaryRecipe,
  classifyBoundary,
  defaultEnding,
  endingRecipe,
  type BoundaryContext,
  type BoundaryRecipe,
  type EndingKind,
  type EndingRecipe,
} from '../transitions';
import { normalizeStep, sortSteps } from '../variants';
import { stepsForClips, type ClipForSteps } from './clip-steps';
import {
  CrashPicker,
  DEFAULT_CRASH_SECONDS,
  PHRASE_CRASH_VELOCITY,
  crashLengthTicks,
  loopStartCrashes,
} from './crashes';
import { AUTOMATION_LANE, LaneAllocator } from './lanes';
import { SectionContent } from './section-content';
import { automationOfTransitions, fxOfTransitions, placeFxSound, planCounts, rotateFills } from './transition-items';
import type {
  ArrangeRequest,
  ArrangementPlan,
  PlanEnv,
  PlannedAutomation,
  PlannedClip,
  PlannedFx,
  SongEvent,
} from './types';

/** A clip of a section's pattern before it becomes a planned clip. */
interface LaidOutClip extends ClipForSteps {
  source: PatternId;
  /** The whole-section steps every clip of this pattern in this section carries. */
  wide: VariantStep[];
}

/** Plans an arrangement. Pure: reads the project (or a draft of it) and returns what to write. */
export function planArrangement(p: Project, req: ArrangeRequest, env: PlanEnv): ArrangementPlan {
  const timeSig = p.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const bpm = p.transport.bpm;
  const context: BoundaryContext = {
    bpm,
    beatsPerBar: timeSig.num * (4 / timeSig.den),
    barTicks,
    style: req.style,
    fx: req.fx,
  };
  const sections = layoutSections(
    req.sections.map((x) => ({ ...x, play: [...new Set(x.play)] })),
    req.from,
    barTicks,
  );
  const content = new SectionContent(p, env.variant, barTicks, sections);
  const rotation = { fill: 0 };

  // Transitions first (they own each section's last bars), then the phrase rules inside sections.
  const boundaries = planBoundaries(sections, content, context, rotation);
  const ending = planEnding(sections, req, context);
  const { events, phraseCrashes } = planPhraseEvents(sections, boundaries, ending, content, req, barTicks, rotation);
  rotateFills(events, sections, req.style);

  const clips = planClips(p, sections, events, content);
  // FX, crashes and automation, each on lanes where nothing overlaps.
  const lanes = new LaneAllocator();
  const fx = planFx(boundaries, ending, lanes);
  const crashLength = crashLengthTicks(env.crashSeconds ?? DEFAULT_CRASH_SECONDS, bpm);
  const crashes = planCrashes(boundaries, ending, phraseCrashes, barTicks).placeOnLanes(lanes, crashLength);
  const automation = planAutomation(boundaries, ending, lanes);

  return {
    from: req.from,
    to: sections.length ? sections[sections.length - 1]!.to : req.from,
    style: req.style,
    barTicks,
    sections,
    boundaries,
    ending,
    clips,
    fx,
    crashes,
    automation,
    markers: sections.map((s) => ({ name: s.name, tick: s.from })),
    loopCrashes: collectLoopCrashes(p, sections, env),
    counts: planCounts(events, boundaries),
  };
}

/** The boundary into each section: its kind, FX, crash and the changes that end the section before it. */
function planBoundaries(
  sections: readonly SectionSpan[],
  content: SectionContent,
  context: BoundaryContext,
  rotation: { fill: number },
): BoundaryRecipe[] {
  return sections.map((b, i) => {
    const a = i > 0 ? sections[i - 1]! : null;
    const kind = classifyBoundary(a, b);
    return boundaryRecipe(kind, b.from, a ? { ...a, caps: content.caps(a) } : null, b, context, rotation);
  });
}

/** How the song ends (a fade or a stop), from the last section; nothing for an empty song. */
function planEnding(sections: readonly SectionSpan[], req: ArrangeRequest, context: BoundaryContext): EndingRecipe {
  const last = sections[sections.length - 1];
  const kind: EndingKind = req.ending === 'auto' ? defaultEnding(req.style) : req.ending;
  if (!last) return { kind, end: [], fx: [], crash: null, automation: [] };
  return endingRecipe(kind, last, context);
}

/** The phrase rules' changes inside every section (song ticks), and the crashes they ask for. */
function planPhraseEvents(
  sections: readonly SectionSpan[],
  boundaries: readonly BoundaryRecipe[],
  ending: EndingRecipe,
  content: SectionContent,
  req: ArrangeRequest,
  barTicks: Tick,
  rotation: { fill: number },
): { events: SongEvent[]; phraseCrashes: Tick[] } {
  const events: SongEvent[] = [];
  const phraseCrashes: Tick[] = [];
  sections.forEach((s, i) => {
    const endChanges = i + 1 < sections.length ? boundaries[i + 1]!.end : ending.end;
    const result = phraseEvents(
      {
        bars: s.bars,
        barTicks,
        energy: s.energy,
        style: req.style,
        vary: s.vary,
        fill: s.fill,
        caps: content.caps(s),
        loopBars: content.loopBars(s),
        index: i,
        without: [],
        thin: 0,
      },
      endChanges,
      rotation,
    );
    for (const e of result.events) events.push({ ...e, from: e.from + s.from, to: e.to + s.from, section: i });
    for (const t of result.crashes) phraseCrashes.push(t + s.from);
  });
  return { events, phraseCrashes };
}

/** Clips: each source back to back over its section (the last one cut at the section's end), with their steps. */
function planClips(
  p: Project,
  sections: readonly SectionSpan[],
  events: readonly SongEvent[],
  content: SectionContent,
): PlannedClip[] {
  const layout: LaidOutClip[] = [];
  for (const s of sections) {
    for (const pid of s.play) {
      const length = lengthOfPattern(p, pid);
      if (length <= 0) continue;
      const wide = content.wideSteps(s, pid);
      for (let at = s.from; at < s.to; at += length) {
        layout.push({
          source: pid,
          start: at,
          length: Math.min(length, s.to - at),
          content: content.content(s, pid),
          section: s.index,
          wide,
        });
      }
    }
  }
  const stepsPerClip = stepsForClips(events, layout);
  return layout.map((c, i) => ({
    source: c.source,
    start: c.start,
    length: c.length,
    section: c.section,
    steps: sortSteps([
      ...c.wide.map((w) => normalizeStep({ ...w, to: Math.min(w.to, c.length) })),
      ...stepsPerClip[i]!,
    ]),
  }));
}

/** FX sounds on lanes where nothing overlaps (sounds before the song starts are dropped). */
function planFx(boundaries: readonly BoundaryRecipe[], ending: EndingRecipe, lanes: LaneAllocator): PlannedFx[] {
  const fx: PlannedFx[] = [];
  for (const sound of fxOfTransitions(boundaries, ending)) {
    if (sound.start < 0) continue;
    fx.push(placeFxSound(sound, lanes));
  }
  return fx;
}

/** The crashes the transitions and the phrase rules ask for, no two within 4 bars. */
function planCrashes(
  boundaries: readonly BoundaryRecipe[],
  ending: EndingRecipe,
  phraseCrashes: readonly Tick[],
  barTicks: Tick,
): CrashPicker {
  const picker = new CrashPicker(barTicks);
  picker.offerTransitions(boundaries, ending);
  for (const at of phraseCrashes) picker.offer(at, PHRASE_CRASH_VELOCITY);
  return picker;
}

/** Automation curves on lanes; a control never has two curves at once (the later one is dropped). */
function planAutomation(
  boundaries: readonly BoundaryRecipe[],
  ending: EndingRecipe,
  lanes: LaneAllocator,
): PlannedAutomation[] {
  const automation: PlannedAutomation[] = [];
  const spansByTarget = new Map<string, [Tick, Tick][]>();
  for (const item of automationOfTransitions(boundaries, ending)) {
    const key = JSON.stringify(item.target);
    const spans = spansByTarget.get(key) ?? [];
    if (item.start < 0 || spans.some(([from, to]) => from < item.start + item.length && item.start < to)) continue;
    spans.push([item.start, item.start + item.length]);
    spansByTarget.set(key, spans);
    automation.push({ ...item, lane: lanes.place(AUTOMATION_LANE, item.start, item.start + item.length) });
  }
  return automation;
}

/** Crash hits at the very start of a source pattern, once per pattern in song order. */
function collectLoopCrashes(
  p: Project,
  sections: readonly SectionSpan[],
  env: PlanEnv,
): ArrangementPlan['loopCrashes'] {
  const loopCrashes: ArrangementPlan['loopCrashes'] = [];
  const seen = new Set<PatternId>();
  for (const s of sections) {
    for (const pid of s.play) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const c of loopStartCrashes(p, pid, env.variant)) loopCrashes.push({ patternId: pid, ...c });
    }
  }
  return loopCrashes;
}
