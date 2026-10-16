import { describe, expect, it } from 'vitest';
import { resolveTarget } from '@core/automation/targets';
import type { AutomationChannel, AutomationClip, Project } from '@core/model/types';
import { createTestServices } from '@app/testing';
import { applyAnswer } from '../apply';
import { focusFromRange } from '../focus-capture';
import { resolveFocus } from '../focus';
import type { AiAction } from '../schema';
import { ownUnitOf } from './automation';

type TestServices = ReturnType<typeof createTestServices>;

const BAR = 3840;
const project = (s: TestServices): Project => s.doc.getState().project;

const run = (s: TestServices, actions: AiAction[], focus: ReturnType<typeof resolveFocus> = null, outside?: 'allow') =>
  applyAnswer(
    s,
    { message: 'ok', actions },
    { previousBeat: null, focus, ...(outside ? { focusOutside: outside } : {}) },
  );

/** A channel's curve as [bar, value in the control's unit] pairs, read the way get_automation reads it. */
function curveOf(s: TestServices, name = 'Volume · Master'): [number, number | string | boolean][] {
  const p = project(s);
  const ch = Object.values(p.channels).find((c): c is AutomationChannel => c.kind === 'automation' && c.name === name)!;
  const res = resolveTarget(p, ch.target!, () => undefined, ch.range)!;
  return ch.points.map((pt) => [pt.tick / BAR, ownUnitOf(res, ch.target!, pt.value)]);
}

const clipOf = (s: TestServices, name = 'Volume · Master'): AutomationClip => {
  const p = project(s);
  const ch = Object.values(p.channels).find((c) => c.kind === 'automation' && c.name === name)!;
  return Object.values(p.playlist.clips).find(
    (c): c is AutomationClip => c.kind === 'automation' && c.channelId === ch.id,
  )!;
};

/** A master volume fade over one 4-bar clip at bar 1: −60 dB at bar 0, −12 dB at bar 2, 0 dB at bar 4. */
function fadeSong(): TestServices {
  const s = createTestServices();
  const made = run(s, [
    {
      op: 'automate',
      ref: '@fade',
      target: { kind: 'track_volume', insert: 'master' },
      from_bar: 1,
      bars: 4,
      points: [
        { bar: 0, value: -60 },
        { bar: 2, value: -12 },
        { bar: 4, value: 0 },
      ],
    },
  ]);
  expect(made.warnings).toEqual([]);
  expect(curveOf(s)).toEqual([
    [0, -60],
    [2, -12],
    [4, 0],
  ]);
  return s;
}

