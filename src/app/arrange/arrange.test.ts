import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { existingFx } from '@core/arrange/infer';
import { playedNotes } from '@core/arrange/notes';
import { isBassRole, isDrumRole, noteRole } from '@core/arrange/roles';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { MASTER, type Project } from '@core/model/types';
import { songCheck } from '@core/query/arrangement';
import { BAR, BEAT, addKit, notes, trapGroove } from '../../../test/helpers/arrange';
import { projectViolations } from '../../../test/helpers/project-invariants';
import { createTestServices } from '../testing';
import { checkArrangement } from './check';
import { addFillAt, addTransitionAt, developSong, refreshVariations } from './commands';
import { rolesOf, sweepTargets, variantEnvFor } from './env';
import { derivedLabel } from './summary';

function stacked() {
  const s = createTestServices();
  let ids!: ReturnType<typeof buildStackedSong>;
  s.history.transact('song', (d) => {
    ids = buildStackedSong(d);
  });
  return { s, ids };
}

/** Drum and bass notes sounding in [from, to). */
function grooveIn(p: Project, from: number, to: number) {
  const roles = rolesOf(p);
  return playedNotes(p, 0, to).filter((n) => {
    const cr = roles.get(n.channelId) ?? 'other';
    return (isDrumRole(noteRole(cr, n.key)) || isBassRole(cr)) && n.tick < to && n.tick + n.length > from + 30;
  });
}

describe('sweep targets', () => {
  it('makes a Chords bus from an empty insert, routes the pads through it, adds a neutral EQ Pro; no lead bus without lead parts', () => {
    const s = createTestServices();
    s.history.transact('kit', (d) => {
      addKit(d);
      // No lead in this song.
      for (const id of [...d.channelOrder]) if (d.channels[id]!.name === 'Lead') {
        delete d.channels[id];
        d.channelOrder.splice(d.channelOrder.indexOf(id), 1);
      }
    });
    let out!: ReturnType<typeof sweepTargets>;
    s.history.transact('targets', (d) => {
      out = sweepTargets(d, s, { create: true });
    });
    const p = s.doc.getState().project;
    expect(out.targets.lead).toBeUndefined();
    const bus = p.mixer.inserts[out.targets.chords!.insertId]!;
    expect(bus.name).toBe('Chords');
    expect(p.mixer.order.indexOf(bus.id)).toBe(1); // "Insert 1", reused
    const pad = Object.values(p.channels).find((c) => c.name === 'Pad')!;
    expect(pad.kind !== 'automation' && pad.output).toBe(bus.id);
    expect(bus.fx[0]!.plugin).toMatchObject({ pluginId: 'agstudio.eq-pro', params: { b1On: true, b1Freq: 20, b8On: true, b8Freq: 20000 } });
    expect(out.changes[0]).toMatch(/^Made a Chords bus \(Insert 1\) for filter sweeps: Pad play through it/);
    // Found again by name, nothing new.
    let again!: ReturnType<typeof sweepTargets>;
    s.history.transact('again', (d) => {
      again = sweepTargets(d, s, { create: true });
    });
    expect(again.targets.chords).toEqual(out.targets.chords);
    expect(again.changes).toEqual([]);
  });

  it('routes tracks that only carry chords into the new bus (the stacked song’s Pad and Strings & Choir)', () => {
    const { s, ids } = stacked();
    s.history.transact('targets', (d) => {
      sweepTargets(d, s, { create: true });
    });
    const p = s.doc.getState().project;
    const chords = p.mixer.order.find((id) => p.mixer.inserts[id]!.name === 'Chords')!;
    expect(p.mixer.inserts[ids.inserts.Pad!]!.routes).toEqual([{ to: chords, level: 1, pre: false }]);
    expect(p.mixer.inserts[ids.inserts['Strings & Choir']!]!.routes.map((r) => r.to)).toEqual([chords]);
    expect(p.mixer.inserts[chords]!.routes.map((r) => r.to)).toEqual([MASTER]);
    expect(projectViolations(p)).toEqual([]);
  });
});

describe('the arrangement check', () => {
  it('finds what is wrong with the stacked song', () => {
    const { s } = stacked();
    const codes = new Set(checkArrangement(s, s.doc.getState().project, { style: 'trap' }).map((f) => `${f.code}:${f.severity}`));
    for (const c of ['stacked:bug', 'static-loop:bug', 'layered-fill:bug', 'crash-spam:bug', 'no-gap:bug', 'no-fill:bug']) expect(codes).toContain(c);
  });
});

