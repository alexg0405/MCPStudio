/**
 * Characterization of the arranger: for a spread of styles, section layouts and options, a short
 * fingerprint (a hash of the whole result and a few counts) of the plan, of the project the plan
 * writes, and of the in-place "develop" edits to an existing song. Ids come from a seeded source, so
 * even the order in which the writer creates things is pinned.
 *
 * It exists so the planner and the writer can be reorganised without changing a single note or clip.
 * If a deliberate change makes it fail, review the cause and regenerate the snapshot with `vitest -u`.
 */
import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { STYLES, type Style } from '../beat/style';
import { buildStackedSong } from '../fixtures/stacked-song';
import { sha256Hex } from '../io/hash';
import { createEmptyProject, makeInsert, makePluginInstance } from '../model/defaults';
import { newId, seededBytes, setIdSource } from '../model/ids';
import type { InsertId, PatternId, Project, SlotId } from '../model/types';
import { tidySong } from '../ops/tidy';
import { constantTempo } from '../time/ppq';
import { BAR, HINT, kitProject, notes, trapGroove } from '../../../test/helpers/arrange';
import {
  applyArrangement,
  applyEditsInPlace,
  laneAllocatorFor,
  placeAutomation,
  placeCrashes,
  placeFx,
  type ApplyEnv,
} from './apply';
import { existingFx, fillLikeClips, inferSections } from './infer';
import { planArrangement, planDevelop, type ArrangeRequest } from './plan';
import { DEFAULT_ENERGY, type SectionRole, type SectionSpec } from './sections';
import { variantEnv } from './variants';
import { p as params, type ParamSpecs } from '@agstudio/sdk/params';

const EQ: ParamSpecs = {
  b1Freq: params.float(20, 20000, 30, { scale: 'log', unit: 'Hz' }),
  b8Freq: params.float(20, 20000, 18000, { scale: 'log', unit: 'Hz' }),
};

const spec = (
  name: string,
  role: SectionRole,
  bars: number,
  play: PatternId[],
  patch: Partial<SectionSpec> = {},
): SectionSpec => ({
  name,
  role,
  bars,
  energy: DEFAULT_ENERGY[role],
  play,
  without: [],
  vary: 'auto',
  transitionIn: 'auto',
  fill: 'auto',
  ...patch,
});

/** A song with four patterns and a chords bus that has an EQ Pro (so sweeps can be written). */
function setup() {
  const s = kitProject((k) => ({
    Beat: { notes: trapGroove(k) },
    Drums: {
      notes: {
        [k.kick]: notes([
          [0, 60],
          [10, 60],
        ]),
        [k.snare]: notes([[8, 60]]),
        [k.hat]: notes(Array.from({ length: 8 }, (_, i) => [i * 2, 60] as [number, number])),
      } as never,
      bars: 1,
    },
    Keys: {
      notes: {
        [k.pad]: notes([
          [0, 53, 32],
          [0, 60, 32],
        ]),
      } as never,
      bars: 2,
    },
    Melody: {
      notes: {
        [k.lead]: notes([
          [0, 72, 4],
          [4, 75, 4],
          [8, 77, 8],
          [16, 72, 16],
        ]),
      } as never,
      bars: 2,
    },
  }));
  let chords!: { insertId: InsertId; slotId: SlotId };
  const project = produce(s.project, (d) => {
    const id = newId.insert();
    d.mixer.inserts[id] = makeInsert(id, 'Chords');
    d.mixer.order.push(id);
    const slotId = newId.slot();
    d.mixer.inserts[id]!.fx.push({
      id: slotId,
      plugin: makePluginInstance('agstudio.eq-pro', 1, { b1On: true, b1Freq: 20, b8On: true, b8Freq: 20000 }),
      enabled: true,
      mix: 1,
      sidechain: null,
    });
    chords = { insertId: id, slotId };
  });
  const venv = (style: Style) => variantEnv(project, { style, hint: HINT });
  const applyEnv = (style: Style): ApplyEnv => ({
    variant: venv(style),
    specsOf: (id) => (id === 'agstudio.eq-pro' ? EQ : undefined),
    tempo: constantTempo(project.transport.bpm),
    targets: { chords },
  });
  return { ...s, project, venv, applyEnv };
}

