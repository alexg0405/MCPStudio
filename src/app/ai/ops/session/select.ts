/** The `select` action: what the editors and commands act on (channel, mixer track, pattern, clips, notes, the loop). */
import { markerTarget } from '@core/filters/target';
import type { ChannelId, Clip, ClipId, NoteId, PatternId, Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../../../services';
import type { AiAction } from '../../schema';
import { ActionError, fail, type OpContext } from '../context';
import { isObj, lower, num, r2, str } from '../values';
import type { SessionOutput } from './output';

/** The lowest and highest MIDI keys, when a notes selection names no key range. */
const LOWEST_KEY = 0;
const HIGHEST_KEY = 127;
const CLEAR_CHOICES = ['clips', 'notes', 'loop', 'all'];

/** The tick a 1-based bar starts at. */
const startOfBar = (bar: number, barTicks: number) => (Math.max(1, Math.round(bar)) - 1) * barTicks;
/** The tick a 1-based bar ends at. */
const endOfBar = (bar: number, barTicks: number) => Math.max(1, Math.round(bar)) * barTicks;

/** "1 clip", "3 clips" … a count with its noun. */
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Clips by ids, or on a track and/or touching bars. */
function pickClips(
  context: OpContext,
  project: Project,
  spec: Record<string, unknown>,
  warn: (message: string) => void,
): ClipId[] {
  if (Array.isArray(spec.ids) && spec.ids.length) {
    const ids = spec.ids.map(str).filter((id): id is string => !!id) as ClipId[];
    const found = ids.filter((id) => project.playlist.clips[id]);
    if (!found.length) fail('none of those clips exist');
    if (found.length < ids.length) warn(`${ids.length - found.length} of those clips don't exist`);
    return found;
  }
  const barTicks = ticksPerBar(project.transport.timeSig);
  const track = spec.track !== undefined ? context.lane(spec.track) : undefined;
  const fromBar = num(spec.from_bar);
  const toBar = num(spec.to_bar);
  if (!track && fromBar === undefined && toBar === undefined && spec.all !== true) {
    fail('say which clips: ids, a track, bars, or all');
  }
  const fromTick = fromBar !== undefined ? startOfBar(fromBar, barTicks) : 0;
  const toTick = toBar !== undefined ? endOfBar(toBar, barTicks) : Number.POSITIVE_INFINITY;
  return (Object.values(project.playlist.clips) as Clip[])
    .filter((clip) => (!track || clip.laneId === track) && clip.start < toTick && clip.start + clip.length > fromTick)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
    .map((clip) => clip.id);
}

/** Selects notes of a channel in a pattern, within bars and keys, and shows that pattern and channel. */
function selectNotes(services: Services, context: OpContext, spec: Record<string, unknown>, parts: string[]): void {
  const { project } = context;
  const view = services.view.getState();
  const patternId: PatternId =
    spec.pattern !== undefined ? context.pattern(spec.pattern) : (view.currentPatternId ?? context.pattern('current'));
  const channelId: ChannelId =
    spec.channel !== undefined
      ? context.channel(spec.channel)
      : (services.session.getState().selectedChannelId ?? fail('which channel? (the notes belong to a channel)'));
  const pattern = project.patterns[patternId]!;
  const channel = project.channels[channelId]!;
  if (channel.kind !== 'instrument') fail(`“${channel.name}” has no notes`);
  const barTicks = ticksPerBar(project.transport.timeSig);
  const fromBar = num(spec.from_bar);
  const toBar = num(spec.to_bar);
  const fromTick = fromBar !== undefined ? startOfBar(fromBar, barTicks) : 0;
  const toTick = toBar !== undefined ? endOfBar(toBar, barTicks) : Number.POSITIVE_INFINITY;
  const fromKey = num(spec.from_key) ?? LOWEST_KEY;
  const toKey = num(spec.to_key) ?? HIGHEST_KEY;
  const ids = Object.values(pattern.notes[channelId] ?? {})
    .filter(
      (note) =>
        note.tick >= fromTick &&
        note.tick < toTick &&
        note.key >= Math.min(fromKey, toKey) &&
        note.key <= Math.max(fromKey, toKey),
    )
    .sort((a, b) => a.tick - b.tick || a.key - b.key)
    .map((note) => note.id as NoteId);
  view.setCurrentPattern(patternId);
  services.session.getState().selectChannel(channelId);
  services.editor.getState().selectNotes(ids);
  parts.push(`${plural(ids.length, 'note')} of “${channel.name}” in “${pattern.name}”`);
}

/** Sets the loop region: bars, or a marker's section. */
function selectLoop(services: Services, project: Project, spec: Record<string, unknown>, parts: string[]): void {
  const barTicks = ticksPerBar(project.transport.timeSig);
  const section = str(spec.section);
  const fromBar = num(spec.from_bar);
  const toBar = num(spec.to_bar);
  let start: number;
  let end: number;
  if (section) {
    const markers = Object.values(project.playlist.markers);
    const marker =
      markers.find((candidate) => lower(candidate.name) === lower(section)) ??
      markers.find((candidate) => lower(candidate.name).startsWith(lower(section)));
    if (!marker) return fail(`there is no marker “${section}”`);
    const span = markerTarget(project, marker.id);
    if (!span) return fail(`“${section}” has no section (it needs a marker after it, or songs to end it)`);
    start = span.from;
    end = span.to;
  } else if (fromBar !== undefined) {
    start = startOfBar(fromBar, barTicks);
    end = endOfBar(toBar ?? fromBar, barTicks);
  } else return fail('the loop needs from_bar and to_bar, or a section');
  if (end <= start) return fail('the loop must end after it starts');
  services.view.getState().setLoop({ start, end });
  parts.push(`loop bars ${r2(start / barTicks + 1)}–${r2(end / barTicks)}`);
}

/** Applies a `select` action; says what was selected (or why nothing was). */
export function applySelect(services: Services, action: AiAction, context: OpContext, out: SessionOutput): void {
  const { project } = context;
  const parts: string[] = [];
  const view = services.view.getState();
  const editor = services.editor.getState();
  const session = services.session.getState();
  /** Runs one part of the selection; an action error becomes a warning and the other parts still run. */
  const attempt = <T>(work: () => T): T | undefined => {
    try {
      return work();
    } catch (error) {
      if (error instanceof ActionError) {
        out.warn(error.message);
        return undefined;
      }
      throw error;
    }
  };
  if (action.channel !== undefined) {
    const id = attempt(() => context.channel(action.channel));
    if (id) {
      session.selectChannel(id);
      parts.push(`channel “${project.channels[id]!.name}”`);
    }
  }
  if (action.insert !== undefined) {
    const id = attempt(() => context.insert(action.insert));
    if (id) {
      session.selectInsert(id === 'master' ? null : id);
      parts.push(`mixer track “${project.mixer.inserts[id]?.name ?? id}”`);
    }
  }
  if (action.pattern !== undefined) {
    const id = attempt(() => context.pattern(action.pattern));
    if (id) {
      view.setCurrentPattern(id);
      parts.push(`pattern “${project.patterns[id]!.name}”`);
    }
  }
  if (isObj(action.clips)) {
    const ids = attempt(() => pickClips(context, project, action.clips as Record<string, unknown>, out.warn));
    if (ids) {
      editor.selectClips(ids);
      parts.push(plural(ids.length, 'clip'));
    }
  }
  if (isObj(action.notes)) {
    const spec = action.notes;
    attempt(() => selectNotes(services, context, spec, parts));
  }
  if (isObj(action.loop)) {
    const spec = action.loop;
    attempt(() => selectLoop(services, project, spec, parts));
  }
  const clear = str(action.clear);
  if (action.clear !== undefined && !CLEAR_CHOICES.includes(clear ?? '')) {
    out.warn('clear must be clips, notes, loop or all');
  }
  if (clear === 'clips' || clear === 'all') {
    editor.selectClips([]);
    parts.push('no clips');
  }
  if (clear === 'notes' || clear === 'all') {
    editor.selectNotes([]);
    parts.push('no notes');
  }
  if (clear === 'loop' || clear === 'all') {
    view.setLoop(null);
    parts.push('no loop');
  }
  if (parts.length) out.ui.push(`Selected ${parts.join(', ')}`);
  else if (action.clear === undefined) out.warn('select what? (channel, insert, pattern, clips, notes, loop or clear)');
}
