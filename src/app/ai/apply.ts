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
import { recordingAfter } from './ops/recording';
import { sessionAfter } from './ops/session';
import { decksAfter } from './ops/decks';
import { launcherAfter } from './ops/launcher';
import { mixerStateAfter } from './ops/mixer-state';
import { uiAfter } from './ops/ui';
import type { AiAnswer } from './schema';

export type { AfterEdit, AppliedTurn, ApplyContext, AuditionPhrase } from './ops/types';
export { coerceParam, parseKey } from './ops/values';

/** `source` names who asked in the undo label ("Claude Code: …"); the Studio chat is the default. */
export function applyAnswer(services: Services, answer: AiAnswer, context: ApplyContext & { source?: string }): AppliedTurn {
  const state = newAnswerState();
  const docActions = answer.actions.filter((a) => !UI_OP_NAMES.has(a.op));
  const words = (context.label ?? answer.message.split(/[.!?]/)[0] ?? '').trim();
  const label = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words || 'edit';
  let finished: ReturnType<ReturnType<typeof createOpContext>['focus']['finish']> | null = null;

  if (context.dryRun && docActions.length === 0) return { changes: [], warnings: [], beat: null, after: [], edited: false };
  let edited: boolean;
  try {
    edited =
      docActions.length > 0 &&
      services.history.transact(`${context.source ?? 'Studio'}: ${label}`, (d) => {
        const c = createOpContext(services, d, answer, context, state);
        for (const a of docActions) {
          const fn = DOC_OPS[a.op];
          if (!fn) continue;
          try {
            const note = fn(a, c);
            if (note) state.changes.push(note);
          } catch (error) {
            if (error instanceof ActionError) state.warnings.push(`${a.op.replace(/_/g, ' ')}: ${error.message}`);
            else throw error;
          }
        }
        for (const m of MODULES) m.beforeCommit?.(c);
        finished = c.focus.finish();
        // A dry run stops here: throwing out of the recipe leaves the project as it was.
        if (context.dryRun) throw DRY_RUN;
      });
  } catch (error) {
    if (error !== DRY_RUN) throw error;
    return {
      changes: state.changes,
      warnings: state.warnings,
      beat: null,
      after: [],
      edited: false,
      outsideFocus: state.outsideFocus,
    };
  }

  uiAfter(services, answer, state);
  recordingAfter(services, answer, state);
  decksAfter(services, answer, state);
  launcherAfter(services, answer, state);
  mixerStateAfter(services, answer, state);

  const project = services.doc.getState().project;
  if (state.selectPattern && project.patterns[state.selectPattern])
    services.view.getState().setCurrentPattern(state.selectPattern);
  if (state.selectChannel && project.channels[state.selectChannel])
    services.session.getState().selectChannel(state.selectChannel);
  const beat = state.beatPlan ? showBeat(services, state.beatPlan) : null;
  const done = finished as { focus: AppliedTurn['focus']; clips: NonNullable<AppliedTurn['selectClips']> } | null;
  sessionAfter(services, answer, state);
  queryAfter(services, answer, state);
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