type Song = ReturnType<typeof setup>;

function fullLayout(s: Song, patch: (name: string) => Partial<SectionSpec> = () => ({})): SectionSpec[] {
  const { Beat, Keys, Drums, Melody } = s.patterns as Record<string, PatternId>;
  return [
    spec('Intro', 'intro', 8, [Keys!], patch('Intro')),
    spec('Verse', 'verse', 16, [Drums!, Keys!], patch('Verse')),
    spec('Build', 'build', 4, [Drums!], patch('Build')),
    spec('Drop', 'drop', 16, [Beat!, Melody!], patch('Drop')),
    spec('Break', 'break', 8, [Keys!], patch('Break')),
    spec('Drop 2', 'drop', 16, [Beat!, Melody!], patch('Drop 2')),
    spec('Outro', 'outro', 8, [Keys!], patch('Outro')),
  ];
}

/** A project's creation time is the only clock in it; leave it out so the fingerprint is the same every run. */
const withoutCreationTime = (key: string, value: unknown) => (key === 'createdAt' ? undefined : value);

async function fingerprint(value: unknown, summary: string): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(value, withoutCreationTime)));
  return `${hash.slice(0, 16)} ${summary}`;
}

const request = (sections: SectionSpec[], patch: Partial<ArrangeRequest> = {}): ArrangeRequest => ({
  from: 0,
  style: 'trap',
  fx: 'auto',
  ending: 'auto',
  sections,
  ...patch,
});

beforeEach(() => {
  setIdSource(seededBytes(20260101));
});

