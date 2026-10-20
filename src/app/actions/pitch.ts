/**
 * Pitch correction of audio clips as user actions (the Pitch editor window, the AI and MCP share
 * these): analysis of a clip's sung line (cached, in a Worker), edits that are one undo step each,
 * and the renderer that keeps the corrected audio up to date (`pitch-render.ts`, re-exported here).
 *
 * The corrected audio is a new sample: TD-PSOLA in a Worker over the stretch of the clip's sample
 * that the edits touch, spliced into a copy of the whole sample (so trims, fades and tempo follow
 * keep working), stored as 24-bit FLAC through the sample store, and listed in `Project.samples`.
 * The clip names it in `pitchEdit.renderedSampleId`; the engine plays it instead of the channel's
 * sample, and the original stays. When an edit arrives the render starts after a short pause and
 * its result is folded into the edit's own undo step (undo brings back the edit and its render
 * together).
 */
import { alignedSampleId } from '@core/audio/align/edit';
import { tempoMapOf } from '@core/automation/tempo';
import { clipSourceRange, playbackMode } from '@core/audio/playback';
import {
  applyPitchAction,
  DEFAULT_TRANSITION_MS,
  mapNotes,
  mergeNotes as mergeEditNotes,
  monoMix,
  nearestAllowed,
  noteTarget,
  pitchEditFrom,
  snapToKey,
  splitNote as splitEditNote,
  tidyNote,
  withTarget,
  type PitchAction,
} from '@core/audio/pitch-edit';
import type { AudioClip, ClipId, PitchEdit, Project, SampleRef } from '@core/model/types';
import { setPitchEdit } from '@core/ops/pitch';
import { scaleMask } from '@agstudio/sdk/notes';
import { pitchAnalysisKey, pitchAnalysisStore } from '../pitch/analysis-store';
import { analyzeInWorker } from '../pitch/pitch-jobs';
import { pitchState, type ClipPitch } from '../pitch/state';
import type { Services } from '../services';
import { audioClipOf, PitchError, pitchProblem } from './pitch-clip';

// The renderer and the clip checks live in their own files; the editor, the AI and the MCP tools keep importing them from here.
export { audioClipOf, PitchError, pitchProblem } from './pitch-clip';
export { renderNow, RENDER_DELAY_MS, startPitchRenderer } from './pitch-render';

/** Longest sample the editor takes (a 15-minute song is already a lot to correct in one piece). */
export const PITCH_MAX_SECONDS = 15 * 60;
/** Seconds of margin around the clip's part of the sample that the analysis covers. */
const ANALYSIS_MARGIN = 0.25;

// ---- Which clip ----

/** The audio clip the editor should open for: the selected one, or the only audio clip with a pitch edit. */
export function defaultPitchClip(s: Services): ClipId | null {
  const p = s.doc.getState().project;
  for (const id of s.editor.getState().clipSelection) if (p.playlist.clips[id]?.kind === 'audio') return id;
  const edited = Object.values(p.playlist.clips).filter((c) => c.kind === 'audio' && c.pitchEdit);
  return edited.length === 1 ? (edited[0] as AudioClip).id : null;
}

// ---- Analysis (cached) ----

const cache = new Map<string, ClipPitch['analysis']>();
const inflight = new Map<string, Promise<ClipPitch['analysis']>>();
const CACHE_LIMIT = 8;

/** Forgets the analyses kept in memory (tests; the stored ones stay). */
export function clearPitchAnalysisMemory(): void {
  cache.clear();
  inflight.clear();
  latest.clear();
}

function sourceKey(ref: SampleRef): string {
  return ref.source.kind === 'embedded' ? `${ref.source.hash}.${ref.source.ext}` : `${ref.source.generator}@${ref.source.version}`;
}