describe('edit_automation: each mode', () => {
  it('set_points replaces the points in a bar range and keeps the rest', () => {
    const s = fadeSong();
    const res = run(s, [
      {
        op: 'edit_automation',
        channel: 'Volume · Master',
        mode: 'set_points',
        from: 1,
        to: 3,
        points: [
          { bar: 1.5, value: -30 },
          { bar: 2.5, value: -20 },
        ],
      },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Volume · Master: set 2 points in bars 1–3']);
    expect(curveOf(s)).toEqual([
      [0, -60],
      [1.5, -30],
      [2.5, -20],
      [4, 0],
    ]);
  });

  it('move shifts the points in a range by N bars, and the clip grows when the curve runs past its end', () => {
    const s = fadeSong();
    const shifted = run(s, [
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'move', from: 2, to: 4, by: 1 },
    ]);
    expect(shifted.warnings).toEqual([]);
    expect(shifted.changes).toEqual(['Volume · Master: moved 1 point by +1 bar']);
    expect(curveOf(s)).toEqual([
      [0, -60],
      [3, -12],
      [4, 0],
    ]);
    expect(clipOf(s).length).toBe(4 * BAR);

    const late = run(s, [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'move', from: 4, by: 2 }]);
    expect(late.changes).toEqual(['Volume · Master: moved 1 point by +2 bars']);
    expect(curveOf(s)).toEqual([
      [0, -60],
      [3, -12],
      [6, 0],
    ]);
    // The point at bar 6 is past the clip's end: the clip now runs to bar 6.
    expect(clipOf(s).length).toBe(6 * BAR);
  });

  it('scale multiplies the distance from the middle of the values, in dB', () => {
    const s = fadeSong();
    // Values −60, −12, 0 dB: the middle is −30 dB; halving each distance from it gives −45, −21, −15 dB.
    const res = run(s, [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'scale', factor: 0.5 }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Volume · Master: scaled 3 points around their middle (×0.5)']);
    const got = curveOf(s);
    expect(got.map(([bar, v]) => [bar, Number(v)])).toEqual([
      [0, -45],
      [2, -21],
      [4, -15],
    ]);
  });

  it('remove deletes the points in a range', () => {
    const s = fadeSong();
    const res = run(s, [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'remove', from: 2, to: 3 }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Volume · Master: removed 1 point']);
    expect(curveOf(s)).toEqual([
      [0, -60],
      [4, 0],
    ]);
  });

  it('tension sets the bend of the curve leaving the points in a range', () => {
    const s = fadeSong();
    const res = run(s, [
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'tension', from: 0, to: 2, tension: 0.5 },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Volume · Master: set the tension of 1 point to 0.5']);
    const ch = Object.values(project(s).channels).find((c) => c.kind === 'automation') as AutomationChannel;
    expect(ch.points[0]).toMatchObject({ tick: 0, tension: 0.5 });
    expect(ch.points[1]!.tension).toBeUndefined();
    expect(curveOf(s)).toEqual([
      [0, -60],
      [2, -12],
      [4, 0],
    ]);
  });

  it('finds the channel by what it drives, as get_automation reports it', () => {
    const s = fadeSong();
    const res = run(s, [{ op: 'edit_automation', drives: 'Volume · Master', mode: 'remove', from: 2, to: 3 }]);
    expect(res.changes).toEqual(['Volume · Master: removed 1 point']);
  });
});

describe('edit_automation: invalid arguments give warnings, not throws', () => {
  const cases: [string, AiAction, string][] = [
    ['an unknown mode', { op: 'edit_automation', channel: 'Volume · Master', mode: 'bend' }, 'unknown mode "bend"'],
    ['no channel or target', { op: 'edit_automation', mode: 'move', by: 1 }, 'which automation?'],
    [
      'a channel that does not exist',
      { op: 'edit_automation', channel: 'nobody', mode: 'move', by: 1 },
      'there is no channel',
    ],
    [
      'a drives name nothing has',
      { op: 'edit_automation', drives: 'Cutoff · Nothing', mode: 'move', by: 1 },
      'nothing drives',
    ],
    [
      'a range that ends before it starts',
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'remove', from: 3, to: 1 },
      'before it starts',
    ],
    [
      'set_points without points',
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'set_points' },
      'set_points needs points',
    ],
    [
      'a range with no points',
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'tension', from: 10, to: 12, tension: 0.5 },
      'no points in bars 10–12',
    ],
    ['move without by', { op: 'edit_automation', channel: 'Volume · Master', mode: 'move' }, 'move needs by'],
    [
      'a negative scale factor',
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'scale', factor: -1 },
      'scale needs factor',
    ],
    [
      'tension without a value',
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'tension' },
      'tension needs tension',
    ],
  ];
  for (const [what, action, warning] of cases)
    it(`refuses ${what}, and changes nothing`, () => {
      const s = fadeSong();
      const before = curveOf(s);
      const clip = clipOf(s);
      let res!: ReturnType<typeof run>;
      expect(() => (res = run(s, [action]))).not.toThrow();
      expect(res.warnings).toEqual([expect.stringContaining(warning)]);
      expect(res.changes).toEqual([]);
      expect(curveOf(s)).toEqual(before);
      expect(clipOf(s)).toEqual(clip);
    });

  it('warns about set_points points outside the range and keeps the ones inside', () => {
    const s = fadeSong();
    const res = run(s, [
      {
        op: 'edit_automation',
        channel: 'Volume · Master',
        mode: 'set_points',
        from: 1,
        to: 3,
        points: [
          { bar: 0.5, value: -30 },
          { bar: 2, value: -20 },
        ],
      },
    ]);
    expect(res.warnings).toEqual([expect.stringContaining('automation point at bar 0.5 is outside bars 1–3')]);
    expect(res.changes).toEqual(['Volume · Master: set 1 point in bars 1–3']);
    expect(curveOf(s)).toEqual([
      [0, -60],
      [2, -20],
      [4, 0],
    ]);
  });

  it('refuses to remove every point of a curve', () => {
    const s = fadeSong();
    const before = curveOf(s);
    const res = run(s, [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'remove' }]);
    expect(res.warnings).toEqual([expect.stringContaining('a curve keeps at least one')]);
    expect(curveOf(s)).toEqual(before);
  });
});

