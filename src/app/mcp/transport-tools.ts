/** The MCP tools that move the playhead: transport_state, play, stop, seek and set_loop. */
import { ticksPerBar } from '@core/time/ppq';
import { barSpan } from '@core/time/bars';
import { barsToRange, findPattern, playFrom, playPattern, playRange } from '../actions/transport';
import type { Services } from '../services';
import { fail, int, ok, str, type ToolFn } from './common';

/** Where playback is, in the shape `transport_state` returns it (both as data and, through `stateText`, as words). */
function transportState(s: Services) {
  const project = s.doc.getState().project;
  const view = s.view.getState();
  const ticksInBar = ticksPerBar(project.transport.timeSig);
  const tick = s.engine.playing ? Math.round(s.engine.playhead()) : view.songStart;
  const historyStatus = s.history.status();
  return {
    playing: s.engine.playing,
    mode: view.mode,
    bpm: project.transport.bpm,
    time_signature: `${project.transport.timeSig.num}/${project.transport.timeSig.den}`,
    bar: Math.floor(tick / ticksInBar) + 1,
    tick,
    song_start_bar: Math.floor(view.songStart / ticksInBar) + 1,
    loop: view.loop ? { from_bar: Math.floor(view.loop.start / ticksInBar) + 1, to_bar: Math.ceil(view.loop.end / ticksInBar) } : null,
    current_pattern: view.currentPatternId
      ? { id: view.currentPatternId, name: project.patterns[view.currentPatternId]?.name ?? '' }
      : null,
    audio: s.engine.state,
    can_undo: historyStatus.canUndo,
    can_redo: historyStatus.canRedo,
    ...(historyStatus.undoLabel ? { undo_label: historyStatus.undoLabel } : {}),
  };
}

/** The `transport_state` facts as one or two sentences for the AI to read. */
function stateText(state: ReturnType<typeof transportState>): string {
  const loopText = state.loop ? ` Loop: bars ${state.loop.from_bar}–${state.loop.to_bar}.` : ' No loop region.';
  const patternText = state.current_pattern ? ` Current pattern: "${state.current_pattern.name}" ${state.current_pattern.id}.` : '';
  const lockedText =
    state.audio === 'running' ? '' : ' The browser has not unlocked sound yet: one click inside AGstudio does it, until then nothing is audible.';
  return `${state.playing ? 'Playing' : 'Stopped'} in ${state.mode} mode at bar ${state.bar} (${state.bpm} BPM, ${state.time_signature}).${loopText}${patternText}${lockedText}`;
}

/** Sound the browser hasn't unlocked yet (no click in the tab since it loaded). */
function lockedNote(s: Services): string {
  return s.engine.state === 'running' ? '' : ' (The browser keeps sound locked until the musician clicks once inside AGstudio.)';
}

const transportStateTool: ToolFn = (s) => {
  const state = transportState(s);
  return ok(stateText(state), { ...state });
};

/** `play` with a pattern: that pattern on a loop. Returns what was started, or an error result. */
function playPatternByName(s: Services, pattern: string): string | ReturnType<typeof fail> {
  const id = findPattern(s, pattern) ?? findPattern(s, Number(pattern));
  if (!id || !playPattern(s, id)) return fail(`No pattern "${pattern}". get_project lists them.`);
  return `the pattern "${s.doc.getState().project.patterns[id]?.name}" on a loop`;
}

/** `play` with a loop range: those bars on a loop. */
function playLoopBars(s: Services, loopFrom: number | undefined, loopTo: number | undefined): string | ReturnType<typeof fail> {
  if (loopFrom === undefined || loopTo === undefined || loopTo < loopFrom || loopFrom < 1)
    return fail('loop_from_bar and loop_to_bar go together (1-based, to_bar not before from_bar).');
  const range = barsToRange(s, loopFrom, loopTo);
  playRange(s, range.from, range.to);
  return `bars ${loopFrom}–${loopTo} on a loop`;
}

/** `play` with no arguments: the loop region if there is one, else the song from where the playhead rests. */
function playSongOrLoop(s: Services): string {
  const view = s.view.getState();
  const ticksInBar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  view.setMode('song');
  const start = view.loop ? view.loop.start : view.songStart;
  s.engine.play(start);
  if (!view.loop) return `the song from bar ${Math.floor(start / ticksInBar) + 1}`;
  return `the loop (bars ${Math.floor(view.loop.start / ticksInBar) + 1}–${Math.ceil(view.loop.end / ticksInBar)})`;
}

const play: ToolFn = (s, args) => {
  const ticksInBar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const pattern = str(args.pattern);
  const loopFrom = int(args.loop_from_bar);
  const loopTo = int(args.loop_to_bar);
  const fromBar = int(args.from_bar);
  let what: string | ReturnType<typeof fail>;
  if (pattern) {
    what = playPatternByName(s, pattern);
  } else if (loopFrom !== undefined || loopTo !== undefined) {
    what = playLoopBars(s, loopFrom, loopTo);
  } else if (fromBar !== undefined) {
    if (fromBar < 1) return fail('from_bar starts at 1.');
    playFrom(s, (fromBar - 1) * ticksInBar);
    what = `the song from bar ${fromBar}`;
  } else {
    what = playSongOrLoop(s);
  }
  if (typeof what !== 'string') return what;
  return ok(`Playing ${what}.${lockedNote(s)}`, { playing: true, audio: s.engine.state });
};

const stop: ToolFn = (s) => {
  s.engine.stop();
  return ok('Stopped.', { playing: false });
};

const seek: ToolFn = (s, args) => {
  const bar = int(args.bar);
  if (bar === undefined || bar < 1) return fail('bar must be a number from 1 (the start).');
  const tick = (bar - 1) * ticksPerBar(s.doc.getState().project.transport.timeSig);
  if (s.engine.playing) {
    playFrom(s, tick);
  } else {
    const view = s.view.getState();
    // A playhead outside the loop region would not be heard from there, so the loop is dropped.
    if (view.loop && (tick < view.loop.start || tick >= view.loop.end)) view.setLoop(null);
    view.setSongStart(tick);
  }
  return ok(`Playhead at bar ${bar}${s.engine.playing ? ' (playing from there)' : ''}.`, { bar });
};

const setLoop: ToolFn = (s, args) => {
  const view = s.view.getState();
  if (args.clear === true) {
    view.setLoop(null);
    return ok('The loop region is cleared: the whole song plays.', { loop: null });
  }
  const fromBar = int(args.from_bar);
  const toBar = int(args.to_bar);
  if (fromBar === undefined || toBar === undefined || fromBar < 1 || toBar < fromBar)
    return fail('Give from_bar and to_bar (1-based, to_bar not before from_bar), or clear: true.');
  const range = barsToRange(s, fromBar, toBar);
  view.setLoop({ start: range.from, end: range.to });
  return ok(`Loop region: ${barSpan(range.from, range.to, s.doc.getState().project.transport.timeSig)}.`, { loop: { from_bar: fromBar, to_bar: toBar } });
};

/** The transport tools by their MCP names. */
export const TRANSPORT_TOOLS: Record<string, ToolFn> = {
  transport_state: transportStateTool,
  play,
  stop,
  seek,
  set_loop: setLoop,
};