/** The pitch analysis of a clip's part of its sample. Cached by the sample and the range; runs in a Worker. */
export async function analyzeClip(s: Services, clipId: ClipId): Promise<ClipPitch> {
  const p = s.doc.getState().project;
  const problem = pitchProblem(p, clipId);
  if (problem) throw new PitchError(problem);
  const { clip, channel } = audioClipOf(p, clipId) as NonNullable<ReturnType<typeof audioClipOf>>;
  // The notes are found on the aligned sound when the clip has one (align first, then tune).
  const ref = (p.samples[alignedSampleId(channel, clip)] ?? p.samples[channel.sampleId]) as SampleRef;
  const data = await s.engine.sampleData(ref);
  if (!data) throw new PitchError('This clip’s audio could not be read.');
  if (data.duration > PITCH_MAX_SECONDS) throw new PitchError('This sound is over 15 minutes long: cut the clip out of it first, then correct the pitch.');
  const tempo = tempoMapOf(p, 'song');
  const r = clipSourceRange(clip, playbackMode(channel), tempo, data.duration);
  const sr = data.sampleRate;
  const from = Math.max(0, Math.floor((r.from - ANALYSIS_MARGIN) * 20) / 20);
  const to = Math.min(data.duration, Math.ceil((r.to + ANALYSIS_MARGIN) * 20) / 20);
  const range = { from, to };
  const key = `${sourceKey(ref)}|${sr}|${from.toFixed(2)}|${to.toFixed(2)}`;
  let analysis = cache.get(key);
  if (!analysis) {
    let pending = inflight.get(key);
    if (!pending) {
      // Recorded audio is also kept between sessions (IndexedDB, by sample hash, range and analysis version).
      const stored = ref.source.kind === 'embedded' ? pitchAnalysisStore() : null;
      const storedKey = stored && ref.source.kind === 'embedded' ? pitchAnalysisKey(ref.source.hash, sr, from, to) : null;
      pending = (async () => {
        const hit = stored && storedKey ? await stored.get(storedKey).catch(() => null) : null;
        if (hit) return hit;
        const a = Math.floor(from * sr);
        const mono = monoMix(data.channels, a, Math.ceil(to * sr));
        const res = await analyzeInWorker(mono, sr, a / sr).result;
        if (stored && storedKey) void stored.set(storedKey, res).catch(() => {});
        return res;
      })();
      inflight.set(key, pending);
      void pending.then(
        (res) => {
          cache.set(key, res);
          while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
          inflight.delete(key);
        },
        () => inflight.delete(key),
      );
    }
    analysis = await pending;
  } else {
    // Most recently used last.
    cache.delete(key);
    cache.set(key, analysis);
  }
  const result: ClipPitch = { clipId, range, duration: data.duration, analysis };
  latest.set(clipId, result);
  return result;
}

/**
 * A/B: hear a clip's original recording instead of its corrected render (`original` true), or the corrected sound
 * again (false); without `original` it switches. Session state only: nothing in the document changes, and the
 * render is untouched. Returns true when the original is heard now.
 */
export function hearOriginal(s: Services, clipId: ClipId, original?: boolean): boolean {
  const ed = s.editor.getState();
  const now = ed.pitchOriginal.includes(clipId);
  const next = original ?? !now;
  ed.setPitchOriginal(clipId, next);
  return next;
}

/** The last analysis made for each clip (the AI's reads and actions look here, since they cannot wait). */
const latest = new Map<ClipId, ClipPitch>();

/**
 * The clip's analysis when one is at hand and still covers the part the clip plays (null otherwise:
 * `analyzeClip` makes it). For callers that cannot wait for a Worker.
 */
export function peekClipPitch(p: Project, clipId: ClipId): ClipPitch | null {
  const found = audioClipOf(p, clipId);
  const hit = latest.get(clipId);
  if (!found || !hit) return null;
  const tempo = tempoMapOf(p, 'song');
  const r = clipSourceRange(found.clip, playbackMode(found.channel), tempo, hit.duration);
  return hit.range.from <= r.from + 1e-6 && hit.range.to >= r.to - 1e-6 ? hit : null;
}

