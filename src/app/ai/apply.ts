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
import { queryAfter } from './ops/query';
import { sessionAfter } from './ops/session';
import { decksAfter } from './ops/decks';
import { uiAfter } from './ops/ui';
import type { AiAnswer } from './schema';

export type { AfterEdit, AppliedTurn, ApplyContext, AuditionPhrase } from './ops/types';
export { coerceParam, parseKey } from './ops/values';

/** `source` names who asked in the undo label ("Claude Code: …"); the Studio chat is the default. */
export function applyAnswer(s: Services, answer: AiAnswer, ctx: ApplyContext & { source?: string }): AppliedTurn {
  const state = newAnswerState();
  const docActions = answer.actions.filter((a) => !UI_OP_NAMES.has(a.op));
  const words = (ctx.label ?? answer.message.split(/[.!?]/)[0] ?? '').trim();
  const label = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words || 'edit';
  let finished: ReturnType<ReturnType<typeof createOpContext>['focus']['finish']> | null = null;

  if (ctx.dryRun && docActions.length === 0) return { changes: [], warnings: [], beat: null, after: [], edited: false };
  let edited: boolean;
  try {
    edited =
      docActions.length > 0 &&
      s.history.transact(`${ctx.source ?? 'Studio'}: ${label}`, (d) => {
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
        // A dry run stops here: throwing out of the recipe leaves the project as it was.
        if (ctx.dryRun) throw DRY_RUN;
      });
  } catch (e) {
    if (e !== DRY_RUN) throw e;
    return {
      changes: state.changes,
      warnings: state.warnings,
      beat: null,
      after: [],
      edited: false,
      outsideFocus: state.outsideFocus,
    };
  }

  uiAfter(s, answer, state);
  decksAfter(s, answer, state);

  const project = s.doc.getState().project;
  if (state.selectPattern && project.patterns[state.selectPattern])
    s.view.getState().setCurrentPattern(state.selectPattern);
  if (state.selectChannel && project.channels[state.selectChannel])
    s.session.getState().selectChannel(state.selectChannel);
  const beat = state.beatPlan ? showBeat(s, state.beatPlan) : null;
  const done = finished as { focus: AppliedTurn['focus']; clips: NonNullable<AppliedTurn['selectClips']> } | null;
  sessionAfter(s, answer, state);
  queryAfter(s, answer, state);
  return {
    changes: state.changes,
    warnings: state.warnings,
    ...(state.ui.length ? { ui: state.ui } : {}),
    ...(state.queries.length ? { queries: state.queries } : {}),
    beat,
    after: state.after,
    edited: !!edited,
    touched: state.touched,
    ...(done?.focus ? { focus: done.focus } : {}),
    ...(done?.clips.length ? { selectClips: done.clips } : {}),
    ...(state.outsideFocus.length ? { outsideFocus: state.outsideFocus } : {}),
  };
}

const DRY_RUN = Symbol('dry run');
