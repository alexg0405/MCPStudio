/**
 * "Convert to MIDI" as a user action: listen to an audio clip (a Worker; remembered), plan notes for it with the quantize and note
 * settings, and write them as a pattern: a new channel with a suggested instrument (Drum Pads with the recording's own hits,
 * if asked) or an existing one, a pattern clip where the audio clip plays, the chords on the chord track. One undo step. The
 * dialog, the commands, the AI and MCP share `planClip` (what would be made) and `convertToMidi` (make it).
 */
import { MODE_LABELS, planTranscription, type ModeSuggestion, type Transcription, type TranscribeMode, type TranscribeSettings } from '@core/audio/transcribe';
import type { ChannelId, ClipId, InstrumentChannel, Project, SampleId } from '@core/model/types';
import { writeTranscription, type TranscriptionWritten } from '@core/ops/transcribe';
import { instrumentChannelFor } from '../default-project';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { channelNameFor, SUGGESTED_INSTRUMENT } from './instruments';
import { hear, suggest } from './listening';
import { prepareSource, timelineOfClip, TranscribeError, type Source } from './source';
import { storePads, type StoredPad } from './slices';

export { TranscribeError } from './source';

/** Where the notes go: a new channel (with the plugin it starts with; the mode's suggestion when left out) or one that exists. */
export type TranscribeTarget = { kind: 'new'; plugin?: string } | { kind: 'channel'; channel: ChannelId };

/** Everything one conversion is asked for. */
export interface ConvertSpec {
  clip: ClipId;
  settings: TranscribeSettings;
  target: TranscribeTarget;
  /** Place a pattern clip on the playlist where the audio clip plays (default true). */
  place?: boolean;
  /** Mute the audio clip so only the notes play (default false). */
  muteOriginal?: boolean;
  /** Drums, new channel: cut the recording's own hits into the pads (default true). */
  slicePads?: boolean;
}

/** What a conversion would make: the plan and the clip it is for. */
export interface ClipPlan {
  clip: ClipId;
  transcription: Transcription;
  source: Source;
}

/** What a conversion made, for the toast and the AI's answer. */
export interface ConvertResult {
  notes: number;
  channelId: ChannelId;
  channelName: string;
  patternId: string;
  placed: boolean;
  chords: number;
  pads: number;
  message: string;
}

/** Listens to a clip and plans the notes for it (nothing is written). Throws `TranscribeError`. */
export async function planClip(s: Services, clipId: ClipId, settings: TranscribeSettings): Promise<ClipPlan> {
  const project = s.doc.getState().project;
  const source = await prepareSource(s, project, clipId);
  const heard = await hear(source, settings.mode, settings.sensitivity);
  const transcription = planTranscription(heard, timelineOfClip(project, source.clip, source.channel), settings);
  return { clip: clipId, transcription, source };
}

/** The mode that fits the clip's sound. Throws `TranscribeError`. */
export async function suggestForClip(s: Services, clipId: ClipId): Promise<ModeSuggestion> {
  const source = await prepareSource(s, s.doc.getState().project, clipId);
  return suggest(source);
}

/** The new instrument channel for a conversion: the target's plugin (or the mode's suggestion) with the clip's name. */
function newChannelFor(s: Services, project: Project, mode: TranscribeMode, target: Extract<TranscribeTarget, { kind: 'new' }>, audioName: string, slots: Record<string, SampleId>): InstrumentChannel {
  const pluginId = target.plugin ?? SUGGESTED_INSTRUMENT[mode].pluginId;
  const def = s.plugins.get(pluginId);
  if (!def) throw new TranscribeError(`The instrument “${pluginId}” is not installed.`);
  const channel = instrumentChannelFor(def, channelNameFor(audioName, MODE_LABELS[mode].label), project.channelOrder.length);
  return Object.keys(slots).length ? { ...channel, plugin: { ...channel.plugin, samples: { ...slots } } } : channel;
}

/** The existing channel a target names, checked. */
function existingChannel(project: Project, id: ChannelId): InstrumentChannel {
  const channel = project.channels[id];
  if (channel?.kind !== 'instrument') throw new TranscribeError('Choose an instrument channel to write the notes to (not audio or automation).');
  return channel;
}

/** The plain sentence about what was made. */
function messageOf(result: Omit<ConvertResult, 'message'>, mode: TranscribeMode): string {
  const label = MODE_LABELS[mode].label.toLowerCase();
  const where = result.placed ? ' and placed it on the playlist under the audio' : '';
  const chords = result.chords > 0 ? `, and put ${result.chords} chord${result.chords === 1 ? '' : 's'} on the chord track` : '';
  const pads = result.pads > 0 ? `; ${result.pads} pad${result.pads === 1 ? '' : 's'} play${result.pads === 1 ? 's' : ''} sounds cut from your recording` : '';
  return `Made a ${label} pattern with ${result.notes} note${result.notes === 1 ? '' : 's'} on “${result.channelName}”${where}${chords}${pads}.`;
}

/**
 * Converts an audio clip to notes and writes them: one undo step. Throws `TranscribeError` (with the reason in plain words)
 * when the clip cannot be converted or nothing was found.
 */
export async function convertToMidi(s: Services, spec: ConvertSpec): Promise<ConvertResult> {
  const plan = await planClip(s, spec.clip, spec.settings);
  const { transcription, source } = plan;
  if (transcription.notes.length === 0) throw new TranscribeError(transcription.summary[0] ?? 'Nothing was found to convert.');
  const project = s.doc.getState().project;
  const mode = spec.settings.mode;
  const wantsPads = mode === 'drums' && spec.target.kind === 'new' && spec.slicePads !== false && transcription.pads.length > 0;
  const stored: StoredPad[] = wantsPads ? await whileBusy(() => storePads(source, transcription.pads, source.channel.name), { project }) : [];
  const slots = Object.fromEntries(stored.map((pad) => [pad.slot, pad.sample.id]));
  const channel = spec.target.kind === 'new' ? newChannelFor(s, project, mode, spec.target, source.channel.name, slots) : existingChannel(project, spec.target.channel);
  const patternName = `${source.channel.name} · ${MODE_LABELS[mode].label}`;
  const place = spec.place !== false;
  let made: TranscriptionWritten | null = null as TranscriptionWritten | null;
  const committed = s.history.transact(`Convert to MIDI: ${MODE_LABELS[mode].label}`, (draft) => {
    made = writeTranscription(draft, {
      audioClipId: spec.clip,
      notes: transcription.notes,
      channel: spec.target.kind === 'new' ? { kind: 'new', channel } : { kind: 'existing', id: channel.id },
      patternName,
      slices: stored,
      placeOnPlaylist: place,
      muteOriginal: spec.muteOriginal === true,
      chords: spec.settings.fillChordTrack ? transcription.chords : [],
    });
  });
  const written = made as TranscriptionWritten | null;
  if (!committed || !written) throw new TranscribeError('The notes could not be written: the clip or the channel is gone.');
  s.session.getState().selectChannel(written.channelId);
  s.view.getState().setCurrentPattern(written.patternId);
  const result = {
    notes: written.notes,
    channelId: written.channelId,
    channelName: channel.name,
    patternId: written.patternId,
    placed: written.clipId !== null,
    chords: spec.settings.fillChordTrack ? transcription.chords.length : 0,
    pads: stored.length,
  };
  return { ...result, message: messageOf(result, mode) };
}
