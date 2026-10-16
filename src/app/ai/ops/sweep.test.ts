/**
 * Sweep of every Studio action: each op of the schema runs through `applyAnswer` with valid, missing,
 * wrong-typed and out-of-range arguments (schema-driven, seeded), on the stacked 113-bar song. Whatever
 * the arguments: no throw, at most one undo step, Undo restores the project exactly, Redo re-applies
 * it exactly, and the project stays consistent. A dry run never changes anything.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@core/model/types';
import { projectViolations } from '../../../../test/helpers/project-invariants';
import { stackedSong, project, type TestServices } from '../../../../test/helpers/focus';
import { applyAnswer } from '../apply';
import { focusFromRange } from '../focus-capture';
import { resolveFocus, type AiFocus } from '../focus';
import { ACTION_OPS, type AiAction } from '../schema';
import { UI_OP_NAMES as UI } from './index';
import type { AppliedTurn } from './types';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Schema {
  type?: string;
  enum?: string[];
  const?: string;
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
}

const WEIRD: unknown[] = [
  null,
  '',
  ' ',
  'nothing here',
  0,
  -0,
  -1,
  0.5,
  3,
  7,
  1e9,
  -1e9,
  1e-9,
  true,
  false,
  [],
  {},
  [1, 2],
  { a: 1 },
  'x'.repeat(500),
];

interface Pools {
  [key: string]: unknown[];
}

function poolsFor(p: Project): Pools {
  const channels = p.channelOrder.map((id) => p.channels[id]!);
  const instruments = channels.filter((c) => c.kind === 'instrument');
  const clips = Object.values(p.playlist.clips);
  const fx = Object.values(p.mixer.inserts).flatMap((i) => i.fx.map((f) => f.id));
  const inserts = ['master', '1', '2', '5', '9', ...Object.values(p.mixer.inserts).map((i) => i.name)];
  const pat = p.patternOrder.map((id) => p.patterns[id]!.name);
  return {
    channel: [instruments[0]!.id, instruments[3]!.name, instruments[5]!.id, 'Kick', '808', channels[0]!.id],
    channels: [[instruments[0]!.name], [instruments[1]!.id, instruments[2]!.name]],
    insert: inserts,
    from: ['1', '2', 'master', 'Kick', 'Melody', '3', '4'],
    to: ['master', '3', '2', 'Pad', '5', '1'],
    effect: fx,
    pattern: ['current', pat[1]!, p.patternOrder[2]!, pat[3]!, pat[0]!, 'Drop', 'Tom fill'],
    clip: clips.slice(0, 6).map((c) => c.id),
    marker: [...Object.values(p.playlist.markers).map((m) => m.name), 'Drop', 'nope'],
    plugin: ['agstudio.3xosc', 'agstudio.reverb', 'agstudio.sampler', 'agstudio.eq-pro', 'agstudio.limiter', 'agstudio.ducker', 'agstudio.wavetable'],
    tool: ['agstudio.notes.transpose', 'agstudio.notes.humanize', 'agstudio.notes.quantize', 'nope'],
    bar: [1, 2, 5, 17, 49, 81, 112, 120, 0, -3],
    track: [1, 2, 3, 11, 12, 40],
    from_bar: [1, 5, 17, 81, 112],
    to_bar: [4, 17, 33, 113],
    bars: [1, 2, 4, 8, 16, 0.5],
    name: ['Verse', 'Drop 2', 'New thing', 'A'],
    from_song: ['one', 'two'],
    section: ['Drop', 'Intro'],
  };
}

function genValue(schema: Schema, key: string, pools: Pools, r: () => number, weird: boolean): unknown {
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  if (weird && r() < 0.35) return pick(WEIRD);
  const pool = pools[key];
  if (pool && (schema.type === 'string' || schema.type === 'array' || schema.type === 'integer' || schema.type === 'number'))
    return pick(pool);
  if (schema.enum) return pick(schema.enum);
  if (schema.anyOf) return genValue(pick(schema.anyOf), key, pools, r, weird);
  switch (schema.type) {
    case 'string':
      return pick(['Verse', 'x', '#336699', '120', 'F minor', '4/4', 'Drop']);
    case 'integer':
      return pick([1, 2, 3, 4, 8, 16, 0, -2, 1000]);
    case 'number':
      return pick([0, 0.25, 0.5, 1, 2, 4, -6, -20, 100, 140, 1.5, 0.01]);
    case 'boolean':
      return r() < 0.5;
    case 'array': {
      const n = Math.floor(r() * 4);
      return Array.from({ length: n }, () => genValue(schema.items ?? {}, key, pools, r, weird));
    }
    case 'object':
      return genObject(schema, pools, r, weird, 0.5);
    default:
      return pick([1, 'a', true]);
  }
}

function genObject(schema: Schema, pools: Pools, r: () => number, weird: boolean, optionalChance: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    if (sub.const !== undefined) {
      out[k] = sub.const;
      continue;
    }
    const required = schema.required?.includes(k);
    if (!required && r() > optionalChance) continue;
    if (required && weird && r() < 0.08) continue; // a missing required field
    out[k] = genValue(sub, k, pools, r, weird);
  }
  return out;
}

function snapshotOf(s: TestServices) {
  return structuredClone(project(s));
}

/** Runs one answer and checks the contract. Returns the result, or null when nothing was applied. */
/** Working on a part of the song: edits beyond it are refused, or allowed (as after the musician's OK). */
interface Mode {
  focus?: AiFocus;
  outside?: 'refuse' | 'allow';
}

