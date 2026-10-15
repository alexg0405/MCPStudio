/**
 * Keeps an answer's edits inside the part of the song the request is about (the focus): patterns that
 * also play elsewhere are copied for the part first, playlist edits must stay within the part (±1 bar
 * for transitions), selected notes limit note edits. Without a focus every check passes unchanged.
 *
 * Reads the draft with plain loops (memoized queries would keep its proxies); what played before the
 * answer comes from the committed project (`c.base`).
 */
import { curveAt } from '@core/automation/curve';
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { automationAt, automationModelOf } from '@core/automation/model';
import { resolveTarget, type ResolvedTarget } from '@core/automation/targets';
import { tempoMapOf } from '@core/automation/tempo';
import { newId } from '@core/model/ids';
import { targetKey } from '@core/model/targets';
import type {
  AutoPoint,
  ChannelId,
  Clip,
  ClipId,
  Note,
  NoteId,
  ParamTarget,
  PatternClip,
  PatternId,
  Tick,
} from '@core/model/types';
import { forkPattern } from '@core/ops/fork';
import { mutedLanes } from '@core/query/playlist';
import { barOf, barSpan } from '@core/time/bars';
import type { ParamSpecs } from '@agstudio/sdk';
import type { AiFocus, FocusCopies, ResolvedFocus } from '../focus';
import type { PromptSection } from '../prompt-section';
import { fail, type OpContext } from './context';

export interface FocusGuard {
  readonly active: ResolvedFocus | null;
  /** The pattern an action should use (a copy made for the part, once one exists). */
  resolve(pid: PatternId): PatternId;
  /** Before a content edit: the pattern to write into (copies a pattern that also plays outside the part). */
  writable(pid: PatternId): PatternId;
  /** Before removing a pattern: refuses one that plays outside the part. */
  owned(pid: PatternId, what: string): void;
  /** A playlist edit over from–to: refused when it reaches outside the part (±1 bar). */
  span(from: Tick, to: Tick, what: string): void;
  /** An edit of one clip: refused when the clip lies outside the part. */
  clip(id: ClipId, what: string): void;
  /** Whether clearing the playlist may remove or cut this clip (a clips focus keeps the clips not selected). */
  clearable(clip: Clip): boolean;
  /** Default range for actions that take one (clear_playlist, automate). */
  range(): { from: Tick; to: Tick } | null;
  /** A notes focus on this pattern and channel: the notes that may change (null = all). */
  notes(pid: PatternId, cid: ChannelId): ReadonlySet<NoteId> | null;
  /** Refuses whole-pattern edits (steps tools, clearing every channel) in a notes focus. */
  wholePattern(pid: PatternId, cid: ChannelId | null, what: string): void;
  /**
   * An automation clip in the part: may end the curve where the control sat before (automation holds
   * its last value). Returns a change line when it did.
   */
  closeAutomation(target: ParamTarget, res: ResolvedTarget, start: Tick, length: Tick, points: AutoPoint[]): string | null;
  /** After the last action: the focus as it is now, and the clips to select. */
  finish(): { focus: AiFocus | null; clips: ClipId[] };
}

export const NO_FOCUS: FocusGuard = {
  active: null,
  resolve: (pid) => pid,
  writable: (pid) => pid,
  owned: () => {},
  span: () => {},
  clip: () => {},
  clearable: () => true,
  range: () => null,
  notes: () => null,
  wholePattern: () => {},
  closeAutomation: () => null,
  finish: () => ({ focus: null, clips: [] }),
};

type Ctx = Omit<OpContext, 'focus'>;

export function createFocusGuard(c: Ctx, focus: ResolvedFocus | null): FocusGuard {
  if (!focus) return NO_FOCUS;
  return focus.notes ? notesGuard(c, focus) : timeGuard(c, focus);
}

const spanText = (c: Ctx, from: Tick, to: Tick) =>
  Number.isFinite(from) && Number.isFinite(to) ? barSpan(Math.max(0, from), to, c.d.transport.timeSig) : 'the whole song';

/** "track 3, bars 37–38". */
const clipPlace = (c: Ctx, clip: Clip) =>
  `track ${c.d.playlist.laneOrder.indexOf(clip.laneId) + 1}, ${barSpan(clip.start, clip.start + clip.length, c.d.transport.timeSig)}`;

/** A pattern name nobody uses yet. */
function uniqueName(c: Ctx, name: string): string {
  const names = new Set(Object.values(c.d.patterns).map((p) => p.name.toLowerCase()));
  let out = name;
  for (let n = 2; names.has(out.toLowerCase()); n++) out = `${name} ${n}`;
  return out;
}