/** The notes of a clip the way edits and the AI see them: the clip's own edit, else what was detected. */
export function pitchEditOf(p: Project, clipId: ClipId): PitchEdit | null {
  const own = audioClipOf(p, clipId)?.clip.pitchEdit;
  if (own) return own;
  const a = peekClipPitch(p, clipId);
  return a ? editFor(p, a) : null;
}

/** Applies an action to a clip's notes (all, or the given indices): analyses the clip when it has no notes yet. One undo step. */
export async function applyPitchActionToClip(
  s: Services,
  clipId: ClipId,
  action: PitchAction,
  notes: ReadonlySet<number> | 'all' = 'all',
  label = 'Pitch correction',
): Promise<boolean> {
  let edit = pitchEditOf(s.doc.getState().project, clipId);
  if (!edit) edit = editFor(s.doc.getState().project, await analyzeClip(s, clipId));
  const next = applyPitchAction(edit, action, notes);
  return commitEdit(s, clipId, next, label);
}

// ---- The editor's target ----

/** Shows a clip in the Pitch editor (its analysis starts now). Resolves when the notes are there. */
export async function loadPitchClip(s: Services, clipId: ClipId): Promise<ClipPitch | null> {
  const p = s.doc.getState().project;
  const problem = pitchProblem(p, clipId);
  if (problem) {
    pitchState.setState({ clipId, phase: 'error', message: problem, clip: null, selected: [] });
    return null;
  }
  const same = pitchState.getState().clipId === clipId;
  // A/B is for the clip being compared: another clip starts on its corrected sound.
  if (!same) s.editor.getState().clearPitchOriginal();
  pitchState.setState({ clipId, phase: 'analyzing', message: '', clip: same ? pitchState.getState().clip : null, selected: same ? pitchState.getState().selected : [] });
  try {
    const clip = await analyzeClip(s, clipId);
    if (pitchState.getState().clipId !== clipId) return clip;
    const song = p.transport.key;
    const st = pitchState.getState();
    pitchState.setState({
      phase: 'ready',
      clip,
      message: '',
      ...(st.keyFollowsSong && song ? { keyRoot: song.root, keyScale: song.scale } : {}),
    });
    return clip;
  } catch (e) {
    if (pitchState.getState().clipId === clipId) {
      pitchState.setState({ phase: 'error', message: e instanceof Error ? e.message : String(e), clip: null });
    }
    return null;
  }
}

// ---- Reading and changing a clip's edit ----

/** The clip's edit, or the one the detected notes give (nothing changed yet). */
export function editFor(p: Project, clip: ClipPitch): PitchEdit {
  const own = audioClipOf(p, clip.clipId)?.clip.pitchEdit;
  if (own) return own;
  return pitchEditFrom(clip.analysis.notes.filter((n) => n.to > clip.range.from && n.from < clip.range.to));
}

/** The edit of a clip as it is now (null while it has none). */
export function currentEdit(p: Project, clipId: ClipId): PitchEdit | null {
  return audioClipOf(p, clipId)?.clip.pitchEdit ?? null;
}

/** Writes an edit as one undo step (consecutive changes with the same `mergeKey` within a second share one). */
export function commitEdit(s: Services, clipId: ClipId, edit: PitchEdit, label: string, mergeKey?: string): boolean {
  return s.history.transact(label, (d) => setPitchEdit(d, clipId, edit), mergeKey ? { mergeKey } : {});
}

/** Removes all pitch edits of a clip (it plays its own audio again); one undo step. */
export function clearClipPitch(s: Services, clipId: ClipId): boolean {
  const p = s.doc.getState().project;
  if (!currentEdit(p, clipId)) return false;
  return s.history.transact('Remove pitch correction', (d) => setPitchEdit(d, clipId, null));
}

/** The allowed pitch classes of a key (root 0–11, scale id from the SDK's scale list). */
export function keyMask(root: number, scale: string): boolean[] {
  return scaleMask(root, scale);
}

