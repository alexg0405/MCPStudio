/**
 * What the AI (and the MCP server) can read about a clip's sung pitch: the notes the Pitch editor
 * shows, with the numbers the `pitch` action takes. Synchronous: a clip that has not been analysed yet
 * starts its analysis (in a Worker) and answers "analyzing": ask again a moment later.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { playbackMode, tickAtSourceSeconds } from '@core/audio/playback';
import { pitchRenderSignature } from '@core/audio/align/edit';
import { isNeutralEdit, noteDrift, noteShift, noteTarget, noteVibrato } from '@core/audio/pitch-edit';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { PITCH_NAMES, keyLabel, scaleMask } from '@agstudio/sdk/notes';
import { analyzeClip, audioClipOf, peekClipPitch, pitchEditOf, pitchProblem } from '../actions/pitch';
import type { Services } from '../services';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** "C4" for MIDI 60 (scientific naming; the app's own piano roll counts octaves one higher). */
export function scientificName(midi: number): string {
  const k = Math.round(midi);
  return `${PITCH_NAMES[((k % 12) + 12) % 12]}${Math.floor(k / 12) - 1}`;
}

/** The clip a read means: the one given, else the selected audio clip, else the only one with a pitch edit, else the only audio clip. */
function pick(s: Services, given: unknown): { id: ClipId } | { error: string } {
  const p = s.doc.getState().project;
  const audio = Object.values(p.playlist.clips).filter((c): c is AudioClip => c.kind === 'audio');
  if (typeof given === 'string' && given) {
    const hit = audio.find((c) => c.id === given);
    return hit ? { id: hit.id } : { error: `there is no audio clip "${given}"` };
  }
  const selected = s.editor.getState().clipSelection.find((id) => p.playlist.clips[id]?.kind === 'audio');
  if (selected) return { id: selected };
  const edited = audio.filter((c) => c.pitchEdit);
  if (edited.length === 1) return { id: (edited[0] as AudioClip).id };
  if (audio.length === 1) return { id: (audio[0] as AudioClip).id };
  return { error: audio.length ? 'which clip? give clip (an audio clip id from get_clips)' : 'the song has no audio clips' };
}

export function pitchReport(s: Services, args: { clip?: unknown }): unknown {
  const target = pick(s, args.clip);
  if ('error' in target) return target;
  const id = target.id;
  const p: Project = s.doc.getState().project;
  const problem = pitchProblem(p, id);
  if (problem) return { clip: id, error: problem };
  const found = audioClipOf(p, id);
  if (!found) return { error: `there is no audio clip "${id}"` };
  const { clip, channel } = found;
  const edit = pitchEditOf(p, id);
  const analysis = peekClipPitch(p, id)?.analysis;
  if (!edit) {
    void analyzeClip(s, id).catch(() => undefined);
    return { clip: id, name: channel.name, state: 'analyzing', notes: [], message: 'Listening to the clip to find its notes: ask again in a moment.' };
  }
  const tempo = tempoMapOf(p, 'song');
  const mode = playbackMode(channel);
  const barT = ticksPerBar(p.transport.timeSig);
  const key = p.transport.key;
  const mask = key ? scaleMask(key.root, key.scale) : null;
  const corrected = !!edit.renderedSampleId && edit.renderedFor === pitchRenderSignature(channel, clip);
  return {
    clip: id,
    name: channel.name,
    state: 'ready',
    corrected_audio: isNeutralEdit(edit) ? 'none (nothing changed)' : corrected ? 'ready' : 'being made',
    // The musician's A/B switch (a listening choice, not part of the project): which one they hear now.
    hearing: s.editor.getState().pitchOriginal.includes(id) ? 'original recording' : 'corrected sound',
    ...(key ? { song_key: keyLabel(key.root, key.scale) } : {}),
    ...(edit.transition !== undefined ? { transition_ms: edit.transition } : {}),
    notes: edit.notes.map((n, i) => {
      const bar = tickAtSourceSeconds(clip, mode, tempo, n.from) / barT + 1;
      const measured = analysis?.notes.find((m) => m.from < n.to && m.to > n.from && Math.abs(m.pitch - n.pitch) < 0.5);
      const near = Math.round(n.pitch);
      const shift = noteShift(n);
      return {
        n: i + 1,
        bar: r2(bar),
        start_s: r2(n.from),
        end_s: r2(n.to),
        midi: r2(n.pitch),
        note: scientificName(n.pitch),
        cents_off: Math.round((n.pitch - near) * 100),
        ...(mask ? { in_key: !!mask[((near % 12) + 12) % 12] } : {}),
        ...(Math.abs(shift) >= 0.5 ? { target_midi: r2(noteTarget(n)), target_note: scientificName(noteTarget(n)), shift_cents: Math.round(shift) } : {}),
        ...(noteDrift(n) > 0 ? { drift_flattened_pct: Math.round(noteDrift(n) * 100) } : {}),
        ...(Math.abs(noteVibrato(n) - 1) > 0.001 ? { vibrato_pct: Math.round(noteVibrato(n) * 100) } : {}),
        ...(measured ? { drift_cents: Math.round(measured.drift), ...(measured.vibratoDepth > 0 ? { vibrato_depth_cents: Math.round(measured.vibratoDepth), vibrato_rate_hz: r1(measured.vibratoRate) } : {}) } : {}),
      };
    }),
  };
}
