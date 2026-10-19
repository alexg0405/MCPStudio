/** The MCP tools that change the project: apply_actions (the studio chat's edits) and the command tools. */
import { aiCommands, commandCatalog } from '../ai/commands';
import { readAnswer } from '../ai/schema';
import type { ExternalApplied } from '../assistant/state';
import { barsArg, clientLabel, fail, ok, str, type ToolFn } from './common';
import { barsFocus } from './read-tools';
import type { ToolDeps } from './tool-deps';

/** How long `run_command` waits for an async command to report a problem as a toast, in milliseconds. */
const ASYNC_COMMAND_SETTLE_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `apply_actions` result for an edit that changes things outside the part the AI said it was working on. */
function needsApprovalResult(out: ExternalApplied) {
  const part = out.part ?? 'the part';
  const outside = out.outside ?? [];
  return ok(
    `Not applied yet. This edit also changes things outside ${part}:\n${outside.map((o) => `- ${o}`).join('\n')}\n` +
      `Nothing changed. To allow it, call apply_actions again with the same actions and approve_outside: true; or change the actions so they stay inside ${part}.`,
    { applied: false, needs_approval: true, part, outside },
  );
}

/** Words for the AI about what an applied edit did, line by line. */
function appliedLines(out: ExternalApplied, undoLabel: string | undefined, skippedCount: number, hasAnalyzeMix: boolean): string[] {
  return [
    out.edited ? `Applied as one undo step${undoLabel ? ` ("${undoLabel}")` : ''}.` : 'Nothing in the project changed.',
    ...(out.changes.length ? ['Changes:', ...out.changes.map((c) => `- ${c}`)] : []),
    ...(out.warnings.length ? ['Could not do:', ...out.warnings.map((w) => `- ${w}`)] : []),
    ...(out.followups.length ? ['Follow-up steps:', ...out.followups.map((f) => `- ${f}`)] : []),
    ...(out.findings?.length ? ['Song check:', ...out.findings.map((f) => `- ${f}`)] : []),
    ...(out.lookups ? ['Looked up (the read tools have the same):', out.lookups] : []),
    ...(skippedCount > 0 ? [`${skippedCount} action${skippedCount === 1 ? ' was' : 's were'} skipped: unknown "op".`] : []),
    ...(hasAnalyzeMix ? ['The analyze_mix action only works in the Studio chat: call the analyze_mix tool to listen to the mix.'] : []),
    ...(out.edited ? [`To go back: undo, or undo with to_point ${out.beforePoint}.`] : []),
  ];
}