/** Pulls every note (or the given ones) to a key; `strength` 0–1. One undo step. */
export function snapClip(
  s: Services,
  clip: ClipPitch,
  key: { root: number; scale: string },
  strength: number,
  which: ReadonlySet<number> | 'all' = 'all',
): boolean {
  const p = s.doc.getState().project;
  const edit = snapToKey(editFor(p, clip), keyMask(key.root, key.scale), strength, which);
  return commitEdit(s, clip.clipId, edit, `Snap pitch to key (${Math.round(strength * 100)} %)`);
}

/** Moves one note to a target pitch (MIDI, fractional). One undo step. */
export function moveNote(s: Services, clip: ClipPitch, index: number, target: number, label = 'Move note'): boolean {
  const p = s.doc.getState().project;
  const edit = editFor(p, clip);
  const note = edit.notes[index];
  if (!note) return false;
  const next = mapNotes(edit, new Set([index]), (n) => withTarget(n, target));
  return commitEdit(s, clip.clipId, next, label);
}

/** Moves every selected note by the same number of semitones. One undo step. */
export function moveNotes(s: Services, clip: ClipPitch, indices: readonly number[], semitones: number, snapTo?: readonly boolean[]): boolean {
  const p = s.doc.getState().project;
  const edit = editFor(p, clip);
  const which = new Set(indices);
  const next = mapNotes(edit, which, (n) => {
    const t = noteTarget(n) + semitones;
    return withTarget(n, snapTo ? nearestAllowed(t, snapTo) : t);
  });
  return commitEdit(s, clip.clipId, next, indices.length > 1 ? `Move ${indices.length} notes` : 'Move note');
}

/** Sets drift flattening (0–1) and/or vibrato amount (0–2) of notes (`which`), merging slider drags. */
export function setNoteSettings(
  s: Services,
  clip: ClipPitch,
  which: ReadonlySet<number> | 'all',
  settings: { drift?: number; vibrato?: number },
  label: string,
  mergeKey?: string,
): boolean {
  const p = s.doc.getState().project;
  const edit = mapNotes(editFor(p, clip), which, (n) => ({
    ...n,
    ...(settings.drift !== undefined ? { drift: settings.drift } : {}),
    ...(settings.vibrato !== undefined ? { vibrato: settings.vibrato } : {}),
  }));
  return commitEdit(s, clip.clipId, edit, label, mergeKey);
}

export function setTransition(s: Services, clip: ClipPitch, ms: number, mergeKey?: string): boolean {
  const p = s.doc.getState().project;
  const edit = { ...editFor(p, clip), transition: ms === DEFAULT_TRANSITION_MS ? undefined : ms };
  if (edit.transition === undefined) delete edit.transition;
  return commitEdit(s, clip.clipId, edit, 'Transition speed', mergeKey);
}

/** Cuts the note under `t` seconds in two. */
export function splitAt(s: Services, clip: ClipPitch, t: number): boolean {
  const p = s.doc.getState().project;
  const edit = editFor(p, clip);
  const next = splitEditNote(edit, t, clip.analysis);
  return next !== edit && commitEdit(s, clip.clipId, next, 'Split note');
}

/** Joins a note with the next one. */
export function mergeAt(s: Services, clip: ClipPitch, index: number): boolean {
  const p = s.doc.getState().project;
  const edit = editFor(p, clip);
  const next = mergeEditNotes(edit, index, clip.analysis);
  return next !== edit && commitEdit(s, clip.clipId, next, 'Merge notes');
}

/** Puts every selected note (or all) back as it was sung. */
export function resetNotes(s: Services, clip: ClipPitch, which: ReadonlySet<number> | 'all'): boolean {
  const p = s.doc.getState().project;
  const edit = mapNotes(editFor(p, clip), which, (n) => tidyNote({ from: n.from, to: n.to, pitch: n.pitch }));
  return commitEdit(s, clip.clipId, edit, which === 'all' ? 'Reset all notes' : 'Reset notes');
}

