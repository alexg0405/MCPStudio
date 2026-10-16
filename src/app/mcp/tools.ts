/**
 * What AI apps can do over MCP, running in the page (the dev server relays each call here, see
 * `bridge.ts`). Every project change goes through the same applier as the Studio chat
 * (`assistant.applyExternal`), so it is one undo step, shown in the chat with an Undo button.
 * Pure enough to unit test with `createTestServices`.
 */
import { ticksPerBar } from '@core/time/ppq';
import { barSpan } from '@core/time/bars';
import { barsToRange, findPattern, playFrom, playPattern, playRange } from '../actions/transport';
import { aiCommands, commandCatalog } from '../ai/commands';
import { readAnswer } from '../ai/schema';
import type { Services } from '../services';
import { audioTools, defaultAudioDeps, type AudioDeps } from './audio-tools';
import { barsArg, clientLabel, fail, int, ok, str, type Args, type ToolContext, type ToolFn } from './common';
import { barsFocus, READ_TOOLS } from './read-tools';
import type { ToolResult } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ToolDeps {
  audio?: AudioDeps;
  /** A command needs the musician's click: show them a button ("Claude Code wants to export…"). */
  gesture?(client: string, commandId: string, args: unknown): void;
}

export interface McpTools {
  /** Tool names this runtime can run. */
  names(): string[];
  call(name: string, args: Args, ctx?: ToolContext): Promise<ToolResult>;
}

const transportState = (s: Services) => {
  const p = s.doc.getState().project;
  const v = s.view.getState();
  const bar = ticksPerBar(p.transport.timeSig);
  const tick = s.engine.playing ? Math.round(s.engine.playhead()) : v.songStart;
  const h = s.history.status();
  return {
    playing: s.engine.playing,
    mode: v.mode,
    bpm: p.transport.bpm,
    time_signature: `${p.transport.timeSig.num}/${p.transport.timeSig.den}`,
    bar: Math.floor(tick / bar) + 1,
    tick,
    song_start_bar: Math.floor(v.songStart / bar) + 1,
    loop: v.loop ? { from_bar: Math.floor(v.loop.start / bar) + 1, to_bar: Math.ceil(v.loop.end / bar) } : null,
    current_pattern: v.currentPatternId
      ? { id: v.currentPatternId, name: p.patterns[v.currentPatternId]?.name ?? '' }
      : null,
    audio: s.engine.state,
    can_undo: h.canUndo,
    can_redo: h.canRedo,
    ...(h.undoLabel ? { undo_label: h.undoLabel } : {}),
  };
};

const stateText = (st: ReturnType<typeof transportState>) =>
  `${st.playing ? 'Playing' : 'Stopped'} in ${st.mode} mode at bar ${st.bar} (${st.bpm} BPM, ${st.time_signature}).` +
  `${st.loop ? ` Loop: bars ${st.loop.from_bar}–${st.loop.to_bar}.` : ' No loop region.'}` +
  `${st.current_pattern ? ` Current pattern: "${st.current_pattern.name}" ${st.current_pattern.id}.` : ''}` +
  `${st.audio === 'running' ? '' : ' The browser has not unlocked sound yet: one click inside AGstudio does it, until then nothing is audible.'}`;

/** Sound the browser hasn't unlocked yet (no click in the tab since it loaded). */
const lockedNote = (s: Services) =>
  s.engine.state === 'running' ? '' : ' (The browser keeps sound locked until the musician clicks once inside AGstudio.)';

