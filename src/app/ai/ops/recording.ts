/**
 * Audio recording and comping: `record` (arm audio, the punch range, count-in and pre-roll, start and stop;
 * it acts on the app, after the edit) and `comp` (use a take for some bars, promote a take, next and previous
 * take, crossfade, flatten; it edits the playlist). What there is to comp is listed by the `get_takes` read.
 */
import type { Draft } from 'immer';
import { MAX_CROSSFADE_MS } from '@core/audio/comp';
import { tempoMapOf } from '@core/automation/tempo';
import type { ClipId, Project, Tick } from '@core/model/types';
import { compSetCrossfade, compStep, compSwipe, compUseTake, flattenComp } from '@core/ops/comp';
import { buildTakeGroups, type TakeGroup } from '@core/query/takes';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { clearPunch, describePunch, punchStartTick, setPunchRange } from '../../actions/punch';
import type { Services } from '../../services';
import type { AiAction, AiAnswer } from '../schema';
import * as S from '../schema/parts';
import { fail, type AnswerState, type OpContext, type OpModule } from './context';
import { num, str } from './values';

export const recording: OpModule = {
  schemas: [
    S.op(
      'record',
      'Audio recording from the musician’s input (their microphone or interface), applied after the edits. arm turns record mode on for audio, set_punch / clear_punch choose which bars an audio recording keeps (a punch range, separate from the loop region), start arms and plays (from the pre-roll before the punch-in when there is a punch range and no loop region, after the count-in), stop ends it. Loop passes become takes, which comp comps. Say what you set, then let them play: you cannot hear the take.',
      {
        action: { type: 'string', enum: ['arm', 'disarm', 'start', 'stop', 'set_punch', 'clear_punch'] },
        punch_from_bar: S.num('set_punch: the 1-based bar where recording starts keeping sound (fractions allowed).'),
        punch_to_bar: S.num('set_punch: the 1-based last bar it keeps (inclusive).'),
        count_in_bars: S.int('Bars of count-in before recording (0–4).'),
        pre_roll_bars: S.int('Bars played before the punch-in (0–4).'),
        from_bar: S.int('start: the 1-based bar to play from (default: the pre-roll before the punch-in, else the song position).'),
      },
      ['action'],
    ),
    S.op(
      'comp',
      'Comps the takes of an audio recording (get_takes lists them): the comp track plays one take at a time, with a short crossfade where it changes. use_take plays a take for from_bar–to_bar (or all of it without bars); promote makes a whole take the comp; next / previous swap the take that plays from_bar–to_bar for its neighbour; crossfade sets the length of the fades between takes; flatten keeps what the comp plays as ordinary clips and removes the take tracks. One undo step.',
      {
        action: { type: 'string', enum: ['use_take', 'promote', 'next', 'previous', 'crossfade', 'flatten'] },
        group: S.str('The take group id from get_takes (default: the one on track, or the only one).'),
        track: S.int('1-based playlist track of the comp track or one of its takes (to say which recording).'),
        take: S.int('use_take, promote: the 1-based take number from get_takes.'),
        from_bar: S.num('use_take, next, previous: the 1-based bar where the range starts (fractions allowed).'),
        to_bar: S.num('The 1-based last bar of the range (inclusive; default: the same bar).'),
        ms: S.num(`crossfade: the crossfade in milliseconds (0–${MAX_CROSSFADE_MS}).`),
      },
      ['action'],
    ),
  ],
  prompt: {
    id: 'recording',
    order: 33,
    text: `Audio recording and comping: record sets up and starts a recording of the musician's audio input (arm, a punch range of bars to keep, count-in and pre-roll bars, start, stop); it needs the microphone, so say what you did and let them perform. Passes of a loop become takes: a comp track on top with the takes folded under it. comp swaps which take plays where (use_take with bars, promote a whole take, next or previous for some bars), sets the crossfade between takes (default 10 ms) and flattens the comp into plain clips. You cannot hear the takes: read get_takes for what exists and use the musician's words ("the second verse take is better") to choose.`,
  },
  handlers: {
    comp: (action, context) => {
      const draft = context.draft;
      const g = groupFrom(action, context);
      const tempo = tempoMapOf(context.base, 'song');
      const timeSig = draft.transport.timeSig;
      const name = (draft.playlist.lanes[g.compLane as never]?.name ?? 'Recording').replace(/ · comp$/, '');
      const range = (): { from: Tick; to: Tick } | null => {
        const from = num(action.from_bar);
        if (from === undefined) return null;
        const to = num(action.to_bar) ?? from;
        const bar = ticksPerBar(timeSig);
        return { from: Math.max(0, Math.round((Math.min(from, to) - 1) * bar)), to: Math.round(Math.max(from, to) * bar) };
      };
      const takeIndex = (): number => {
        const n = num(action.take) ?? fail('which take? (the 1-based take number from get_takes)');
        const t = g.takes[Math.round(n) - 1];
        return t?.index ?? fail(`“${name}” has ${g.takes.length} take${g.takes.length === 1 ? '' : 's'}: there is no take ${Math.round(n)}`);
      };
      const touched = (from: Tick, to: Tick, ids: readonly ClipId[]) => {
        context.focus.span(from, to, 'comp');
        context.touch(from, to, ids);
      };
      switch (str(action.action)) {
        case 'use_take':
        case 'promote': {
          const take = takeIndex();
          const r = str(action.action) === 'use_take' ? range() : null;
          const span = r ?? { from: g.start, to: g.end };
          context.focus.span(span.from, span.to, 'comp');
          const ids = r ? compSwipe(draft, g.id, take, r.from, r.to, tempo) : compUseTake(draft, g.id, take, tempo);
          if (ids.length === 0) fail(`take ${Math.round(num(action.take)!)} has no audio in ${r ? barSpan(r.from, r.to, timeSig) : 'that recording'}`);
          touched(span.from, span.to, ids);
          return `Comp “${name}”: take ${Math.round(num(action.take)!)} plays ${r ? barSpan(r.from, r.to, timeSig) : 'all of its bars'}`;
        }
        case 'next':
        case 'previous': {
          const r = range() ?? { from: g.start, to: g.end };
          context.focus.span(r.from, r.to, 'comp');
          const now = compStep(draft, g.id, r.from, r.to, str(action.action) === 'next' ? 1 : -1, tempo);
          if (now === null) fail(`no other take has audio in ${barSpan(r.from, r.to, timeSig)}`);
          touched(r.from, r.to, []);
          return `Comp “${name}”: take ${g.takes.findIndex((t) => t.index === now) + 1} plays ${barSpan(r.from, r.to, timeSig)}`;
        }
        case 'crossfade': {
          const ms = num(action.ms) ?? fail('crossfade needs ms');
          context.focus.span(g.start, g.end, 'comp');
          compSetCrossfade(draft, g.id, ms, tempo);
          touched(g.start, g.end, []);
          return `Comp “${name}”: crossfade ${Math.round(Math.max(0, Math.min(MAX_CROSSFADE_MS, ms)) * 10) / 10} ms`;
        }
        case 'flatten': {
          context.focus.span(g.start, g.end, 'comp');
          const { removedLanes } = flattenComp(draft, g.id);
          touched(g.start, g.end, []);
          return `Flattened “${name}”: the comp stays as ordinary clips${removedLanes ? ` and ${removedLanes} take track${removedLanes === 1 ? '' : 's'} went` : ''}`;
        }
        default:
          return fail(`unknown comp action "${String(action.action)}"`);
      }
    },
  },
};

