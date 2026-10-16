/**
 * The part of the song a request is about ("Ask AI about this part"): a time range, a marker
 * section, some clips or some notes. It is captured when the musician sends and resolved again on
 * every turn (markers move, clips get deleted); `focusContext` is how the AI sees it.
 */
import { formatAutomationValue, targetName, type PluginInfoResolver } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import type { ChannelId, ClipId, MarkerId, Note, NoteId, PatternId, Project, Tick } from '@core/model/types';
import { barActivity } from '@core/query/activity';
import { laneRuns, type ClipRun } from '@core/query/arrangement';
import { patternLength } from '@core/query/queries';
import { songSections, type Section } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { ParamSpecs } from '@agstudio/sdk';
import { channelSound, noteName } from '../assistant/context';
import { noteLines } from './note-lines';

/** Patterns copied for the part by earlier answers: original → the part's own copy (follow-ups edit the copy). */
export type FocusCopies = Record<PatternId, PatternId>;

export type AiFocus =
  | { kind: 'range'; from: Tick; to: Tick; projectId: string; copies?: FocusCopies }
  | { kind: 'section'; markerId: MarkerId; from: Tick; to: Tick; projectId: string; copies?: FocusCopies }
  | { kind: 'clips'; clipIds: ClipId[]; projectId: string; copies?: FocusCopies }
  | { kind: 'notes'; patternId: PatternId; channelId: ChannelId; noteIds: NoteId[]; projectId: string };

/** A focus as it is now in the project. */
export interface ResolvedFocus {
  focus: AiFocus;
  /** Song span (exclusive end); for a notes focus, the pattern's span. */
  from: Tick;
  to: Tick;
  /** "Verse · bars 17–32". */
  label: string;
  /** "bars 17–32", for names like "Drop (bars 37–52)". */
  short: string;
  section: Section | null;
  /** A clips focus: the clips that still exist. */
  clips: ReadonlySet<ClipId> | null;
  notes: { patternId: PatternId; channelId: ChannelId; ids: ReadonlySet<NoteId> } | null;
  /** Copies made for the part earlier that still exist (original → copy). */
  copies: ReadonlyMap<PatternId, PatternId>;
}

/** A time focus (range, section or clips): edits stay inside a span of the song. */
export const isTimeFocus = (f: AiFocus | null | undefined): boolean => !!f && f.kind !== 'notes';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function validCopies(p: Project, copies: FocusCopies | undefined): Map<PatternId, PatternId> {
  const out = new Map<PatternId, PatternId>();
  for (const [from, to] of Object.entries(copies ?? {}) as [PatternId, PatternId][])
    if (p.patterns[from] && p.patterns[to] && from !== to) out.set(from, to);
  return out;
}

const plainCopies = (m: ReadonlyMap<PatternId, PatternId>): FocusCopies | undefined =>
  m.size ? (Object.fromEntries(m) as FocusCopies) : undefined;

/**
 * The focus as it is now, or null when it no longer means anything here: another project, clips or
 * notes that were all deleted, an empty span. A section follows its marker; when the marker is gone
 * the focus keeps the bars it had (as a range).
 */
