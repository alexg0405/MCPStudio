/**
 * Plays automation clips: follows the transport's timeline and drives the registered automatable
 * params (engine/param-lane.ts) with breakpoints scheduled ahead, like notes.
 *
 * - `update(project, view)` runs after every document reconcile and transport-view change (before
 *   the transport re-plans). Targets whose TargetAutomation object (or document value, or spec)
 *   changed are re-planned; the others keep their schedule. Pattern mode plays no playlist
 *   automation: every target goes back to its document value.
 * - As a TransportObserver it plans each segment before the segment's notes go out, so plugins that
 *   read `valueAt(noteTime)` at noteOn see the curve. Each lane gets the breakpoints from its last
 *   one through the first breakpoint at or after the segment's end (curve-plan.ts), so a ramp's end
 *   is always scheduled before the audio reaches its start.
 * - Times come from the run the breakpoints belong to (where playback started or the loop last
 *   wrapped) and the tempo map, never from the transport's accumulated segment times: breakpoint
 *   times don't depend on how the timeline was cut into segments (offline renders are bit-exact at
 *   any chunk size).
 * - Re-anchoring (model edits, touches ending, new params, seeks, tempo or loop changes): `cut()` the
 *   lane at now + guard (≥ 20 ms, ≥ base latency + 2 render quanta) and continue with a short ramp
 *   to the new curve. At most one re-anchor per lane per pump. Loop wraps and value jumps become
 *   3 ms ramps; offline renders start exactly on the value at the start tick.
 * - `touch(key, on)`: a knob drag, a stream of MIDI CCs or recording takes the control over: the
 *   driver releases the param (live edits are heard) and ramps back to the curve over 30 ms when the
 *   touch ends. Edits that aren't gestures (undo, presets, typed values) only change the document
 *   value, which automation uses before the target's first clip.
 * - Stopped: automated params hold their last value (an edit to one lets go of it); playing again
 *   ramps from there to the value at the start tick.
 * - `readValue(key, time)` answers knobs that follow automation (NaN when not driven).
 * - Everything is planned in the song's time. A control that sits behind the song's clock (the mixer holds the
 *   audio back for plugin delay compensation: `AutomatableParam.shift`) is handled through a `ShiftedParam`, which
 *   moves each time by that shift; `retime()` plans such lanes again after a shift changed.
 */
import { automationModelOf, type TargetAutomation } from '@core/automation/model';
import { resolveTarget, type ResolvedTarget, type SpecsResolver } from '@core/automation/targets';
import type { Project } from '@core/model/types';
import type { TempoMap } from '@core/time/ppq';
import { isAutomatable } from '@agstudio/sdk';
import type { TransportView } from '../api';
import type { AutomatableParam, ParamRegistry } from '../param-lane';
import type { Segment, Timeline } from '../sched/core';
import type { TransportObserver } from '../sched/transport';
import { CurvePlanner, JUMP, rampError } from './curve-plan';
import { ShiftedParam } from './shifted';

export interface DriverDeps {
  readonly ctx: BaseAudioContext;
  readonly params: ParamRegistry;
  readonly offline: boolean;
  /** Param specs of plugins (plugin targets resolve through them). */
  readonly specsOf?: SpecsResolver;
  /** The timeline the transport plans with (its tempo map and loop). */
  readonly timeline?: () => Timeline | null;
}

/** A touch ended: back to the curve over this long. */
export const RETURN = 0.03;
/** A target automation lets go of goes back to its document value over this long. */
export const RELEASE = 0.02;
/** Playback starts: from the held value to the value at the start tick over this long. */
export const START = 0.005;

/** Where breakpoint times are measured from: playback start, a seek, a loop wrap or a timeline change. */
interface Run {
  id: number;
  /** Anchor tick and the context time it plays at. */
  tick: number;
  time: number;
  /** tempo.tickToSeconds(tick). */
  t0: number;
  /** Loop end (the run ends there), or Infinity. */
  end: number;
  tempo: TempoMap;
}

interface Plan {
  key: string;
  automation: TargetAutomation;
  resolved: ResolvedTarget;
  planner: CurvePlanner;
  /** Registered params under the key. */
  lanes: AutomatableParam[];
}

interface LaneState {
  plan: Plan;
  /** The run `frontier` belongs to (null: re-anchor before planning). */
  run: Run | null;
  /** Tick of the last breakpoint (continuous params) or how far changes were planned (discrete). */
  frontier: number;
  /** The value at the frontier. */
  last: number;
  /** Ramp of a pending re-anchor (NaN = none). */
  pending: number;
  /** The lane's document value when last seen (an edit while stopped lets go of the held value). */
  base: number;
}

