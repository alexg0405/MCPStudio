/** Choosing which take the comp plays: use a take (or part of it), step to the next or previous take. */
import { chooseTake, compRange, stepTakeFor } from '@app/actions/comp';
import type { Services } from '@app/services';
import { GROUP_ARGS, hasTakeGroup, takeIndexOf, takeTarget, type TakeArgs } from './target';

/** The commands that step through takes: id, title, direction, shortcut key, hint. */
const STEP_COMMANDS = [
  { id: 'comp.nextTake', title: 'Next take', direction: 1, key: ']', hint: 'Swap the selected part of the comp (or the clip under the pointer) for the next take; it goes round' },
  { id: 'comp.previousTake', title: 'Previous take', direction: -1, key: '[', hint: 'Swap the selected part of the comp (or the clip under the pointer) for the previous take' },
] as const;

/** Registers `comp.useTake`, `comp.nextTake` and `comp.previousTake` (the last two with their keys on the playlist). */
export function registerChooseCommands(services: Services): void {
  const { commands, keymap } = services;
  commands.register<TakeArgs>({
    id: 'comp.useTake',
    title: 'Use this take',
    category: 'Takes',
    hint: 'The comp track plays the selected take (all of it), or only from_bar–to_bar of it. Drag across a take with the Comp tool to pick a part by hand',
    argsHint: `{ take: 1-based take number (default: the selected take clip's), from_bar and to_bar to use only those bars (default: the whole take), clip or group to say which recording }`,
    enabled: hasTakeGroup,
    run: (s, args) => {
      const target = takeTarget(s, args);
      if (!target) return;
      const take = takeIndexOf(s, target, args);
      if (take === null) return;
      const range = typeof args?.from_bar === 'number' ? compRange(s, target, args) : undefined;
      if (!chooseTake(s, target.group.id, take, range)) {
        s.session.getState().toast('Nothing changed: that take has no audio there, or already plays there.');
      }
    },
  });
  for (const { id, title, direction, key, hint } of STEP_COMMANDS) {
    commands.register<TakeArgs>({
      id,
      title,
      category: 'Takes',
      hint,
      argsHint: `${GROUP_ARGS}; from_bar and to_bar to say which bars (default: the clip's own span)`,
      enabled: hasTakeGroup,
      run: (s, args) => {
        const target = takeTarget(s, args);
        if (!target) return;
        const now = stepTakeFor(s, target.group.id, compRange(s, target, args), direction);
        if (now === null) {
          s.session.getState().toast('No other take has audio there.');
          return;
        }
        const number = target.group.takes.findIndex((take) => take.index === now) + 1;
        s.session.getState().setHint(`The comp plays take ${number} here`);
      },
    });
    keymap.add([{ chord: key, command: id, when: { focus: ['playlist'] } }]);
  }
}