/** The `apply_actions` and the two command tools, which need the page's way of asking for a click. */
export function editTools(deps: ToolDeps): Record<'apply_actions' | 'list_commands' | 'run_command', ToolFn> {
  const applyActions: ToolFn = async (s, args, ctx) => {
    const bars = barsArg(args.focus);
    if (typeof bars === 'string') return fail(bars);
    const parsed = readAnswer({ message: str(args.summary) ?? '', actions: args.actions });
    if ('error' in parsed) return fail(`Can't apply that: ${parsed.error}.`);
    const { answer, dropped } = parsed;
    if (answer.actions.length === 0) {
      return fail(
        dropped > 0
          ? `None of the ${dropped} actions has a known "op". Read get_guide for the list of actions.`
          : 'No actions given. Pass the edits in "actions".',
      );
    }
    const client = clientLabel(ctx.client);
    const summary = answer.message || 'edited the project';
    const focus = bars ? barsFocus(s, bars.from, bars.to) : null;
    const assistant = await s.assistant.load();
    const out = await assistant.applyExternal(
      { ...answer, message: summary },
      {
        client,
        summary,
        focus,
        approveOutside: args.approve_outside === true,
        onGesture: (id, a) => deps.gesture?.(client, id, a),
      },
    );
    if (out.status === 'busy') return fail(out.warnings[0] ?? 'Studio is busy.');
    if (out.status === 'needs_approval') return needsApprovalResult(out);
    const undoLabel = s.history.status().undoLabel;
    const hasAnalyzeMix = answer.actions.some((a) => a.op === 'analyze_mix');
    return ok(appliedLines(out, undoLabel, dropped, hasAnalyzeMix).join('\n'), {
      applied: out.edited,
      changes: out.changes,
      warnings: out.warnings,
      followups: out.followups,
      before_point: out.beforePoint,
      undo_point: out.undoPoint,
      history_label: out.edited ? (undoLabel ?? null) : null,
    });
  };

  const listCommands: ToolFn = (s, args) => {
    const search = str(args.search)?.toLowerCase();
    const defs = aiCommands(s).filter((d) => !search || `${d.id} ${d.title} ${d.hint ?? ''}`.toLowerCase().includes(search));
    const catalogText = commandCatalog(s).text;
    // The catalog's first line is its heading: it stays when searching.
    const text = search ? catalogText.split('\n').filter((line, i) => i === 0 || line.toLowerCase().includes(search)).join('\n') : catalogText;
    return ok(text.replace('(run with the command action, after the edits)', '(run with run_command)'), {
      commands: defs.map((d) => ({
        id: d.id,
        title: d.title,
        ...(d.category ? { category: d.category } : {}),
        ...(d.hint ? { hint: d.hint } : {}),
        ...(d.argsHint ? { args: d.argsHint } : {}),
        ...(d.checked ? { toggle: true } : {}),
        ...(d.gesture ? { needs_musician_click: true } : {}),
      })),
    });
  };

  const runCommand: ToolFn = async (s, args, ctx) => {
    const id = str(args.id);
    if (!id) return fail('Say which command to run: its id from list_commands.');
    const def = aiCommands(s).find((d) => d.id === id);
    if (!def) {
      const keptNote = s.commands.get(id) ? ' (that one needs arguments nobody described, or is kept for the musician)' : '';
      return fail(`No command "${id}" is available to AI apps. Use list_commands to see the ids${keptNote}.`);
    }
    if (!s.commands.isEnabled(id)) return fail(`"${def.title}" isn't available right now (the app is in a state where it can't run).`);
    const client = clientLabel(ctx.client);
    const title = def.title.replace(/…$/, '');
    if (def.gesture) {
      deps.gesture?.(client, id, args.args);
      return ok(
        `"${title}" opens a file dialog, and the browser only allows that right after a click. AGstudio now shows the musician a button ("${client} wants to run ${title}: click to continue"). It has not run yet; ask them to click it.`,
        { ran: false, waiting_for_click: true },
      );
    }
    const cursorBefore = s.history.status().cursor;
    const toastsBefore = new Set(s.session.getState().toasts.map((t) => t.id));
    if (!s.commands.run(id, args.args)) return fail(`"${title}" could not run.`);
    await sleep(ASYNC_COMMAND_SETTLE_MS); // async commands report problems as toasts a moment later
    const newToasts = s.session.getState().toasts.filter((t) => !toastsBefore.has(t.id));
    const after = s.history.status();
    if (after.cursor !== cursorBefore) (await s.assistant.load()).reportExternal(client, `ran “${title}”`, { undo: after.cursor });
    const problem = newToasts.find((t) => t.kind === 'error');
    const lines = [
      problem ? `"${title}" ran but reported a problem: ${problem.text}` : `Ran "${title}".`,
      ...newToasts.filter((t) => t !== problem).map((t) => `AGstudio said: ${t.text}`),
      ...(def.checked ? [`It is now ${s.commands.isChecked(id) ? 'on' : 'off'}.`] : []),
    ];
    const result = ok(lines.join('\n'), { ran: true, changed_project: after.cursor !== cursorBefore });
    return problem ? { ...result, isError: true } : result;
  };

  return { apply_actions: applyActions, list_commands: listCommands, run_command: runCommand };
}