const EMPTY = new Map<string, TargetAutomation>();

export class AutomationDriver implements TransportObserver {
  private readonly touched = new Set<string>();
  private readonly plans = new Map<string, Plan>();
  private readonly states = new Map<AutomatableParam, LaneState>();
  private readonly buf = new Float64Array(512);
  private readonly views = new WeakMap<AutomatableParam, ShiftedParam>();
  private readonly unsubscribe: () => void;
  private playing = false;
  private run: Run | null = null;
  /** The next segment starts a new run (playback started, a seek, a tempo or loop change). */
  private newRun = false;
  private runs = 0;
  private project: Project | null = null;

  constructor(private readonly deps: DriverDeps) {
    this.unsubscribe = deps.params.subscribe((p, added) => this.paramChanged(p, added));
  }

  /** The document or the transport view changed. */
  update(project: Project, view: TransportView): void {
    this.project = project;
    const targets = view.mode === 'song' ? automationModelOf(project).targets : EMPTY;
    const specsOf = this.deps.specsOf ?? (() => undefined);
    const tempo = this.currentTempo();
    const seen = new Set<string>();
    for (const [key, automation] of targets) {
      // Tempo automation is the transport's (the tempo map follows it).
      if (automation.target.kind === 'tempo') continue;
      const resolved = resolveTarget(project, automation.target, specsOf);
      if (!resolved || !isAutomatable(resolved.spec)) continue;
      seen.add(key);
      const plan = this.plans.get(key);
      if (
        plan &&
        plan.automation === automation &&
        plan.resolved.base === resolved.base &&
        plan.resolved.spec === resolved.spec
      ) {
        plan.resolved = resolved;
        continue;
      }
      const planner = new CurvePlanner(
        automation,
        resolved.fromNormalized,
        resolved.base,
        resolved.spec.type !== 'float',
        rampError(key, resolved.spec),
        tempo,
      );
      if (plan) {
        plan.automation = automation;
        plan.resolved = resolved;
        plan.planner = planner;
        for (const lane of plan.lanes) this.stateOf(lane, plan).pending = JUMP;
      } else {
        const fresh: Plan = { key, automation, resolved, planner, lanes: this.deps.params.get(key).map((l) => this.view(l)) };
        this.plans.set(key, fresh);
        for (const lane of fresh.lanes) this.stateOf(lane, fresh).pending = JUMP;
      }
    }
    for (const [key, plan] of this.plans) {
      if (seen.has(key)) continue;
      this.plans.delete(key);
      this.letGo(plan.lanes, RELEASE);
    }
    // Edits while stopped are heard: a held value lets go when the document value changes.
    for (const [lane, ls] of this.states) {
      if (lane.base === ls.base) continue;
      ls.base = lane.base;
      if (!this.playing && lane.driven) {
        lane.release(this.deps.ctx.currentTime + this.guard(), RELEASE);
        ls.run = null;
      }
    }
  }

  started(_tick: number, _time: number): void {
    this.playing = true;
    this.newRun = true;
  }

  seeked(_tick: number, _time: number): void {
    this.newRun = true;
  }

  reanchored(_time: number, timelineChanged: boolean): void {
    // The tick ↔ time mapping changed: start over from the next segment.
    if (timelineChanged) this.newRun = true;
  }

  segment(seg: Segment, wrapped: boolean): void {
    if (!this.playing) return;
    const tl = this.deps.timeline?.() ?? null;
    if (!tl) return;
    let fresh = false;
    let previous: Run | null = null;
    if (this.newRun || !this.run) {
      this.run = this.makeRun(seg.tick0, seg.time0, tl);
      this.newRun = false;
      fresh = true;
    } else if (wrapped) {
      previous = this.run;
      this.run = this.makeRun(seg.tick0, timeOf(previous, previous.end), tl);
    }
    const run = this.run;
    if (this.plans.size === 0) return;
    const now = this.deps.ctx.currentTime;
    for (const plan of this.plans.values()) {
      if (this.touched.has(plan.key)) continue;
      plan.planner.setTempo(run.tempo);
      for (const lane of plan.lanes) {
        if (!isAutomatable(lane.spec)) continue;
        const ls = this.stateOf(lane, plan);
        if (fresh) this.begin(lane, ls, START, true);
        else if (ls.run !== run) {
          if (previous && ls.run === previous && ls.frontier >= previous.end && Number.isNaN(ls.pending))
            this.wrap(lane, ls);
          else this.begin(lane, ls, Number.isNaN(ls.pending) ? JUMP : ls.pending, false);
        } else if (!Number.isNaN(ls.pending)) this.begin(lane, ls, ls.pending, false);
        else if (!this.deps.offline && !plan.planner.discrete && lane.scheduledUntil < now) {
          // Stalled (the main thread was busy past everything scheduled): start again from the current value.
          this.begin(lane, ls, JUMP, false);
        }
        this.schedule(lane, ls, seg.tick1);
      }
    }
  }