const specsOf = (c: Ctx) => (id: string) => c.s.plugins.get(id)?.params as ParamSpecs | undefined;
const pluginInfo = (c: Ctx) => (id: string) => {
  const def = c.s.plugins.get(id);
  return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
};

/** A range, a marker section or some clips: edits stay inside a span of the song. */
function timeGuard(c: Ctx, r: ResolvedFocus): FocusGuard {
  const { d, base, state } = c;
  const from = r.from;
  const to = r.to;
  const ts = () => d.transport.timeSig;
  /** Original → the part's copy: from earlier answers (r.copies), then this one's. */
  const redirect = new Map<PatternId, PatternId>(r.copies);
  const made = new Set<PatternId>();
  /** The clips of a clips focus (the guard keeps them, the rest of the song is outside). */
  const chosen = r.clips;
  const allowed = () => ({ lo: Math.max(0, from - c.bar()), hi: to + c.bar() });

  /** This answer's own clips that sit within the part (±1 bar): they belong to it. */
  const answerClip = (x: Clip) => {
    if (!state.clips.has(x.id)) return false;
    if (chosen) return x.start < to && x.start + x.length > from;
    const { lo, hi } = allowed();
    return x.start >= lo && x.start + x.length <= hi;
  };
  const inside = (x: Clip) =>
    chosen ? chosen.has(x.id) || answerClip(x) : (x.start < to && x.start + x.length > from) || answerClip(x);

  /** Where a pattern plays: clips in the part, and uses outside it (a straddling clip is both). */
  const uses = (pid: PatternId) => {
    const ins: PatternClip[] = [];
    const out: PatternClip[] = [];
    for (const x of Object.values(d.playlist.clips)) {
      if (x.kind !== 'pattern' || x.patternId !== pid) continue;
      const clip = x as PatternClip;
      if (!inside(clip)) {
        out.push(clip);
        continue;
      }
      ins.push(clip);
      if (!chosen && !answerClip(clip) && (clip.start < from || clip.start + clip.length > to)) out.push(clip);
    }
    return { ins, out };
  };
  const where = (list: readonly Clip[]) => {
    const spans = list.map((x) => ({ from: x.start, to: x.start + x.length })).sort((a, b) => a.from - b.from);
    const merged: { from: Tick; to: Tick }[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
      else merged.push({ ...s });
    }
    const shown = merged.slice(0, 4).map((s) => barSpan(s.from, s.to, ts()));
    return `${shown.join(', ')}${merged.length > 4 ? '…' : ''}`;
  };

  const resolve = (pid: PatternId): PatternId => {
    const copy = redirect.get(pid);
    if (!copy || !d.patterns[copy]) return pid;
    // A copy from an earlier answer counts while it still plays in the part.
    if (!made.has(copy) && uses(copy).ins.length === 0) return pid;
    return copy;
  };

  const guard: FocusGuard = {
    active: r,
    resolve,

    writable(raw) {
      const pid = resolve(raw);
      const pat = d.patterns[pid];
      // Made in this answer (a new pattern, a clip's own copy, the part's copy): only the part uses it.
      if (!pat || !base.patterns[pid]) return pid;
      const { ins, out } = uses(pid);
      if (ins.length === 0) {
        // Not in the song: changing it changes nothing that plays.
        if (out.length === 0) return pid;
        return fail(
          `“${pat.name}” doesn't play in ${r.label} (it plays at ${where(out)}); add a pattern for the part, or make one of the part's clips unique (clip make_unique) and edit that`,
        );
      }
      if (out.length === 0) return pid;
      // It plays inside and outside: the part gets its own copy, and the rest of the song keeps the original.
      const copy = newId.pattern();
      const name = uniqueName(c, `${pat.name} (${r.short})`);
      const answer = new Set(ins.filter(answerClip).map((x) => x.id));
      forkPattern(
        d,
        pid,
        chosen ? { clips: new Set(ins.map((x) => x.id)) } : { from, to, also: answer },
        copy,
        name,
        tempoMapOf(base, 'song'),
      );
      redirect.set(pid, copy);
      made.add(copy);
      // The current pattern follows (the channel rack and piano roll show the part's copy).
      const current = state.selectPattern ?? c.s.view.getState().currentPatternId;
      if (current === pid) state.selectPattern = copy;
      c.note(`Made a copy of “${pat.name}” for ${r.short}, so the rest of the song stays the same`);
      return copy;
    },

    owned(pid) {
      const pat = d.patterns[pid];
      if (!pat || !base.patterns[pid]) return;
      const { ins, out } = uses(pid);
      if (out.length)
        fail(`“${pat.name}” also plays outside ${r.label} (at ${where(out)}), so it stays; clear its clips in the part instead (clear_playlist)`);
      if (ins.length === 0) fail(`“${pat.name}” doesn't play in ${r.label}, so it stays`);
    },

    span(a, b) {
      const { lo, hi } = allowed();
      if (a >= lo && b <= hi) return;
      const text = spanText(c, a, b);
      fail(
        `${text} ${text.startsWith('bars ') ? 'reach' : 'reaches'} outside the part you're working on (${r.label}); only ${barSpan(from, to, ts())} can change, or ${barSpan(lo, hi, ts())} for a transition`,
      );
    },

    clip(id) {
      const x = d.playlist.clips[id];
      if (!x) return;
      if (chosen) {
        if (inside(x)) return;
        fail(`the clip on ${clipPlace(c, x)} isn't one of the selected clips (${r.label}); change those, or clips you add`);
      }
      const { lo, hi } = allowed();
      if (x.start >= lo && x.start + x.length <= hi) return;
      fail(`the clip on ${clipPlace(c, x)} reaches outside the part (${r.label}), so it stays as it is`);
    },

    clearable: (x) => !chosen || inside(x),

    range: () => ({ from, to }),

    notes: () => null,

    wholePattern: () => {},

    closeAutomation(target, res, start, length, points) {
      const end = start + length;
      const key = targetKey(target);
      // Another clip of the control that plays on at the end (or starts right there) takes over.
      const muted = mutedLanes(d.playlist);
      for (const x of Object.values(d.playlist.clips)) {
        if (x.kind !== 'automation' || x.muted || muted.has(x.laneId)) continue;
        const ch = d.channels[x.channelId];
        if (ch?.kind !== 'automation' || ch.muted || !ch.target || targetKey(ch.target) !== key) continue;
        if (x.start <= end && end < x.start + x.length) return null;
      }
      // What played at the end before this answer: earlier automation (in its own range), else the setting.
      const ta = automationModelOf(base).targets.get(key);
      const was = ta ? automationAt(ta, end) : null;
      let value: number;
      if (was) {
        const old = resolveTarget(base, target, specsOf(c), was.span.range);
        value = old ? res.toNormalized(old.fromNormalized(was.value)) : was.value;
      } else value = res.toNormalized(res.base);
      if (points.length === 0) return null;
      const last = curveAt(points, length) ?? points[points.length - 1]!.value;
      if (Math.abs(last - value) < 1e-4) return null;
      // Hold the curve to the clip's end, then step back to where the control sat.
      if (points[points.length - 1]!.tick < length) points.push({ tick: length, value: last });
      points.push({ tick: length, value });
      const name = targetName(c.project, target, pluginInfo(c)) ?? 'The automation';
      return `“${name}” goes back to ${formatAutomationValue(res, target, value)} at bar ${barOf(end, ts())} (where it was before), so the rest of the song stays the same`;
    },

    finish() {
      const copies: FocusCopies = {} as FocusCopies;
      for (const [orig, copy] of redirect) if (d.patterns[orig] && d.patterns[copy]) copies[orig] = copy;
      const kept = Object.keys(copies).length ? { copies } : {};
      if (!chosen) {
        const { copies: _old, ...rest } = r.focus as Extract<AiFocus, { kind: 'range' | 'section' }>;
        return { focus: { ...rest, ...kept } as AiFocus, clips: [] };
      }
      // The selected clips that are left, and the answer's clips inside the part.
      const ids: ClipId[] = [];
      for (const id of chosen) if (d.playlist.clips[id]) ids.push(id);
      for (const id of state.clips) {
        const x = d.playlist.clips[id];
        if (x && !chosen.has(id) && x.start < to && x.start + x.length > from) ids.push(id);
      }
      if (!ids.length) return { focus: null, clips: [] };
      return { focus: { kind: 'clips', clipIds: ids, projectId: r.focus.projectId, ...kept }, clips: ids };
    },
  };
  return guard;
}

