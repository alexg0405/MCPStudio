/**
 * What the AI (and the MCP server) can read about a conversion before it is made: the notes "Convert to MIDI" would write for a
 * clip, with bars, key names and velocities. Synchronous like the pitch report: when the clip has not been listened to yet (for
 * these settings) the answer is "analyzing" and the listening starts in a Worker; ask again a moment later.
 */
import { GM_KEY, MODE_LABELS, TRANSCRIBE_MODES, type DrumKind, type PlannedNote, type TranscribeMode } from '@core/audio/transcribe';
import { formatChord } from '@core/harmony/chord';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { ticksPerBar, ticksPerBeat } from '@core/time/ppq';
import { PITCH_NAMES } from '@agstudio/sdk/notes';
import type { Services } from '../services';
import { settingsOfArgs, type ConvertArgs } from './args';
import { planClip, suggestForClip } from './convert';
import { peekPlan, peekSuggestion } from './plan-cache';
import { sourceProblem } from './source';

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The most notes a report lists (the rest are counted). */
const MAX_NOTES = 150;

/** "C4" for MIDI 60 (scientific naming). */
function noteName(key: number): string {
  return `${PITCH_NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;
}

/** The drum a General MIDI key stands for, by name. */
const DRUM_OF_KEY: Readonly<Record<number, string>> = {
  [GM_KEY.kick]: 'kick',
  [GM_KEY.perc]: 'side stick',
  [GM_KEY.snare]: 'snare',
  [GM_KEY.clap]: 'clap',
  [GM_KEY.hat]: 'closed hat',
  [GM_KEY['open-hat']]: 'open hat',
  [GM_KEY.cymbal]: 'cymbal',
  41: 'low tom',
  43: 'low tom',
  45: 'mid tom',
  47: 'mid tom',
  48: 'high tom',
  50: 'high tom',
};

/** The clip a read means: the one given, else the selected audio clip, else the only audio clip. */
function pick(s: Services, given: unknown): { id: ClipId } | { error: string } {
  const project = s.doc.getState().project;
  const audio = Object.values(project.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
  if (typeof given === 'string' && given) {
    return audio.some((c) => c.id === given) ? { id: given as ClipId } : { error: `there is no audio clip "${given}"` };
  }
  const selected = s.editor.getState().clipSelection.find((id) => project.playlist.clips[id]?.kind === 'audio');
  if (selected) return { id: selected };
  if (audio.length === 1) return { id: (audio[0] as AudioClip).id };
  return { error: audio.length ? 'which clip? give clip (an audio clip id from get_clips)' : 'the song has no audio clips' };
}

/** One planned note as the report lists it: where it is in the song, what it is and how it plays. */
function noteLine(project: Project, clip: AudioClip, note: PlannedNote, index: number, mode: TranscribeMode) {
  const song = clip.start + note.tick;
  const bar = ticksPerBar(project.transport.timeSig);
  const beat = ticksPerBeat(project.transport.timeSig);
  return {
    n: index + 1,
    bar: Math.floor(song / bar) + 1,
    beat: r2(((song % bar) / beat) + 1),
    key: note.key,
    ...(mode === 'drums' ? { drum: DRUM_OF_KEY[note.key] ?? 'percussion' } : { note: noteName(note.key) }),
    velocity: r2(note.velocity),
    length_beats: r2(note.length / beat),
    ...(note.fine ? { cents: note.fine } : {}),
  };
}

/** The AI's read of what converting a clip would make. */
export function conversionReport(s: Services, args: ConvertArgs): unknown {
  const target = pick(s, args.clip);
  if ('error' in target) return target;
  const project = s.doc.getState().project;
  const problem = sourceProblem(project, target.id);
  if (problem) return { clip: target.id, error: problem };
  const clip = project.playlist.clips[target.id] as AudioClip;
  if (args.mode !== undefined && args.mode !== 'auto' && !(TRANSCRIBE_MODES as readonly unknown[]).includes(args.mode)) {
    return { clip: target.id, error: `mode must be one of: auto, ${TRANSCRIBE_MODES.join(', ')}` };
  }
  const asked = args.mode === undefined || args.mode === 'auto' ? null : (args.mode as TranscribeMode);
  const mode = asked ?? peekSuggestion(project, target.id)?.mode ?? null;
  if (mode === null) {
    void suggestForClip(s, target.id).catch(() => undefined);
    return { clip: target.id, state: 'analyzing', message: 'Listening to the clip to choose a mode: ask again in a moment, or give mode (melody, drums, chords or bass).' };
  }
  let settings;
  try {
    settings = settingsOfArgs(mode, args);
  } catch (e) {
    return { clip: target.id, error: e instanceof Error ? e.message : String(e) };
  }
  const plan = peekPlan(project, target.id, settings);
  if (!plan) {
    void planClip(s, target.id, settings).catch(() => undefined);
    return { clip: target.id, mode, state: 'analyzing', notes: [], message: 'Listening to the clip to find its notes: ask again in a moment.' };
  }
  const channel = project.channels[clip.channelId];
  return {
    clip: target.id,
    name: channel?.name ?? '',
    mode,
    mode_name: MODE_LABELS[mode].label,
    state: 'ready',
    summary: plan.summary,
    notes_total: plan.notes.length,
    ...(plan.swingFound !== null ? { swing_found_pct: Math.round(plan.swingFound * 100) } : {}),
    notes: plan.notes.slice(0, MAX_NOTES).map((n, i) => noteLine(project, clip, n, i, mode)),
    ...(plan.notes.length > MAX_NOTES ? { truncated: `showing the first ${MAX_NOTES} notes` } : {}),
    ...(plan.chords.length
      ? {
          chords: plan.chords.map((c) => ({
            bar: r2(c.tick / ticksPerBar(project.transport.timeSig) + 1),
            chord: formatChord({ root: c.root, quality: c.quality, ...(c.bass !== undefined ? { bass: c.bass } : {}) }),
            confidence: c.confidence,
          })),
        }
      : {}),
    ...(plan.pads.length ? { pads_from_recording: plan.pads.map((p) => ({ pad: p.pad, kind: p.kind as DrumKind })) } : {}),
  };
}