  stopped(_time: number): void {
    this.playing = false;
    this.run = null;
    this.newRun = false;
    // Hold the value being heard.
    const at = this.deps.ctx.currentTime + this.guard();
    for (const [lane, ls] of this.states) {
      if (lane.driven) lane.cut(at);
      ls.run = null;
    }
  }

  touch(key: string, on: boolean): void {
    if (on) {
      if (this.touched.has(key)) return;
      this.touched.add(key);
      this.letGo(this.deps.params.get(key).map((l) => this.view(l)), RELEASE);
      return;
    }
    if (!this.touched.delete(key)) return;
    const plan = this.plans.get(key);
    if (plan) for (const lane of plan.lanes) this.stateOf(lane, plan).pending = RETURN;
  }

  /** The automated value of `key` at `time` (spec units), or NaN when automation doesn't drive it. */
  readValue(key: string, time: number): number {
    const p = this.deps.params.newest(key);
    return p && p.driven ? this.view(p).valueAt(time) : Number.NaN;
  }

  /**
   * Some lanes' `shift` changed (the mixer's delay compensation did): plans them again from the next segment, so
   * their breakpoints land where the control is heard now.
   */
  retime(): void {
    for (const [lane, ls] of this.states) {
      if (!(lane instanceof ShiftedParam) || !lane.retimed()) continue;
      if (lane.driven || this.plans.has(lane.key)) ls.pending = JUMP;
    }
  }

  /** The lane as the driver plans it: in the song's time (see ShiftedParam). */
  private view(lane: AutomatableParam): AutomatableParam {
    if (lane instanceof ShiftedParam) return lane;
    let v = this.views.get(lane);
    if (!v) this.views.set(lane, (v = new ShiftedParam(lane)));
    return v;
  }

  /** Keys of the targets automation currently plans (tests, diagnostics). */
  get plannedKeys(): readonly string[] {
    return [...this.plans.keys()];
  }

  dispose(): void {
    this.unsubscribe();
    this.touched.clear();
    this.plans.clear();
    this.states.clear();
    this.project = null;
  }

  // ---------------------------------------------------------------- internals

  /** How far ahead of the audio clock a schedule may be changed. */
  private guard(): number {
    if (this.deps.offline) return 0;
    const ctx = this.deps.ctx as BaseAudioContext & { baseLatency?: number };
    return Math.max(0.02, (ctx.baseLatency ?? 0) + 256 / ctx.sampleRate);
  }

  private currentTempo(): TempoMap {
    const tl = this.deps.timeline?.();
    if (tl) return tl.tempo;
    const bpm = this.project?.transport.bpm ?? 120;
    const spt = 60 / (bpm * 960);
    return {
      bpm,
      constant: true,
      bpmAt: () => bpm,
      secondsPerTick: () => spt,
      tickToSeconds: (t) => t * spt,
      secondsToTick: (s) => s / spt,
      nextChange: () => Infinity,
    };
  }

  private makeRun(tick: number, time: number, tl: Timeline): Run {
    const loop = tl.loop && tl.loop.end > tl.loop.start ? tl.loop : null;
    return {
      id: ++this.runs,
      tick,
      time,
      t0: tl.tempo.tickToSeconds(tick),
      end: loop ? loop.end : Infinity,
      tempo: tl.tempo,
    };
  }

  private stateOf(lane: AutomatableParam, plan: Plan): LaneState {
    let ls = this.states.get(lane);
    if (!ls) {
      ls = { plan, run: null, frontier: Number.NaN, last: Number.NaN, pending: Number.NaN, base: lane.base };
      this.states.set(lane, ls);
    } else ls.plan = plan;
    return ls;
  }

  /** Hands lanes back to their document values (automation removed, a touch, pattern mode). */
  private letGo(lanes: readonly AutomatableParam[], ramp: number): void {
    const at = this.deps.ctx.currentTime + this.guard();
    for (const lane of lanes) {
      if (lane.driven) lane.release(at, ramp);
      const ls = this.states.get(lane);
      if (!ls) continue;
      ls.run = null;
      ls.frontier = Number.NaN;
      if (!this.plans.has(lane.key)) this.states.delete(lane);
    }
  }