export function resolveFocus(p: Project, f: AiFocus | null | undefined): ResolvedFocus | null {
  if (!f || f.projectId !== p.projectId) return null;
  const ts = p.transport.timeSig;
  const base = { section: null, clips: null, notes: null } as const;
  switch (f.kind) {
    case 'range':
    case 'section': {
      const copies = validCopies(p, f.copies);
      const section = f.kind === 'section' ? songSections(p).find((x) => x.markerId === f.markerId) : undefined;
      const from = Math.max(0, Math.round(section?.from ?? f.from));
      const to = Math.round(section?.to ?? f.to);
      if (!(to > from)) return null;
      const span = barSpan(from, to, ts);
      const kept = plainCopies(copies);
      const focus: AiFocus = section
        ? { kind: 'section', markerId: section.markerId, from, to, projectId: f.projectId, ...(kept ? { copies: kept } : {}) }
        : { kind: 'range', from, to, projectId: f.projectId, ...(kept ? { copies: kept } : {}) };
      return {
        ...base,
        focus,
        from,
        to,
        label: section ? `${section.name} · ${span}` : span,
        short: span,
        section: section ?? null,
        copies,
      };
    }
    case 'clips': {
      const ids = f.clipIds.filter((id) => p.playlist.clips[id]);
      if (ids.length === 0) return null;
      const clips = ids.map((id) => p.playlist.clips[id]!);
      const from = Math.min(...clips.map((c) => c.start));
      const to = Math.max(...clips.map((c) => c.start + c.length));
      const span = barSpan(from, to, ts);
      const only = clips.length === 1 ? clips[0]! : null;
      const name =
        only?.kind === 'pattern'
          ? `“${p.patterns[only.patternId]?.name ?? 'pattern'}” clip`
          : only
            ? `“${p.channels[only.channelId]?.name ?? only.kind}” clip`
            : plural(clips.length, 'clip');
      const copies = validCopies(p, f.copies);
      const kept = plainCopies(copies);
      return {
        ...base,
        focus: { kind: 'clips', clipIds: ids, projectId: f.projectId, ...(kept ? { copies: kept } : {}) },
        from,
        to,
        label: `${name} · ${span}`,
        short: span,
        clips: new Set(ids),
        copies,
      };
    }
    case 'notes': {
      const pat = p.patterns[f.patternId];
      const ch = p.channels[f.channelId];
      if (!pat || !ch) return null;
      const notes = pat.notes[f.channelId] ?? {};
      const ids = f.noteIds.filter((id) => notes[id]);
      if (ids.length === 0) return null;
      const n = plural(ids.length, 'note');
      return {
        ...base,
        focus: { ...f, noteIds: ids },
        from: 0,
        to: patternLength(pat, ts),
        label: `${n} of “${ch.name}”`,
        short: n,
        notes: { patternId: f.patternId, channelId: f.channelId, ids: new Set(ids) },
        copies: new Map(),
      };
    }
  }
}

/** "Verse · bars 17–32", "3 clips · bars 37–42", "6 notes of “Lead”". */
export function focusLabel(p: Project, f: AiFocus): string {
  return resolveFocus(p, f)?.label ?? 'a part that is no longer there';
}

/** Whether a value is a well-formed focus (restoring the tab's state). */
export function isAiFocus(v: unknown): v is AiFocus {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === 'string' && x.length > 0;
  const tick = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const ids = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every(str);
  const copies = (x: unknown) =>
    x === undefined || (typeof x === 'object' && x !== null && Object.entries(x).every(([k, c]) => str(k) && str(c)));
  if (!str(f.projectId)) return false;
  switch (f.kind) {
    case 'range':
      return tick(f.from) && tick(f.to) && (f.to as number) > (f.from as number) && copies(f.copies);
    case 'section':
      return str(f.markerId) && tick(f.from) && tick(f.to) && (f.to as number) > (f.from as number) && copies(f.copies);
    case 'clips':
      return ids(f.clipIds) && copies(f.copies);
    case 'notes':
      return str(f.patternId) && str(f.channelId) && ids(f.noteIds);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The <focus> block of a turn

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtStep = (steps: number) => String(r2(steps));
const fmtVel = (v: number) => (Math.abs(v - 0.8) < 0.005 ? '' : `@${String(r2(v)).replace(/^0(?=\.)/, '')}`);

/** Notes as the AI writes them: drums as steps, pitched notes as step:note/length (velocity when not 0.8). */
function formatNotes(p: Project, cid: ChannelId, notes: readonly Note[]): string {
  const ch = p.channels[cid];
  const sound = ch ? channelSound(p, ch) : null;
  const drum = sound !== null && DRUM_SOUNDS.has(sound as BeatSound);
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.key - b.key);
  const shown = sorted.slice(0, 96).map((n) => {
    const step = fmtStep(n.tick / 240);
    return drum ? `${step}${fmtVel(n.velocity)}` : `${step}:${noteName(n.key)}/${fmtStep(n.length / 240)}${fmtVel(n.velocity)}`;
  });
  return `${shown.join(' ')}${sorted.length > 96 ? ` … (+${sorted.length - 96} more)` : ''}`;
}

/** The parts of `spans` outside from–to. */
function outside(spans: readonly { from: Tick; to: Tick }[], from: Tick, to: Tick): { from: Tick; to: Tick }[] {
  const out: { from: Tick; to: Tick }[] = [];
  for (const s of spans) {
    if (s.from < from) out.push({ from: s.from, to: Math.min(s.to, from) });
    if (s.to > to) out.push({ from: Math.max(s.from, to), to: s.to });
  }
  return out.filter((s) => s.to > s.from);
}

/** Merged spans of clips. */
function merged(list: readonly { from: Tick; to: Tick }[]): { from: Tick; to: Tick }[] {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const out: { from: Tick; to: Tick }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** Where a pattern plays outside the part (all its clips, muted ones too: they still count as uses). */
function usesOutside(p: Project, r: ResolvedFocus, pid: PatternId): { from: Tick; to: Tick }[] {
  const spans: { from: Tick; to: Tick }[] = [];
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || c.patternId !== pid) continue;
    if (r.clips) {
      if (!r.clips.has(c.id)) spans.push({ from: c.start, to: c.start + c.length });
    } else spans.push(...outside([{ from: c.start, to: c.start + c.length }], r.from, r.to));
  }
  return merged(spans);
}