describe('developing a song in place (no AI)', () => {
  it('the stacked song: one undo step; fills replace the groove, gaps before the drops, no duplicate FX, nothing stacked', () => {
    const { s } = stacked();
    const before = s.doc.getState().project;
    const res = developSong(s);
    expect(res.changed).toBe(true);
    expect(res.message).toMatch(/^Developed bars 1–112: \d+ fills, 4 builds \(gap, riser, impact\)/);
    expect(s.history.steps().done.map((e) => e.label)).toEqual(['song', 'Develop the song']);
    const p = s.doc.getState().project;
    expect(projectViolations(p)).toEqual([]);
    expect(songCheck(p).filter((i) => i.kind === 'stacked' || i.kind === 'doubled')).toEqual([]);
    // Gaps: nothing low or drummy sounds in the last beat before Drop (bar 37) and Drop 2 (bar 69).
    for (const bar of [37, 69, 89]) expect(grooveIn(p, (bar - 1) * BAR - BEAT, (bar - 1) * BAR)).toEqual([]);
    // The tom fill on Track 9 now plays alone: no other drums under its hits.
    const findings = checkArrangement(s, p, { style: 'trap' });
    expect(findings.filter((f) => f.code === 'layered-fill')).toEqual([]);
    expect(findings.filter((f) => f.code === 'crash-spam')).toEqual([]);
    expect(findings.filter((f) => f.code === 'no-gap')).toEqual([]);
    // No two FX of a kind on one downbeat.
    const env = variantEnvFor(p, 'trap');
    const fx = existingFx(p, env).filter((f) => f.kind !== 'crash');
    for (const f of fx) expect(fx.filter((g) => g.kind === f.kind && Math.abs(g.at - f.at) <= BEAT).length, `${f.kind} at bar ${f.at / BAR + 1}`).toBe(1);
    // Undo brings the song back exactly.
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('develops only the part asked for', () => {
    const { s } = stacked();
    const before = s.doc.getState().project;
    developSong(s, { from: 36 * BAR, to: 52 * BAR });
    const p = s.doc.getState().project;
    // Clips well before the part are untouched.
    const early = (q: Project) => Object.values(q.playlist.clips).filter((c) => c.start + c.length <= 34 * BAR);
    expect(early(p)).toEqual(early(before));
  });
});

describe('one spot at a time', () => {
  function beatSong() {
    const s = createTestServices();
    s.history.transact('beat', (d) => {
      const k = addKit(d);
      const pid = d.patternOrder[0]!;
      const pat = d.patterns[pid]!;
      pat.name = 'Beat';
      pat.length = 2 * BAR;
      pat.stepCount = 32;
      pat.notes = trapGroove(k) as never;
      const lane = d.playlist.laneOrder[0]!;
      for (let b = 0; b < 8; b += 2)
        d.playlist.clips[`c${b}` as never] = { kind: 'pattern', id: `c${b}`, laneId: lane, start: b * BAR, length: 2 * BAR, patternId: pid, offset: 0 } as never;
      d.patterns[pid]!.notes[k.pad] = notes([[0, 60, 32]]) as never;
    });
    return s;
  }

  it('adds a fill at the end of a bar as a variant of that clip, and a transition at a bar', () => {
    const s = beatSong();
    const fill = addFillAt(s, 3 * BAR + 100);
    expect(fill.message).toMatch(/^Added a fill at the end of bar 4/);
    const p = s.doc.getState().project;
    const variant = Object.values(p.patterns).find((x) => x.derived)!;
    expect(derivedLabel(p, variant)).toBe('variant of “Beat”: fill');
    const t = addTransitionAt(s, 4 * BAR);
    expect(t.changed).toBe(true);
    expect(s.history.steps().done.length).toBe(3);
  });

  it('refresh rebuilds a variant after its source was edited by hand', () => {
    const s = beatSong();
    addFillAt(s, 3 * BAR);
    const p = s.doc.getState().project;
    const variant = Object.values(p.patterns).find((x) => x.derived)!;
    const source = variant.derived!.from;
    s.history.transact('edit source', (d) =>
      produce(d, () => {
        const pat = d.patterns[source]!;
        const kick = Object.keys(pat.notes).find((cid) => d.channels[cid as never]?.name === 'Kick')!;
        for (const n of Object.values(pat.notes[kick as never]!)) n.velocity = 0.42;
      }),
    );
    expect(refreshVariations(s).message).toBe('Rebuilt 1 variation from their source patterns.');
    const after = s.doc.getState().project.patterns[variant.id]!;
    const kick = Object.keys(after.notes).find((cid) => s.doc.getState().project.channels[cid as never]?.name === 'Kick')!;
    expect(Object.values(after.notes[kick as never]!).some((n) => n.velocity === 0.42)).toBe(true);
    expect(refreshVariations(s).message).toBe('The variations are up to date.');
  });
});