  private paramChanged(raw: AutomatableParam, added: boolean): void {
    const p = this.view(raw);
    const plan = this.plans.get(p.key);
    if (added) {
      if (!plan) return;
      if (!plan.lanes.includes(p)) plan.lanes.push(p);
      // Picked up at the next segment (a new instance starts at its document value).
      this.stateOf(p, plan).pending = JUMP;
      return;
    }
    this.states.delete(p);
    if (plan) plan.lanes = plan.lanes.filter((x) => x !== p);
  }

  /**
   * (Re-)starts a lane in the current run: keeps its schedule up to now + guard and ramps from the
   * value there to the curve. `fresh` playback starts offline at time 0 exactly on the value.
   */
  private begin(lane: AutomatableParam, ls: LaneState, ramp: number, fresh: boolean): void {
    const run = this.run as Run;
    const planner = ls.plan.planner;
    ls.pending = Number.NaN;
    ls.run = run;
    const ctx = this.deps.ctx;
    if (fresh && this.deps.offline && ctx.currentTime === 0) {
      const v = planner.valueAt(run.tick);
      lane.start(v);
      if (run.time > 0) lane.extend([run.time, v]);
      ls.frontier = run.tick;
      ls.last = v;
      return;
    }
    const from = Math.max(ctx.currentTime + this.guard(), run.time);
    const tb = lane.cut(from);
    const tick = tickOf(run, tb);
    if (tick >= run.end) {
      // Already scheduled into the next pass of the loop: the wrap continues from there.
      ls.frontier = run.end;
      ls.last = lane.valueAt(tb);
      return;
    }
    if (planner.discrete) {
      const v = planner.valueAt(tick);
      if (v !== lane.valueAt(tb)) lane.extend([tb + 1e-4, v]);
      ls.frontier = tick;
      ls.last = v;
      return;
    }
    let te = tb + ramp;
    let tickE = tickOf(run, te);
    if (tickE >= run.end) {
      tickE = run.end;
      te = timeOf(run, run.end);
    }
    const v = planner.valueBefore(tickE);
    if (te > tb) lane.extend([te, v]);
    ls.frontier = tickE;
    ls.last = v;
  }

  /** The loop wrapped: continue from the loop start, ramping over JUMP if the value differs there. */
  private wrap(lane: AutomatableParam, ls: LaneState): void {
    const run = this.run as Run;
    const planner = ls.plan.planner;
    ls.run = run;
    const v = planner.valueAt(run.tick);
    if (planner.discrete) {
      if (v !== ls.last) lane.extend([run.time, v]);
      ls.frontier = run.tick;
      ls.last = v;
      return;
    }
    if (Math.abs(v - ls.last) <= 1e-9 * (1 + Math.abs(v))) {
      ls.frontier = run.tick;
      return;
    }
    let te = run.time + JUMP;
    let tickE = tickOf(run, te);
    if (tickE >= run.end) {
      tickE = run.end;
      te = timeOf(run, run.end);
    }
    const vE = planner.valueBefore(tickE);
    lane.extend([te, vE]);
    ls.frontier = tickE;
    ls.last = vE;
  }

  /** Schedules the lane's breakpoints from its frontier through the first one at or after `through`. */
  private schedule(lane: AutomatableParam, ls: LaneState, through: number): void {
    const run = this.run as Run;
    const planner = ls.plan.planner;
    const buf = this.buf;
    for (let guard = 0; guard < 256 && ls.frontier < through && ls.frontier < run.end; guard++) {
      const n = planner.discrete
        ? planner.discreteBreakpoints(ls.frontier, through, run.end, ls.last, buf)
        : planner.floatBreakpoints(ls.frontier, through, run.end, buf);
      if (planner.discrete) ls.last = planner.lastValue;
      else if (n > 0) ls.last = buf[2 * n - 1] as number;
      const reached = planner.reached;
      if (!(reached > ls.frontier)) break;
      ls.frontier = reached;
      for (let i = 0; i < n; i++) buf[2 * i] = timeOf(run, buf[2 * i] as number);
      if (n > 0) lane.extend(buf.subarray(0, 2 * n));
    }
  }
}

function timeOf(run: Run, tick: number): number {
  return run.time + (run.tempo.tickToSeconds(tick) - run.t0);
}

function tickOf(run: Run, time: number): number {
  return run.tempo.secondsToTick(run.t0 + (time - run.time));
}
