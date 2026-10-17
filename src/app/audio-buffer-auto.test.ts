import { describe, expect, it } from 'vitest';
import {
  AutoBuffer,
  BLOCK_DOWN_MS,
  CLEAN_SECONDS,
  CLEAN_SECONDS_LIVE,
  MIN_STEP_GAP_MS,
  SETTLE_SECONDS,
  TRIAL_SECONDS,
} from './audio-buffer-auto';

/** Feeds one reading per second from second `from`; returns the steps taken, with the second they came at. */
function run(auto: AutoBuffer, from: number, seconds: number, keepUp: number, live = false) {
  const steps: { at: number; size: string }[] = [];
  for (let t = from; t < from + seconds; t++) {
    const next = auto.observe(keepUp, t * 1000, live);
    if (next) steps.push({ at: t, size: next });
  }
  return steps;
}

describe('AutoBuffer', () => {
  it('stays small while playback keeps up', () => {
    const auto = new AutoBuffer('small');
    expect(run(auto, 0, 100, 1)).toEqual([]);
    expect(auto.size).toBe('small');
  });

  it('steps up after two struggling seconds in a row, not after one', () => {
    const auto = new AutoBuffer('small');
    expect(auto.observe(0.9, 0)).toBeNull();
    expect(auto.observe(1, 1000)).toBeNull();
    expect(auto.observe(0.9, 2000)).toBeNull();
    expect(auto.observe(0.9, 3000)).toBe('medium');
  });

  it('steps up at once when playback collapses', () => {
    const auto = new AutoBuffer('small');
    expect(auto.observe(0.5, 0)).toBe('medium');
  });

  it('never steps twice within a few seconds, and ignores the seconds right after a step', () => {
    const auto = new AutoBuffer('small');
    const steps = run(auto, 0, 40, 0.5);
    expect(steps.map((s) => s.size)).toEqual(['medium', 'large']);
    const a = steps[0]!;
    const b = steps[1]!;
    expect(b.at - a.at).toBeGreaterThanOrEqual(MIN_STEP_GAP_MS / 1000);
    expect(b.at - a.at).toBeGreaterThan(SETTLE_SECONDS);
    // Nothing above large.
    expect(run(auto, 40, 60, 0.3)).toEqual([]);
    expect(auto.size).toBe('large');
  });

  it('tries a smaller buffer after a long clean stretch, and keeps going down while that works', () => {
    const auto = new AutoBuffer('large');
    const steps = run(auto, 0, CLEAN_SECONDS + 5, 1);
    expect(steps.map((s) => s.size)).toEqual(['medium']);
    expect(run(auto, CLEAN_SECONDS + 5, CLEAN_SECONDS + 5, 1).map((s) => s.size)).toEqual(['small']);
  });

  it('goes back up when the smaller buffer struggles, and does not try again for a while', () => {
    const auto = new AutoBuffer('large');
    let t = 0;
    expect(run(auto, t, CLEAN_SECONDS + 2, 1).map((s) => s.size)).toEqual(['medium']);
    t += CLEAN_SECONDS + 2;
    expect(run(auto, t, 12, 0.8).map((s) => s.size)).toEqual(['large']);
    t += 12;
    const blocked = Math.floor(BLOCK_DOWN_MS / 1000);
    // A clean stretch for nearly the whole block: no second try.
    expect(run(auto, t, blocked - 60, 1)).toEqual([]);
    // After it, one.
    expect(run(auto, t + blocked - 60, 120, 1).map((s) => s.size)).toEqual(['medium']);
  });

  it('a smaller buffer that held past the trial is not blocked when a busy part makes it step up later', () => {
    const auto = new AutoBuffer('large');
    run(auto, 0, CLEAN_SECONDS + 2, 1);
    expect(auto.size).toBe('medium');
    const t = CLEAN_SECONDS + 2;
    run(auto, t, TRIAL_SECONDS + 5, 1);
    expect(run(auto, t + TRIAL_SECONDS + 5, 6, 0.8).map((s) => s.size)).toEqual(['large']);
    expect(run(auto, t + TRIAL_SECONDS + 11, CLEAN_SECONDS + 5, 1).map((s) => s.size)).toEqual(['medium']);
  });

  it('tries sooner while a MIDI keyboard or the typing piano is in use', () => {
    const auto = new AutoBuffer('medium');
    expect(run(auto, 0, CLEAN_SECONDS_LIVE + 2, 1, true).map((s) => s.size)).toEqual(['small']);
  });

  it('does nothing before the engine has a reading', () => {
    const auto = new AutoBuffer('small');
    for (let t = 0; t < 10; t++) expect(auto.observe(undefined, t * 1000)).toBeNull();
  });
});