/** The take group an action means: by id, by a track of it, or the only one. */
function groupFrom(action: AiAction, context: OpContext): TakeGroup {
  const draft = context.draft as Draft<Project>;
  const groups = buildTakeGroups(draft.playlist);
  if (groups.length === 0) return fail('there are no takes to comp (loop-record audio first)');
  const id = str(action.group);
  if (id) return groups.find((g) => g.id === id) ?? fail(`there is no take group "${id}" (get_takes lists them)`);
  if (action.track !== undefined) {
    const lane = context.lane(action.track);
    const group = draft.playlist.lanes[lane]?.takes?.group;
    return groups.find((g) => g.id === group) ?? fail(`track ${String(action.track)} is not part of a set of takes`);
  }
  return groups.length === 1 ? (groups[0] as TakeGroup) : fail('which recording? (give group, or track)');
}

/** The names of the actions that act on the app instead of the playlist (they run after the edit). */
export const RECORD_OP_NAMES: readonly string[] = ['record'];

/** Runs the answer's `record` actions (after its edits are committed). */
export function recordingAfter(services: Services, answer: AiAnswer, state: AnswerState): void {
  for (const action of answer.actions) {
    if (action.op !== 'record') continue;
    const warn = (m: string) => state.warnings.push(`record: ${m}`);
    const prefs: { countInBars?: number; preRollBars?: number; recordAudio?: boolean } = {};
    const notes: string[] = [];
    const project = services.doc.getState().project;
    const bar = ticksPerBar(project.transport.timeSig);
    const countIn = num(action.count_in_bars);
    if (countIn !== undefined) {
      prefs.countInBars = Math.max(0, Math.min(4, Math.round(countIn)));
      notes.push(`count-in ${prefs.countInBars} bar${prefs.countInBars === 1 ? '' : 's'}`);
    }
    const preRoll = num(action.pre_roll_bars);
    if (preRoll !== undefined) {
      prefs.preRollBars = Math.max(0, Math.min(4, Math.round(preRoll)));
      notes.push(`pre-roll ${prefs.preRollBars} bar${prefs.preRollBars === 1 ? '' : 's'}`);
    }
    const subAction = str(action.action);
    const from = num(action.punch_from_bar);
    const to = num(action.punch_to_bar);
    if (subAction === 'set_punch') {
      if (from === undefined) warn('set_punch needs punch_from_bar');
      else {
        const end = to ?? from;
        if (setPunchRange(services, Math.max(0, Math.round((Math.min(from, end) - 1) * bar)), Math.round(Math.max(from, end) * bar)))
          notes.push(`punch range ${describePunch(services)}`);
        else warn('the punch range must end after it starts');
      }
    } else if (subAction === 'clear_punch') {
      clearPunch(services);
      notes.push('no punch range');
    }
    if (subAction === 'arm' || subAction === 'start') {
      prefs.recordAudio = true;
      if (subAction === 'arm') notes.push('audio record mode on (press Play to record)');
    }
    if (Object.keys(prefs).length) services.prefs.getState().set(prefs);
    if (subAction === 'arm') services.recording.setArmed(true);
    else if (subAction === 'disarm') {
      services.recording.setArmed(false);
      notes.push('record mode off');
    } else if (subAction === 'start') {
      const fromBar = num(action.from_bar);
      const fromTick = fromBar !== undefined ? Math.max(0, (Math.round(fromBar) - 1) * bar) : (punchStartTick(services) ?? undefined);
      // The input opens ahead of the count-in (the browser may ask for the microphone: it needs a click the first time).
      void services.audioInput.open();
      state.after.push({ kind: 'play', mode: 'song', record: true, ...(fromTick !== undefined ? { fromTick } : {}) });
      notes.push(`recording${services.view.getState().punch ? ` the punch range ${describePunch(services)}` : ''}`);
    } else if (subAction === 'stop') {
      state.after.push({ kind: 'stop' });
      notes.push('stopped');
    } else if (!['arm', 'disarm', 'set_punch', 'clear_punch'].includes(subAction ?? '')) warn(`unknown action "${String(action.action)}"`);
    if (notes.length) state.ui.push(`Recording: ${notes.join(', ')}`);
  }
}
