/**
 * Applies the AI's actions to the project as ONE undoable edit. Every field is validated: things are
 * found by id, exact name, mixer number or an @ref created earlier in the same answer; plugin
 * settings are coerced to each param's real spec (units, ranges, option ids). An action that can't
 * be applied is skipped with a warning; the rest still apply. UI-only requests (open a window, play)
 * are returned for the caller to run after the edit. The actions themselves live in `./ops`.
 */
import { showBeat } from '../assistant/apply';
import type { Services } from '../services';
import { DOC_OPS, MODULES, UI_OP_NAMES } from './ops';
import { ActionError, createOpContext, newAnswerState } from './ops/context';
import type { AppliedTurn, ApplyContext } from './ops/types';
import { uiAfter } from './ops/ui';
import type { AiAnswer } from './schema';

export type { AfterEdit, AppliedTurn, ApplyContext, AuditionPhrase } from './ops/types';
export { coerceParam, parseKey } from './ops/values';

export function applyAnswer(s: Services, answer: AiAnswer, ctx: ApplyContext): AppliedTurn {
  const state = newAnswerState();
  const docActions = answer.actions.filter((a) => !UI_OP_NAMES.has(a.op));
  const words = (ctx.label ?? answer.message.split(/[.!?]/)[0] ?? '').trim();
  const label = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words || 'edit';
  let finished: ReturnType<ReturnType<typeof createOpContext>['focus']['finish']> | null = null;

  const edited =
    docActions.length > 0 &&
    s.history.transact(`AI: ${label}`, (d) => {
      const c = createOpContext(s, d, answer, ctx, state);
      for (const a of docActions) {
        const fn = DOC_OPS[a.op];
        if (!fn) continue;
        try {
          const note = fn(a, c);
          if (note) state.changes.push(note);
        } catch (e) {
          if (e instanceof ActionError) state.warnings.push(`${a.op.replace(/_/g, ' ')}: ${e.message}`);
          else throw e;
        }
      }
      for (const m of MODULES) m.beforeCommit?.(c);
      finished = c.focus.finish();
    });

  uiAfter(s, answer, state);

  const project = s.doc.getState().project;
  if (state.selectPattern && project.patterns[state.selectPattern]) s.view.getState().setCurrentPattern(state.selectPattern);
  if (state.selectChannel && project.channels[state.selectChannel]) s.session.getState().selectChannel(state.selectChannel);
  const beat = state.beatPlan ? showBeat(s, state.beatPlan) : null;
  const done = finished as { focus: AppliedTurn['focus']; clips: NonNullable<AppliedTurn['selectClips']> } | null;
  return {
    changes: state.changes,
    warnings: state.warnings,
    beat,
    after: state.after,
    edited: !!edited,
    touched: state.touched,
    ...(done?.focus ? { focus: done.focus } : {}),
    ...(done?.clips.length ? { selectClips: done.clips } : {}),
  };
}