describe('edit_automation: undo', () => {
  it('two edits in one answer are one undo step, and undo restores the project exactly', () => {
    const s = fadeSong();
    const before = project(s);
    const steps = s.history.steps().done.length;
    const res = run(s, [
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'move', from: 4, by: 2 },
      { op: 'edit_automation', channel: 'Volume · Master', mode: 'tension', from: 0, to: 2, tension: -0.5 },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.edited).toBe(true);
    expect(s.history.steps().done.length).toBe(steps + 1);
    expect(clipOf(s).length).toBe(6 * BAR);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });
});

describe('edit_automation: the part of the song being worked on', () => {
  /** Automation at bars 40–43 (outside the part) and bars 20–23 (inside it). */
  function songWithTwoClips() {
    const s = createTestServices();
    run(s, [
      {
        op: 'automate',
        target: { kind: 'track_volume', insert: 'master' },
        from_bar: 40,
        bars: 4,
        points: [
          { bar: 0, value: -60 },
          { bar: 4, value: 0 },
        ],
      },
      {
        op: 'automate',
        target: { kind: 'track_pan', insert: 'master' },
        from_bar: 20,
        bars: 4,
        points: [
          { bar: 0, value: 0 },
          { bar: 4, value: 0.5 },
        ],
      },
    ]);
    return s;
  }

  it('refuses an edit that reaches outside the part, until the musician approves it', () => {
    const s = songWithTwoClips();
    const focus = resolveFocus(project(s), focusFromRange(s, 16 * BAR, 32 * BAR));
    const before = curveOf(s);
    const refused = run(s, [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'move', by: 1 }], focus);
    // The curve's last point moves to bar 5, so the clip grows to bar 44: that stretch is outside the part.
    expect(refused.warnings).toEqual([expect.stringContaining('bars 40–44 reach outside the part')]);
    expect(refused.changes).toEqual([]);
    expect(curveOf(s)).toEqual(before);

    const approved = run(
      s,
      [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'move', by: 1 }],
      focus,
      'allow',
    );
    expect(approved.warnings).toEqual([]);
    expect(approved.outsideFocus).toEqual([expect.stringContaining('bars 40–44 reach outside the part')]);
    expect(curveOf(s)).toEqual([
      [1, -60],
      [5, 0],
    ]);
  });

  it('allows an edit inside the part that changes nothing a clip leaves behind', () => {
    const s = songWithTwoClips();
    const focus = resolveFocus(project(s), focusFromRange(s, 16 * BAR, 32 * BAR));
    const res = run(
      s,
      [{ op: 'edit_automation', channel: 'Pan · Master', mode: 'tension', from: 0, to: 1, tension: 0.5 }],
      focus,
    );
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Pan · Master: set the tension of 1 point to 0.5']);
  });

  it('refuses an edit inside the part that changes the value the clip leaves behind', () => {
    const s = songWithTwoClips();
    const focus = resolveFocus(project(s), focusFromRange(s, 16 * BAR, 32 * BAR));
    // The last point (0.5 at bar 4, where the clip ends) is replaced: the pan the clip leaves behind changes for the rest of the song.
    const res = run(
      s,
      [
        {
          op: 'edit_automation',
          channel: 'Pan · Master',
          mode: 'set_points',
          from: 3,
          to: 5,
          points: [{ bar: 3.5, value: 0.9 }],
        },
      ],
      focus,
    );
    expect(res.warnings).toEqual([expect.stringContaining('the whole song reaches outside the part')]);
    expect(res.changes).toEqual([]);
  });
});

describe('edit_automation: the clip itself', () => {
  it('keeps the clip the same length when the curve stays inside it', () => {
    const s = fadeSong();
    const length = clipOf(s).length;
    run(s, [{ op: 'edit_automation', channel: 'Volume · Master', mode: 'scale', factor: 0.25 }]);
    expect(clipOf(s).length).toBe(length);
  });
});