export function createMcpTools(s: Services, deps: ToolDeps = {}): McpTools {
  const audio = audioTools(deps.audio ?? defaultAudioDeps());
  /** Edits run one at a time, in the order they arrive. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (fn: ToolFn): ToolFn => (st, args, ctx) => {
    const run = queue.then(() => fn(st, args, ctx));
    queue = run.catch(() => undefined);
    return run;
  };

  const apply_actions: ToolFn = async (st, args, ctx) => {
    const bars = barsArg(args.focus);
    if (typeof bars === 'string') return fail(bars);
    const parsed = readAnswer({ message: str(args.summary) ?? '', actions: args.actions });
    if ('error' in parsed) return fail(`Can't apply that: ${parsed.error}.`);
    const { answer, dropped } = parsed;
    if (answer.actions.length === 0)
      return fail(
        dropped > 0
          ? `None of the ${dropped} actions has a known "op". Read get_guide for the list of actions.`
          : 'No actions given. Pass the edits in "actions".',
      );
    const client = clientLabel(ctx.client);
    const summary = answer.message || 'edited the project';
    const focus = bars ? barsFocus(st, bars.from, bars.to) : null;
    const assistant = await st.assistant.load();
    const out = await assistant.applyExternal({ ...answer, message: summary }, {
      client,
      summary,
      focus,
      approveOutside: args.approve_outside === true,
      onGesture: (id, a) => deps.gesture?.(client, id, a),
    });
    if (out.status === 'busy') return fail(out.warnings[0] ?? 'Studio is busy.');
    if (out.status === 'needs_approval') {
      const part = out.part ?? 'the part';
      return ok(
        `Not applied yet. This edit also changes things outside ${part}:\n${(out.outside ?? []).map((o) => `- ${o}`).join('\n')}\n` +
          `Nothing changed. To allow it, call apply_actions again with the same actions and approve_outside: true; or change the actions so they stay inside ${part}.`,
        { applied: false, needs_approval: true, part, outside: out.outside ?? [] },
      );
    }
    const label = st.history.status().undoLabel;
    const lines = [
      out.edited
        ? `Applied as one undo step${label ? ` ("${label}")` : ''}.`
        : 'Nothing in the project changed.',
      ...(out.changes.length ? ['Changes:', ...out.changes.map((c) => `- ${c}`)] : []),
      ...(out.warnings.length ? ['Could not do:', ...out.warnings.map((w) => `- ${w}`)] : []),
      ...(out.followups.length ? ['Follow-up steps:', ...out.followups.map((f) => `- ${f}`)] : []),
      ...(out.findings?.length ? ['Song check:', ...out.findings.map((f) => `- ${f}`)] : []),
      ...(out.lookups ? ['Looked up (the read tools have the same):', out.lookups] : []),
      ...(dropped > 0 ? [`${dropped} action${dropped === 1 ? ' was' : 's were'} skipped: unknown "op".`] : []),
      ...(answer.actions.some((a) => a.op === 'analyze_mix')
        ? ['The analyze_mix action only works in the Studio chat: call the analyze_mix tool to listen to the mix.']
        : []),
      ...(out.edited ? [`To go back: undo, or undo with to_point ${out.beforePoint}.`] : []),
    ];
    return ok(lines.join('\n'), {
      applied: out.edited,
      changes: out.changes,
      warnings: out.warnings,
      followups: out.followups,
      before_point: out.beforePoint,
      undo_point: out.undoPoint,
      history_label: out.edited ? (label ?? null) : null,
    });
  };

  const list_commands: ToolFn = (st, args) => {
    const search = str(args.search)?.toLowerCase();
    const defs = aiCommands(st).filter(
      (d) => !search || `${d.id} ${d.title} ${d.hint ?? ''}`.toLowerCase().includes(search),
    );
    const text = search
      ? commandCatalog(st)
          .text.split('\n')
          .filter((line, i) => i === 0 || line.toLowerCase().includes(search))
          .join('\n')
      : commandCatalog(st).text;
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

  const run_command: ToolFn = async (st, args, ctx) => {
    const id = str(args.id);
    if (!id) return fail('Say which command to run: its id from list_commands.');
    const def = aiCommands(st).find((d) => d.id === id);
    if (!def)
      return fail(`No command "${id}" is available to AI apps. Use list_commands to see the ids${st.commands.get(id) ? ' (that one needs arguments nobody described, or is kept for the musician)' : ''}.`);
    if (!st.commands.isEnabled(id)) return fail(`"${def.title}" isn't available right now (the app is in a state where it can't run).`);
    const client = clientLabel(ctx.client);
    const title = def.title.replace(/…$/, '');
    if (def.gesture) {
      deps.gesture?.(client, id, args.args);
      return ok(
        `"${title}" opens a file dialog, and the browser only allows that right after a click. AGstudio now shows the musician a button ("${client} wants to run ${title}: click to continue"). It has not run yet; ask them to click it.`,
        { ran: false, waiting_for_click: true },
      );
    }
    const before = st.history.status().cursor;
    const toastsBefore = new Set(st.session.getState().toasts.map((t) => t.id));
    if (!st.commands.run(id, args.args)) return fail(`"${title}" could not run.`);
    await sleep(150); // async commands report problems as toasts a moment later
    const toasts = st.session.getState().toasts.filter((t) => !toastsBefore.has(t.id));
    const after = st.history.status();
    if (after.cursor !== before) (await st.assistant.load()).reportExternal(client, `ran “${title}”`, { undo: after.cursor });
    const problem = toasts.find((t) => t.kind === 'error');
    const lines = [
      problem ? `"${title}" ran but reported a problem: ${problem.text}` : `Ran "${title}".`,
      ...toasts.filter((t) => t !== problem).map((t) => `AGstudio said: ${t.text}`),
      ...(def.checked ? [`It is now ${st.commands.isChecked(id) ? 'on' : 'off'}.`] : []),
    ];
    const res = ok(lines.join('\n'), { ran: true, changed_project: after.cursor !== before });
    return problem ? { ...res, isError: true } : res;
  };

  const transport_state: ToolFn = (st) => {
    const state = transportState(st);
    return ok(stateText(state), { ...state });
  };

  const play: ToolFn = (st, args) => {
    const bar = ticksPerBar(st.doc.getState().project.transport.timeSig);
    const v = st.view.getState();
    const pattern = str(args.pattern);
    const loopFrom = int(args.loop_from_bar);
    const loopTo = int(args.loop_to_bar);
    const from = int(args.from_bar);
    let what: string;
    if (pattern) {
      const id = findPattern(st, pattern) ?? findPattern(st, Number(pattern));
      if (!id || !playPattern(st, id)) return fail(`No pattern "${pattern}". get_project lists them.`);
      what = `the pattern "${st.doc.getState().project.patterns[id]?.name}" on a loop`;
    } else if (loopFrom !== undefined || loopTo !== undefined) {
      if (loopFrom === undefined || loopTo === undefined || loopTo < loopFrom || loopFrom < 1)
        return fail('loop_from_bar and loop_to_bar go together (1-based, to_bar not before from_bar).');
      const r = barsToRange(st, loopFrom, loopTo);
      playRange(st, r.from, r.to);
      what = `bars ${loopFrom}–${loopTo} on a loop`;
    } else if (from !== undefined) {
      if (from < 1) return fail('from_bar starts at 1.');
      playFrom(st, (from - 1) * bar);
      what = `the song from bar ${from}`;
    } else {
      v.setMode('song');
      const start = v.loop ? v.loop.start : v.songStart;
      st.engine.play(start);
      what = v.loop ? `the loop (bars ${Math.floor(v.loop.start / bar) + 1}–${Math.ceil(v.loop.end / bar)})` : `the song from bar ${Math.floor(start / bar) + 1}`;
    }
    return ok(`Playing ${what}.${lockedNote(st)}`, { playing: true, audio: st.engine.state });
  };

  const stop: ToolFn = (st) => {
    st.engine.stop();
    return ok('Stopped.', { playing: false });
  };

  const seek: ToolFn = (st, args) => {
    const bar = int(args.bar);
    if (bar === undefined || bar < 1) return fail('bar must be a number from 1 (the start).');
    const tick = (bar - 1) * ticksPerBar(st.doc.getState().project.transport.timeSig);
    if (st.engine.playing) playFrom(st, tick);
    else {
      const v = st.view.getState();
      if (v.loop && (tick < v.loop.start || tick >= v.loop.end)) v.setLoop(null);
      v.setSongStart(tick);
    }
    return ok(`Playhead at bar ${bar}${st.engine.playing ? ' (playing from there)' : ''}.`, { bar });
  };

  const set_loop: ToolFn = (st, args) => {
    const v = st.view.getState();
    if (args.clear === true) {
      v.setLoop(null);
      return ok('The loop region is cleared: the whole song plays.', { loop: null });
    }
    const from = int(args.from_bar);
    const to = int(args.to_bar);
    if (from === undefined || to === undefined || from < 1 || to < from)
      return fail('Give from_bar and to_bar (1-based, to_bar not before from_bar), or clear: true.');
    const r = barsToRange(st, from, to);
    v.setLoop({ start: r.from, end: r.to });
    return ok(`Loop region: ${barSpan(r.from, r.to, st.doc.getState().project.transport.timeSig)}.`, { loop: { from_bar: from, to_bar: to } });
  };

  const stepsArg = (args: Args): number => Math.min(50, Math.max(1, int(args.steps) ?? 1));

  const undo: ToolFn = async (st, args, ctx) => {
    const client = clientLabel(ctx.client);
    const point = int(args.to_point);
    const labels: string[] = [];
    if (point !== undefined) {
      const done = st.history.steps().done;
      const at = point === 0 ? -1 : done.findIndex((d) => d.id === point);
      if (point !== 0 && at < 0) return fail(`History point ${point} isn't in the undo history any more (it was undone already, or too old). See history.`);
      labels.push(...done.slice(at + 1).map((d) => d.label));
      st.history.goTo(point);
    } else {
      for (let i = 0; i < stepsArg(args); i++) {
        const label = st.history.status().undoLabel;
        if (!st.history.undo()) break;
        if (label) labels.push(label);
      }
    }
    if (labels.length === 0) return fail('Nothing to undo.');
    (await st.assistant.load()).reportExternal(client, `undid: ${labels.slice().reverse().join('; ')}`);
    const now = st.history.status();
    return ok(`Undid ${labels.length} step${labels.length === 1 ? '' : 's'}: ${labels.slice().reverse().join('; ')}.${now.undoLabel ? ` Next undo would revert "${now.undoLabel}".` : ''}`, {
      undone: labels.length,
      can_undo: now.canUndo,
      can_redo: now.canRedo,
    });
  };

  const redo: ToolFn = async (st, args, ctx) => {
    const labels: string[] = [];
    for (let i = 0; i < stepsArg(args); i++) {
      const label = st.history.status().redoLabel;
      if (!st.history.redo()) break;
      if (label) labels.push(label);
    }
    if (labels.length === 0) return fail('Nothing to redo.');
    (await st.assistant.load()).reportExternal(clientLabel(ctx.client), `redid: ${labels.join('; ')}`);
    return ok(`Redid ${labels.length} step${labels.length === 1 ? '' : 's'}: ${labels.join('; ')}.`, { redone: labels.length });
  };

  const history: ToolFn = (st, args) => {
    const limit = Math.min(200, Math.max(1, int(args.limit) ?? 20));
    const { done, undone } = st.history.steps();
    const recent = done.slice(-limit);
    const fmt = (d: { id: number; label: string }) => `- ${d.label} (point ${d.id})`;
    return ok(
      [
        recent.length ? `Done, oldest first${done.length > recent.length ? ` (last ${recent.length} of ${done.length})` : ''}:` : 'Nothing done yet.',
        ...recent.map(fmt),
        ...(undone.length ? ['Undone (redo brings back the first):', ...undone.slice(0, limit).map(fmt)] : []),
      ].join('\n'),
      { done: recent.map((d) => ({ point: d.id, label: d.label })), undone: undone.slice(0, limit).map((d) => ({ point: d.id, label: d.label })) },
    );
  };

  const table: Record<string, ToolFn> = {
    ...READ_TOOLS,
    apply_actions: serial(apply_actions),
    list_commands,
    run_command: serial(run_command),
    transport_state,
    play,
    stop,
    seek,
    set_loop,
    undo: serial(undo),
    redo: serial(redo),
    history,
    ...audio,
  };

  return {
    names: () => Object.keys(table),
    async call(name, args, ctx = {}) {
      const fn = table[name];
      if (!fn) return fail(`This AGstudio has no tool "${name}".`);
      try {
        return await fn(s, args, ctx);
      } catch (e) {
        console.error(`[agstudio] MCP tool ${name} failed`, e);
        return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