/** The patterns that play in the part: clips overlapping its span (or its clips). */
function partPatterns(p: Project, r: ResolvedFocus): PatternId[] {
  const seen = new Set<PatternId>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || !p.patterns[c.patternId]) continue;
    const inside = r.clips ? r.clips.has(c.id) : c.start < r.to && c.start + c.length > r.from;
    if (inside) seen.add(c.patternId);
  }
  return p.patternOrder.filter((id) => seen.has(id));
}

function runText(p: Project, run: ClipRun, ids: boolean): string {
  const ts = p.transport.timeSig;
  const clip = p.playlist.clips[run.clipIds[0]!]!;
  const what =
    clip.kind === 'pattern'
      ? `“${p.patterns[clip.patternId]?.name ?? '?'}”`
      : clip.kind === 'automation'
        ? `automation “${p.channels[clip.channelId]?.name ?? '?'}”`
        : `audio “${p.channels[clip.channelId]?.name ?? '?'}”`;
  const extra = [run.muted ? 'muted' : '', run.stacked ? `STACKED: plays ${run.stacked + 1}× here` : ''].filter(Boolean);
  const list = ids && run.count <= 4 ? ` ${run.clipIds.join(', ')}` : '';
  return `${what}${run.count > 1 ? ` ×${run.count}` : ''} ${barSpan(run.from, run.to, ts)}${extra.length ? ` (${extra.join(', ')})` : ''}${list}`;
}

function sectionsLine(p: Project, r: ResolvedFocus): string[] {
  const ts = p.transport.timeSig;
  const sections = songSections(p);
  const lines: string[] = [];
  const touched = sections.filter((x) => x.from < r.to && x.to > r.from);
  const before = [...sections].reverse().find((x) => x.to <= r.from);
  const after = sections.find((x) => x.from >= r.to);
  const name = (x: Section) => `“${x.name}” ${barSpan(x.from, x.to, ts)}`;
  if (!r.section && touched.length) lines.push(`Sections it is in: ${touched.map(name).join(', ')}.`);
  const around = [before ? `before it ${name(before)}` : 'nothing before it', after ? `after it ${name(after)}` : 'the song ends after it'];
  if (sections.length) lines.push(`Around it: ${around.join('; ')}.`);
  return lines;
}