// ---- Actions asked for by name (the AI, MCP and the `pitchEditor.apply` command) ----

export type PitchActionName = 'snap_to_key' | 'flatten_drift' | 'vibrato' | 'shift' | 'transition' | 'reset';
export const PITCH_ACTION_NAMES: readonly PitchActionName[] = ['snap_to_key', 'flatten_drift', 'vibrato', 'shift', 'transition', 'reset'];

export interface PitchActionArgs {
  action?: unknown;
  key?: { root: number; scale: string } | null;
  strength?: unknown;
  amount?: unknown;
  semitones?: unknown;
  to_midi?: unknown;
  ms?: unknown;
  notes?: unknown;
}

const numberOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * What a named action means: the change to make, which notes (0-based indices; `notes` in the
 * arguments are 1-based, as `get_pitch` lists them) and the undo label. `songKey` is the key used
 * when none is given.
 */
export function parsePitchAction(
  args: PitchActionArgs,
  songKey: { root: number; scale: string } | null | undefined,
): { action: PitchAction; notes: Set<number> | 'all'; label: string } | { error: string } {
  const list = Array.isArray(args.notes)
    ? args.notes
        .map(numberOf)
        .filter((n): n is number => n !== null && n >= 1)
        .map((n) => Math.round(n) - 1)
    : [];
  const notes: Set<number> | 'all' = list.length ? new Set(list) : 'all';
  const where = notes === 'all' ? '' : list.length === 1 ? ` (note ${list[0]! + 1})` : ` (${list.length} notes)`;
  switch (args.action) {
    case 'snap_to_key': {
      const key = args.key ?? songKey;
      if (!key) return { error: 'there is no song key: set it, or give key (e.g. "A minor")' };
      const pct = numberOf(args.strength) ?? 100;
      return {
        action: { kind: 'snap', allowed: keyMask(key.root, key.scale), strength: Math.max(0, Math.min(1, pct / 100)) },
        notes,
        label: `Snap pitch to key (${Math.round(Math.max(0, Math.min(100, pct)))} %)${where}`,
      };
    }
    case 'flatten_drift': {
      const pct = numberOf(args.amount) ?? 100;
      return { action: { kind: 'drift', amount: Math.max(0, Math.min(1, pct / 100)) }, notes, label: `Flatten pitch drift${where}` };
    }
    case 'vibrato': {
      const pct = numberOf(args.amount);
      if (pct === null) return { error: 'vibrato needs amount: 0 removes the vibrato, 100 leaves it as sung, 200 doubles it' };
      return { action: { kind: 'vibrato', amount: Math.max(0, Math.min(2, pct / 100)) }, notes, label: `Vibrato ${Math.round(pct)} %${where}` };
    }
    case 'shift': {
      const to = numberOf(args.to_midi);
      if (to !== null) return { action: { kind: 'to', midi: to }, notes, label: `Move pitch to MIDI ${Math.round(to * 100) / 100}${where}` };
      const st = numberOf(args.semitones);
      if (st === null) return { error: 'shift needs semitones (e.g. 2 or -1) or to_midi (a MIDI note number)' };
      return { action: { kind: 'shift', semitones: st }, notes, label: `Move pitch ${st > 0 ? '+' : ''}${st} st${where}` };
    }
    case 'transition': {
      const ms = numberOf(args.ms);
      if (ms === null) return { error: 'transition needs ms (0 jumps at once, 25 is natural, 100 or more slides)' };
      return { action: { kind: 'transition', ms }, notes: 'all', label: `Pitch transition ${Math.round(ms)} ms` };
    }
    case 'reset':
      return { action: { kind: 'reset' }, notes, label: `Reset pitch correction${where}` };
    default:
      return { error: `unknown pitch action "${String(args.action)}" (${PITCH_ACTION_NAMES.join(', ')})` };
  }
}