/** Some notes of one channel in a pattern: only they change, nothing else does. */
function notesGuard(c: Ctx, r: ResolvedFocus): FocusGuard {
  const { d, base } = c;
  const { patternId: P, channelId: C, ids: picked } = r.notes!;
  const patName = () => d.patterns[P]?.name ?? 'the pattern';
  const about = () => `${r.label} in “${patName()}”`;
  /** The notes of the pattern that weren't selected: they must stay as they are. */
  const kept = new Map<ChannelId, Map<NoteId, Note>>();
  const before = base.patterns[P]?.notes;
  for (const cid of Object.keys(before ?? {}) as ChannelId[]) {
    const m = new Map<NoteId, Note>();
    for (const n of Object.values(before?.[cid] ?? {})) if (!(cid === C && picked.has(n.id))) m.set(n.id, n);
    if (m.size) kept.set(cid, m);
  }
  /** The selection now: the channel's notes that weren't kept (new notes count as selected). */
  const selection = (): Set<NoteId> => {
    const keep = kept.get(C);
    const out = new Set<NoteId>();
    for (const id of Object.keys(d.patterns[P]?.notes[C] ?? {}) as NoteId[]) if (!keep?.has(id)) out.add(id);
    return out;
  };
  const isNew = (pid: PatternId) => !base.patterns[pid];
  const noPlaylist = () =>
    fail(`the request is about ${about()}: the playlist stays as it is (ask about bars, clips or a section to change the arrangement)`);

  return {
    active: r,
    resolve: (pid) => pid,
    writable(pid) {
      if (pid === P || isNew(pid)) return pid;
      return fail(`the request is about ${about()}; “${d.patterns[pid]?.name ?? 'that pattern'}” stays as it is (add a pattern for new material)`);
    },
    owned(pid) {
      if (isNew(pid)) return;
      fail(`the request is about ${about()}, so the patterns stay`);
    },
    span: noPlaylist,
    clip: noPlaylist,
    clearable: () => false,
    range: () => null,
    notes(pid, cid) {
      if (pid !== P) return null;
      // Other channels of the pattern: nothing of theirs changes (new notes are added).
      return cid === C ? selection() : new Set<NoteId>();
    },
    wholePattern(pid, _cid, what) {
      if (pid !== P && isNew(pid)) return;
      fail(`${what} would change the whole pattern; the request is about ${about()} (write_notes with replace or note_tool change just them)`);
    },
    closeAutomation: () => null,
    finish() {
      // A safety net: the notes that weren't selected are put back as they were.
      const pat = d.patterns[P];
      let restored = 0;
      if (pat) {
        for (const [cid, notes] of kept) {
          for (const [id, n] of notes) {
            const now = pat.notes[cid]?.[id];
            const same =
              now &&
              now.tick === n.tick &&
              now.length === n.length &&
              now.key === n.key &&
              now.velocity === n.velocity &&
              now.pan === n.pan &&
              now.muted === n.muted &&
              now.release === n.release &&
              now.fine === n.fine;
            if (same) continue;
            if (!pat.notes[cid]) pat.notes[cid] = {} as never;
            pat.notes[cid]![id] = { ...n };
            restored++;
          }
        }
      }
      if (restored) c.warn(`kept ${restored} note${restored === 1 ? '' : 's'} you didn't select as they were`);
      const ids = [...selection()];
      if (!pat || ids.length === 0) return { focus: null, clips: [] };
      return { focus: { kind: 'notes', patternId: P, channelId: C, noteIds: ids, projectId: r.focus.projectId }, clips: [] };
    },
  };
}

