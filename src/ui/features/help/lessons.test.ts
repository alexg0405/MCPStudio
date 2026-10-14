import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import type { ChannelId, PatternId } from '@core/model/types';
import { setStep } from '@core/ops/notes';
import { LESSONS } from './lessons';

/** The lesson checks pass exactly when the project shows the step was done. */
describe('lessons', () => {
  it('“Your first beat” follows the beat as it is clicked in', async () => {
    const s = createTestServices();
    const lesson = LESSONS.find((l) => l.id === 'first-beat')!;
    expect(await lesson.start!(s)).toBe(true);
    const p = () => s.doc.getState().project;
    const pid = p().patternOrder[0] as PatternId;
    s.view.getState().setCurrentPattern(pid);
    const id = (name: string) => p().channelOrder.find((c) => p().channels[c]?.name === name) as ChannelId;
    const click = (name: string, ...steps: number[]) =>
      s.history.transact('steps', (d) => {
        for (const i of steps) setStep(d, pid, id(name), i, true, { rootKey: 60 });
      });
    const [kick, clap, hats, play, tempo] = lesson.steps;
    expect(kick!.done(s)).toBe(false);
    click('Kick', 0, 4, 8);
    expect(kick!.done(s)).toBe(false);
    click('Kick', 12);
    expect(kick!.done(s)).toBe(true);
    click('Clap', 4, 12);
    expect(clap!.done(s)).toBe(true);
    click('Hat', 0, 2, 4, 6, 8, 10);
    expect(hats!.done(s)).toBe(false);
    click('Hat', 12, 14);
    expect(hats!.done(s)).toBe(true);
    expect(play!.done(s)).toBe(false);
    s.engine.play(0);
    expect(play!.done(s)).toBe(true);
    tempo!.prepare!(s);
    expect(tempo!.done(s)).toBe(false);
    s.history.transact('tempo', (d) => void (d.transport.bpm += 8));
    expect(tempo!.done(s)).toBe(true);
    // Every step points somewhere to look.
    for (const step of lesson.steps) expect(step.anchor?.(s)).toBeTruthy();
  });

  it('every lesson has steps with plain instructions', () => {
    for (const l of LESSONS) {
      expect(l.steps.length).toBeGreaterThan(2);
      for (const step of l.steps) expect(step.text.length).toBeGreaterThan(20);
    }
  });
});