describe('arranger characterization', () => {
  it('plans the same song for every style and option', async () => {
    const s = setup();
    const lines: string[] = [];
    const record = async (label: string, req: ArrangeRequest) => {
      const plan = planArrangement(s.project, req, { variant: s.venv(req.style) });
      const summary = `clips ${plan.clips.length} fx ${plan.fx.length} crashes ${plan.crashes.length} auto ${plan.automation.length} fills ${plan.counts.fills}`;
      lines.push(`${label}: ${await fingerprint(plan, summary)}`);
    };
    for (const style of STYLES) await record(`style ${style}`, request(fullLayout(s), { style }));
    await record('fx light', request(fullLayout(s), { fx: 'light' }));
    await record('fx none', request(fullLayout(s), { fx: 'none' }));
    await record('ending stop', request(fullLayout(s), { ending: 'stop' }));
    await record('ending fade', request(fullLayout(s), { ending: 'fade', style: 'house' }));
    await record('from bar 5', request(fullLayout(s), { from: 4 * BAR }));
    await record('vary more', request(fullLayout(s, () => ({ vary: 'more' }))));
    await record('vary less', request(fullLayout(s, () => ({ vary: 'less' }))));
    await record('vary none', request(fullLayout(s, () => ({ vary: 'none' }))));
    await record('fills tom', request(fullLayout(s, () => ({ fill: 'tom' }))));
    await record('fills kick on drops', request(fullLayout(s, (n) => (n.startsWith('Drop') ? { fill: 'kick' } : {}))));
    await record('fills none', request(fullLayout(s, () => ({ fill: 'none' }))));
    await record(
      'without',
      request(
        fullLayout(s, (n) =>
          n === 'Break' ? { without: ['drums', 'bass'] } : n === 'Verse' ? { without: ['hats'] } : {},
        ),
      ),
    );
    await record(
      'without everything',
      request(fullLayout(s, (n) => (n === 'Intro' ? { without: ['keys', 'pads', 'chords'] } : {}))),
    );
    for (const choice of ['rise', 'lift', 'same', 'dip', 'fall', 'none'] as const) {
      await record(
        `transition ${choice}`,
        request(fullLayout(s, (n) => (n === 'Drop 2' || n === 'Verse' ? { transitionIn: choice } : {}))),
      );
    }
    await record(
      'energies',
      request(
        fullLayout(s, (n) =>
          n === 'Verse' ? { energy: 1 } : n === 'Drop' ? { energy: 2 } : n === 'Break' ? { energy: 5 } : {},
        ),
      ),
    );
    await record(
      'single section',
      request([spec('Drop', 'drop', 6, [(s.patterns as Record<string, PatternId>).Beat!])]),
    );
    await record('no sections', request([]));
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/arrange-plans.txt');
  });

  it('writes the same project for a plan, twice over, and for options that clear things', async () => {
    const s = setup();
    const lines: string[] = [];
    const write = async (label: string, from: Project, req: ArrangeRequest, opts: { replace: boolean }) => {
      const env = s.applyEnv(req.style);
      const plan = planArrangement(from, req, { variant: env.variant });
      let report: unknown;
      const next = produce(from, (d) => {
        report = applyArrangement(d, plan, env, opts);
      });
      lines.push(
        `${label}: ${await fingerprint(next, JSON.stringify(report).length.toString())} ${JSON.stringify({ ...(report as object), clipIds: undefined })}`,
      );
      return next;
    };
    const first = await write('trap', s.project, request(fullLayout(s)), { replace: true });
    const second = await write('trap again', first, request(fullLayout(s)), { replace: true });
    await write('house over trap', second, request(fullLayout(s), { style: 'house', ending: 'stop' }), {
      replace: true,
    });
    await write(
      'quiet',
      second,
      request(
        fullLayout(s, () => ({ vary: 'none' })),
        { fx: 'none', ending: 'fade' },
      ),
      { replace: true },
    );
    await write('lighter replace', first, request(fullLayout(s).slice(0, 4), { from: 8 * BAR, fx: 'light' }), {
      replace: true,
    });
    await write('kept', first, request(fullLayout(s).slice(2, 5), { from: 40 * BAR }), { replace: false });
    for (const style of ['lofi', 'edm', 'drill'] as const) {
      if (!(STYLES as readonly string[]).includes(style)) continue;
      await write(`style ${style}`, s.project, request(fullLayout(s), { style }), { replace: true });
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/arrange-writes.txt');
  });

  it('develops an existing song in place the same way', async () => {
    const lines: string[] = [];
    const base = produce(createEmptyProject(), (d) => {
      buildStackedSong(d);
      tidySong(d);
    });
    const env = variantEnv(base, { style: 'trap', hint: HINT });
    const applyEnv: ApplyEnv = {
      variant: env,
      specsOf: () => undefined,
      tempo: constantTempo(base.transport.bpm),
      targets: {},
    };
    const ranges: [string, number, number, { fills: boolean; transitions: boolean; fx: boolean }][] = [
      ['whole song', 0, 113 * BAR, { fills: true, transitions: true, fx: true }],
      ['fills only', 0, 113 * BAR, { fills: true, transitions: false, fx: false }],
      ['transitions only', 0, 113 * BAR, { fills: false, transitions: true, fx: true }],
      ['the drop', 36 * BAR, 54 * BAR, { fills: true, transitions: true, fx: true }],
      ['the ending', 100 * BAR, 113 * BAR, { fills: true, transitions: true, fx: false }],
    ];
    for (const [label, from, to, what] of ranges) {
      const sections = inferSections(base, env);
      const fillClips = fillLikeClips(base, env);
      const plan = planDevelop(
        base,
        sections,
        { style: 'trap', fills: what.fills, transitions: what.transitions, fx: what.fx ? 'auto' : 'none', from, to },
        { fx: existingFx(base, env), fills: fillClips.map((f) => ({ from: f.from, to: f.to })) },
        laneAllocatorFor(base),
      );
      let changed: string[] = [];
      let placed: string[] = [];
      const next = produce(base, (d) => {
        changed = applyEditsInPlace(d, plan.events, applyEnv, { protect: new Set(fillClips.map((f) => f.clipId)) });
        placed = [
          ...placeFx(d, plan.fx, applyEnv),
          ...placeCrashes(d, plan.crashes, applyEnv),
          ...placeAutomation(d, plan.automation, applyEnv, { skipBusy: true }),
        ];
      });
      const summary = `events ${plan.events.length} changed ${changed.length} placed ${placed.length} skipped ${JSON.stringify(plan.skipped)} counts ${JSON.stringify(plan.counts)}`;
      lines.push(`${label}: plan ${await fingerprint(plan, summary)} project ${(await fingerprint(next, '')).trim()}`);
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/arrange-develop.txt');
  });
});