/** The "Working on a part" section of the studio prompt. */
export const FOCUS_PROMPT: PromptSection = {
  id: 'part',
  order: 30,
  text: `Working on a part (the turn has a <focus>): the musician selected that part (a marker section, bars, clips or notes) and the request is about it. Change only that part; keep the rest of the song exactly as it is, and say what you changed there. The <focus> block shows the part, the 2 bars either side, the notes of its patterns and where else they play. Edit the part's patterns by id: if one also plays elsewhere, AGstudio gives the part its own copy first (the changes say so). For one spot inside the part (a fill in its last bar), make that clip unique first (clip action make_unique) and edit the ref. Playlist edits (placing, clearing, moving, automation) stay inside the part; a transition may start 1 bar before or end 1 bar after it; further is refused. For transitions, add new clips (a fill, a crash, a riser) rather than editing the neighbours' patterns. Automation keeps its last value after its clip ends: end curves where the control normally sits (AGstudio adds the return when you don't). Mixer, channel, plugin and song settings change the whole song: only when asked, and say so; for "harder" or "louder" in one part prefer velocities, layers or automation. When a part repeats the same bars many times, develop it: make later repeats unique and vary them. Selected notes: write_notes (replace) and note_tool change only the selected notes of that channel; step tools aren't available, and the playlist and other patterns stay as they are.`,
};