const BAR = 3840;

function checkAnswer(s: TestServices, actions: AiAction[], label: string, mode: Mode = {}): AppliedTurn {
  const stepsAtStart = s.history.steps().done.length;
  try {
    return checkOnce(s, actions, label, mode);
  } catch (e) {
    // Leave the shared project as it was, so one failure doesn't hide the others.
    while (s.history.steps().done.length > stepsAtStart) s.history.undo();
    throw e;
  }
}

function checkOnce(s: TestServices, actions: AiAction[], label: string, mode: Mode): AppliedTurn {
  const before = snapshotOf(s);
  const stepsBefore = s.history.steps().done.length;
  const part = () => (mode.focus ? resolveFocus(project(s), mode.focus) : null);
  const ctx = () => ({
    previousBeat: null,
    ...(mode.focus ? { focus: part(), focusOutside: mode.outside ?? ('refuse' as const) } : {}),
  });
  const span = part();
  // A dry run leaves everything as it was.
  const dry = applyAnswer(s, { message: 'Sweep.', actions }, { ...ctx(), dryRun: true });
  expect(dry.edited).toBe(false);
  expect(snapshotOf(s), `${label}: dry run changes nothing`).toEqual(before);
  expect(s.history.steps().done.length).toBe(stepsBefore);
  let res!: AppliedTurn;
  try {
    res = applyAnswer(s, { message: 'Sweep.', actions }, ctx());
  } catch (e) {
    throw new Error(`${label} threw: ${e instanceof Error ? (e.stack ?? e.message) : e}\n${JSON.stringify(actions)}`);
  }
  // The dry run predicted the same changes and warnings (when there was something to edit).
  // (the UI actions' own warnings come after the edit, so a dry run doesn't have them)
  const docWarnings = (w: string[]) => w.filter((x) => ![...UI].some((op) => x.startsWith(`${op.replace(/_/g, ' ')}:`)));
  if (actions.some((a) => !UI.has(String(a.op))))
    expect({ c: dry.changes, w: dry.warnings }, `${label}: dry run matches`).toEqual({
      c: res.changes,
      w: docWarnings(res.warnings),
    });
  const steps = s.history.steps().done.length - stepsBefore;
  if (steps > 1) throw new Error(`${label}: ${steps} undo steps\n${JSON.stringify(actions)}`);
  const after = snapshotOf(s);
  const bad = projectViolations(after);
  if (bad.length) throw new Error(`${label}: project inconsistent: ${bad.slice(0, 4).join('; ')}\n${JSON.stringify(actions)}`);
  if (span && mode.outside !== 'allow') {
    // Refused beyond the part: clips well away from it, and the patterns they play, are as they were.
    const far = (c: { start: number; length: number }) => c.start + c.length <= span.from - BAR || c.start >= span.to + BAR;
    const played = new Set<string>();
    for (const c of Object.values(before.playlist.clips)) {
      if (!far(c)) continue;
      expect(after.playlist.clips[c.id], `${label}: a clip outside the part changed\n${JSON.stringify(actions)}`).toEqual(c);
      if (c.kind === 'pattern') played.add(c.patternId);
    }
    for (const pid of played)
      expect(after.patterns[pid]?.notes, `${label}: a pattern playing outside the part changed\n${JSON.stringify(actions)}`).toEqual(before.patterns[pid]!.notes);
  }
  if (steps === 1) {
    expect(res.edited, label).toBe(true);
    s.history.undo();
    try {
      expect(snapshotOf(s), `${label}: undo restores\n${JSON.stringify(actions)}`).toEqual(before);
    } finally {
      // keep going from a known state either way
    }
    s.history.redo();
    expect(snapshotOf(s), `${label}: redo re-applies\n${JSON.stringify(actions)}`).toEqual(after);
    s.history.undo();
  } else {
    expect(snapshotOf(s), `${label}: no step, no change\n${JSON.stringify(actions)}`).toEqual(before);
  }
  return res;
}