/** The time part: where it is, the clips per track around it, its patterns' notes, activity, automation. */
function timeContext(p: Project, r: ResolvedFocus, plugins?: PluginInfoResolver): string[] {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const span = barSpan(r.from, r.to, ts);
  const bars = r2((r.to - r.from) / bar);
  const lines: string[] = [];
  const what = r.section
    ? `the section “${r.section.name}” (marker ${r.section.markerId}), ${span}`
    : r.clips
      ? `${plural(r.clips.size, 'selected clip')} (${span})`
      : `${span} (a range the musician looped)`;
  lines.push(`The musician is asking about ${what}: ${plural(bars, 'bar')}.`);
  lines.push(...sectionsLine(p, r));
  const lo = Math.max(0, r.from - bar);
  const hi = r.to + bar;
  lines.push(
    r.clips
      ? `Change only these clips (and clips you add within ${span}); a transition may start at ${barSpan(lo, lo + bar, ts)} or end in ${barSpan(r.to, hi, ts)}.`
      : `Change only ${span}; a transition may start in ${barSpan(lo, lo + bar, ts)} or end in ${barSpan(r.to, hi, ts)}. Everything else stays as it is.`,
  );

  if (r.clips) {
    lines.push('', 'The selected clips:');
    for (const id of r.clips) {
      const c = p.playlist.clips[id]!;
      const lane = p.playlist.laneOrder.indexOf(c.laneId) + 1;
      const what =
        c.kind === 'pattern' ? `“${p.patterns[c.patternId]?.name ?? '?'}”` : `${c.kind} “${p.channels[c.channelId]?.name ?? '?'}”`;
      lines.push(`- ${what} on track ${lane}, ${barSpan(c.start, c.start + c.length, ts)}${c.muted ? ' (muted)' : ''} ${c.id}`);
    }
  }

  // Clips per track over the part and 2 bars either side.
  const w0 = Math.max(0, r.from - 2 * bar);
  const w1 = r.to + 2 * bar;
  const cuts = [r.from, r.to];
  const trackLines: string[] = [];
  p.playlist.laneOrder.forEach((laneId, i) => {
    const runs = laneRuns(p, laneId, cuts).filter((x) => x.from < w1 && x.to > w0);
    if (!runs.length) return;
    const groups: Record<'before' | 'in' | 'after', string[]> = { before: [], in: [], after: [] };
    for (const run of runs) {
      if (run.to <= r.from) groups.before.push(runText(p, run, false));
      else if (run.from >= r.to) groups.after.push(runText(p, run, false));
      else {
        const edge = run.from < r.from ? ' (starts before the part)' : run.to > r.to ? ' (runs past the part)' : '';
        groups.in.push(`${runText(p, run, true)}${edge}`);
      }
    }
    const lane = p.playlist.lanes[laneId];
    const name = lane && !/^Track \d+$/.test(lane.name) ? ` "${lane.name}"` : '';
    const parts = [
      groups.before.length ? `before: ${groups.before.join('; ')}` : '',
      groups.in.length ? `in the part: ${groups.in.join('; ')}` : '',
      groups.after.length ? `after: ${groups.after.join('; ')}` : '',
    ].filter(Boolean);
    trackLines.push(`- Track ${i + 1}${name}${lane?.muted ? ' (muted)' : ''}: ${parts.join(' | ')}`);
  });
  lines.push(
    '',
    `Clips on the playlist around it (${barSpan(w0, w1, ts)}; “before” and “after” are the 2 bars either side, for transitions):`,
    ...(trackLines.length ? trackLines : ['(nothing plays here)']),
  );

  // The patterns that play in the part, with their notes.
  const pats = partPatterns(p, r);
  if (pats.length) {
    lines.push(
      '',
      'Patterns that play in the part (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8):',
    );
    const copyOf = new Map([...r.copies].map(([orig, copy]) => [copy, orig]));
    for (const pid of pats) {
      const pat = p.patterns[pid]!;
      const len = r2(patternLength(pat, ts) / bar);
      const out = usesOutside(p, r, pid);
      const where = out.length
        ? `also plays at ${out.map((s) => barSpan(s.from, s.to, ts)).join(', ')} (editing it gives the part its own copy first)`
        : 'plays only in this part (edits change only the part)';
      const orig = copyOf.get(pid);
      const note = orig && p.patterns[orig] ? `; the part's own copy of “${p.patterns[orig]!.name}”` : '';
      lines.push(`- “${pat.name}” ${pid}, ${plural(len, 'bar')}: ${where}${note}`);
      const notes = noteLines(p, pat);
      lines.push(...(notes.length ? notes : ['  (empty)']));
    }
  }

  // What plays, bar by bar, from 4 bars before to 4 after.
  const a0 = Math.max(0, r.from - 4 * bar);
  const a1 = r.to + 4 * bar;
  const activity = barActivity(p, a0, a1);
  const shown = activity.slice(0, 64);
  const chName = (id: ChannelId) => p.channels[id]?.name ?? '?';
  lines.push('', `What plays per bar (notes starting in each bar, ${barSpan(a0, a1, ts)}):`);
  for (const b of shown) {
    const where = b.to <= r.from ? ' (before)' : b.from >= r.to ? ' (after)' : '';
    const parts = [
      b.total ? `${plural(b.total, 'note')}: ${b.notes.map((n) => `${chName(n.channelId)} ${n.count}`).join(', ')}` : '',
      b.audio.length ? `audio ${b.audio.map((id) => `“${chName(id)}”`).join(', ')}` : '',
      b.automation.length ? `automation ${b.automation.map((id) => `“${chName(id)}”`).join(', ')}` : '',
    ].filter(Boolean);
    lines.push(`- bar ${b.bar}${where}: ${parts.length ? parts.join('; ') : 'silence'}`);
  }
  if (activity.length > shown.length) lines.push(`- … +${activity.length - shown.length} more bars`);

  // Automation clips over the part (and the 2 bars either side).
  const autoLines: string[] = [];
  const specsOf = (id: string) => plugins?.(id)?.params as ParamSpecs | undefined;
  for (const c of Object.values(p.playlist.clips).sort((x, y) => x.start - y.start)) {
    if (c.kind !== 'automation' || c.start >= w1 || c.start + c.length <= w0) continue;
    const ch = p.channels[c.channelId];
    if (ch?.kind !== 'automation') continue;
    const target = ch.target;
    const what = (target && plugins ? targetName(p, target, plugins) : null) ?? ch.name;
    const res = target ? resolveTarget(p, target, specsOf, ch.range) : null;
    const value = (n: number) => (res && target ? formatAutomationValue(res, target, n) : `${Math.round(n * 100)}%`);
    const pts = ch.points;
    const curve = pts.length ? `${value(pts[0]!.value)} → ${value(pts[pts.length - 1]!.value)}` : 'no points';
    const lane = p.playlist.laneOrder.indexOf(c.laneId) + 1;
    autoLines.push(
      `- “${what}” (automation ${ch.id}) on track ${lane}, ${barSpan(c.start, c.start + c.length, ts)}: ${curve}${c.muted ? ' (muted)' : ''}`,
    );
  }
  lines.push(
    '',
    'Automation over the part (a control keeps its last value after its clip ends):',
    ...(autoLines.length ? autoLines : ['(none)']),
  );
  return lines;
}