describe('every Studio action, whatever its arguments', () => {
  const { s } = stackedSong();
  const pools = poolsFor(project(s));
  const count = (process.env.SWEEP_N ? Number(process.env.SWEEP_N) : 6) | 0;

  for (const schema of ACTION_OPS as unknown as Schema[]) {
    const op = schema.properties!.op!.const!;
    it(op, () => {
      const r = rng([...op].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
      // Valid: required fields only, then all fields.
      for (const chance of [0, 1]) {
        const args = genObject(schema, pools, rng(5), false, chance);
        checkAnswer(s, [args as AiAction], `${op} valid(${chance})`);
      }
      // Valid but varied, then with wrong types and out-of-range values mixed in.
      for (let i = 0; i < count; i++) {
        const args = genObject(schema, pools, r, i % 2 === 1, 0.5);
        checkAnswer(s, [args as AiAction], `${op} #${i}`);
      }
    }, 60_000);
  }

  it('random sequences of actions (refs across actions)', () => {
    const r = rng(99);
    const ops = ACTION_OPS as unknown as Schema[];
    for (let i = 0; i < 25; i++) {
      const actions = Array.from({ length: 2 + Math.floor(r() * 5) }, () => {
        const sch = ops[Math.floor(r() * ops.length)]!;
        return genObject(sch, pools, r, r() < 0.3, 0.5) as AiAction;
      });
      checkAnswer(s, actions, `sequence #${i}`);
    }
  }, 120_000);
});

describe('every Studio action while working on a part of the song', () => {
  const { s } = stackedSong();
  const pools = poolsFor(project(s));
  const part = focusFromRange(s, 16 * BAR, 32 * BAR)!;
  const count = (process.env.SWEEP_N ? Number(process.env.SWEEP_N) : 6) | 0;

  for (const outside of ['refuse', 'allow'] as const)
    for (const schema of ACTION_OPS as unknown as Schema[]) {
      const op = schema.properties!.op!.const!;
      it(`${op} (${outside})`, () => {
        const r = rng([...op].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 11));
        for (const chance of [0, 1]) {
          const args = genObject(schema, pools, rng(5), false, chance);
          checkAnswer(s, [args as AiAction], `${op} valid(${chance})`, { focus: part, outside });
        }
        for (let i = 0; i < count; i++) {
          const args = genObject(schema, pools, r, i % 2 === 1, 0.5);
          checkAnswer(s, [args as AiAction], `${op} #${i}`, { focus: part, outside });
        }
      }, 60_000);
    }

  it('random sequences of actions', () => {
    const r = rng(7);
    const ops = ACTION_OPS as unknown as Schema[];
    for (const outside of ['refuse', 'allow'] as const)
      for (let i = 0; i < 12; i++) {
        const actions = Array.from({ length: 2 + Math.floor(r() * 5) }, () => {
          const sch = ops[Math.floor(r() * ops.length)]!;
          return genObject(sch, pools, r, r() < 0.3, 0.5) as AiAction;
        });
        checkAnswer(s, actions, `sequence #${i} (${outside})`, { focus: part, outside });
      }
  }, 120_000);
});