/** The notes part: the selected notes, the channel's other notes, where the pattern plays. */
function notesContext(p: Project, r: ResolvedFocus): string[] {
  const { patternId, channelId, ids } = r.notes!;
  const ts = p.transport.timeSig;
  const pat = p.patterns[patternId]!;
  const ch = p.channels[channelId]!;
  const all = Object.values(pat.notes[channelId] ?? {});
  const selected = all.filter((n) => ids.has(n.id));
  const others = all.filter((n) => !ids.has(n.id));
  const bars = r2(patternLength(pat, ts) / ticksPerBar(ts));
  const lines = [
    `The musician selected ${plural(selected.length, 'note')} of “${ch.name}” ${channelId} in the pattern “${pat.name}” ${patternId} (${plural(bars, 'bar')}) and the request is about them.`,
    'Only these notes may change: write_notes on that channel (replace) swaps them for the notes you write, note_tool works on them alone, and the steps tools are off. The channel’s other notes stay as they are.',
    '',
    `Selected notes (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8): ${formatNotes(p, channelId, selected)}`,
    `The other notes of “${ch.name}” in this pattern: ${others.length ? formatNotes(p, channelId, others) : 'none'}`,
  ];
  const rest = p.channelOrder.filter((c) => c !== channelId && Object.keys(pat.notes[c] ?? {}).length > 0);
  if (rest.length)
    lines.push(
      `Other channels in “${pat.name}”: ${rest.map((c) => `${p.channels[c]?.name ?? c} (${Object.keys(pat.notes[c] ?? {}).length})`).join(', ')}`,
    );
  const spans = merged(
    Object.values(p.playlist.clips)
      .filter((c) => c.kind === 'pattern' && c.patternId === patternId)
      .map((c) => ({ from: c.start, to: c.start + c.length })),
  );
  lines.push(
    spans.length
      ? `“${pat.name}” plays at ${spans.map((s) => barSpan(s.from, s.to, ts)).join(', ')} in the song: the changed notes play there.`
      : `“${pat.name}” isn't in the song (it plays in pattern mode).`,
  );
  return lines;
}

/**
 * The <focus> block the AI gets with a request about a part: what the part is, the song around it,
 * the clips and notes in it, and what may change. `plugins` names plugin settings for automation.
 */
export function focusContext(p: Project, r: ResolvedFocus, plugins?: PluginInfoResolver): string {
  const lines = r.notes ? notesContext(p, r) : timeContext(p, r, plugins);
  return [`Working on: ${cap(r.label)}`, ...lines].join('\n');
}
