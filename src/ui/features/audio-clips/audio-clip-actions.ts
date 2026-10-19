/** What the audio clip commands and menus do: find the clips, ask for values in dialogs, freeze and consolidate. */
import type { Services } from '@app/services';
import { audioChannelOf, audioClipsFor, detectSourceBpm, setClipLevels, setFollowTempo, setPitch, setSourceBpm } from '@app/actions/audio-clips';
import { consolidate, consolidationSet, freezeChannel } from '@app/actions/render-to-audio';
import { clipGain, dbToGain, gainToDb } from '@core/audio/envelope';
import { playbackMode, type FollowMode } from '@core/audio/playback';
import type { AudioClip, ChannelId, ClipId } from '@core/model/types';
import { showFormDialog } from '../../controls/FormDialog';

/** `{ clip }` from a command's args, else the selected audio clips. */
export function clipsOf(s: Services, args: unknown): AudioClip[] {
  const id = args && typeof args === 'object' ? (args as { clip?: unknown }).clip : undefined;
  return audioClipsFor(s, typeof id === 'string' ? [id as ClipId] : undefined);
}

/** The first clip a command acts on, or a toast asking to select one (null) when there is none. */
export function firstClip(s: Services, args: unknown): AudioClip | null {
  const clips = clipsOf(s, args);
  if (clips.length === 0) {
    s.session.getState().toast('Select an audio clip on the playlist first.');
    return null;
  }
  return clips[0] as AudioClip;
}

/** A number from a command argument: a finite number, or a string that holds one; null otherwise. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Asks for semitones and cents to shift the clip's sound by (applies to every clip of the same sound). */
export async function pitchDialog(s: Services, clip: AudioClip): Promise<void> {
  const ch = audioChannelOf(s.doc.getState().project, clip);
  if (!ch) return;
  const cents = ch.pitch ?? 0;
  const values = await showFormDialog({
    title: `Pitch: ${ch.name}`,
    message:
      playbackMode(ch).follow === 'stretch'
        ? 'Shifts the pitch without changing the speed (the clip is time-stretched). Applies to every clip of this sound.'
        : 'Shifts the pitch by playing faster or slower (like a turntable): +12 semitones is twice as fast. Applies to every clip of this sound; set Follow tempo to Stretch to keep the speed.',
    fields: [
      { kind: 'number', key: 'semitones', label: 'Semitones', min: -24, max: 24, step: 1, unit: 'st' },
      { kind: 'number', key: 'cents', label: 'Fine tune', min: -99, max: 99, step: 1, unit: 'cents (1/100 st)' },
    ],
    values: { semitones: Math.trunc(cents / 100), cents: Math.round(cents % 100) },
    okLabel: 'Apply',
  });
  if (values) setPitch(s, ch.id, Number(values.semitones) * 100 + Number(values.cents));
}

/** Asks for the tempo the audio was recorded at (prefilled with what the audio says). */
export async function sourceTempoDialog(s: Services, channelId: ChannelId, then?: FollowMode): Promise<boolean> {
  const p = s.doc.getState().project;
  const ch = p.channels[channelId];
  if (ch?.kind !== 'audioClip') return false;
  const detected = await detectSourceBpm(s, channelId);
  const current = ch.sourceBpm ?? detected ?? p.transport.bpm;
  const values = await showFormDialog({
    title: 'Source tempo',
    message: `The tempo “${ch.name}” was played at, so it can follow the song’s tempo.`,
    fields: [
      { kind: 'number', key: 'bpm', label: 'Tempo', min: 20, max: 999, step: 'any', unit: 'BPM' },
      {
        kind: 'info',
        text: detected
          ? `Detected from the audio: ${detected} BPM. Change it if the beat feels half or double speed.`
          : 'No clear beat found in the audio: type the tempo it was made at.',
      },
    ],
    values: { bpm: Math.round(current * 100) / 100 },
    okLabel: then ? 'Follow the tempo' : 'Set',
  });
  if (!values) return false;
  const bpm = Number(values.bpm);
  if (then) setFollowTempo(s, channelId, then, bpm);
  else setSourceBpm(s, channelId, bpm);
  return true;
}

/** Sets how the sound follows the song tempo; asks for the source tempo first when it is not known yet. */
export async function followTempo(s: Services, clip: AudioClip, mode: FollowMode, sourceBpm?: number): Promise<void> {
  const ch = audioChannelOf(s.doc.getState().project, clip);
  if (!ch) return;
  if (mode !== 'off' && !sourceBpm && !ch.sourceBpm) {
    await sourceTempoDialog(s, ch.id, mode);
    return;
  }
  setFollowTempo(s, ch.id, mode, sourceBpm);
  if (mode === 'stretch') s.session.getState().setHint('Stretching in the background: it plays in time meanwhile');
}

/** Asks for the clip's gain (dB) and fades (ms). */
export async function levelsDialog(s: Services, clip: AudioClip): Promise<void> {
  const values = await showFormDialog({
    title: 'Clip gain and fades',
    message: 'Gain turns this clip up or down; fades bring it in and out smoothly (equal-power curves).',
    fields: [
      { kind: 'number', key: 'gain', label: 'Gain', min: -48, max: 12, step: 0.1, unit: 'dB' },
      { kind: 'number', key: 'fadeIn', label: 'Fade in', min: 0, max: 60000, step: 1, unit: 'ms' },
      { kind: 'number', key: 'fadeOut', label: 'Fade out', min: 0, max: 60000, step: 1, unit: 'ms' },
    ],
    values: {
      gain: Math.round(Math.max(-48, gainToDb(clipGain(clip))) * 10) / 10,
      fadeIn: Math.round((clip.fadeIn ?? 0) * 1000),
      fadeOut: Math.round((clip.fadeOut ?? 0) * 1000),
    },
    okLabel: 'Apply',
  });
  if (!values) return;
  setClipLevels(
    s,
    [clip],
    { gain: dbToGain(Number(values.gain)), fadeIn: Number(values.fadeIn) / 1000, fadeOut: Number(values.fadeOut) / 1000 },
    'Clip gain and fades',
  );
}

/** Freezes a channel to audio (it renders first), with toasts for the start and the result. */
export async function runFreeze(s: Services, channelId: ChannelId): Promise<void> {
  const ch = s.doc.getState().project.channels[channelId];
  s.session.getState().toast(`Rendering “${ch?.name ?? 'channel'}”…`);
  try {
    await freezeChannel(s, channelId);
    s.session
      .getState()
      .toast(`Froze “${ch?.name}”: it plays from an audio clip now and the original is muted (Unfreeze brings it back).`);
  } catch (e) {
    s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** Renders the selected clips (or the loop region) into one audio clip, with toasts for the start and the result. */
export async function runConsolidate(s: Services): Promise<void> {
  const clips = consolidationSet(s);
  if (clips.length === 0) {
    s.session.getState().toast('Select the clips to consolidate (or set a loop region) first.');
    return;
  }
  s.session.getState().toast(`Rendering ${clips.length} clip${clips.length === 1 ? '' : 's'}…`);
  try {
    await consolidate(s, clips);
    s.session.getState().toast('Consolidated into one audio clip (undo brings the clips back).');
  } catch (e) {
    s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** The channel freeze acts on: its args (id or name), the selected audio clip's channel, or the selected channel. */
export function freezeTarget(s: Services, args: unknown): ChannelId | null {
  const p = s.doc.getState().project;
  if (typeof args === 'string' && args) {
    if (p.channels[args as ChannelId]) return args as ChannelId;
    const byName = Object.values(p.channels).find((c) => c.name.toLowerCase() === args.toLowerCase());
    if (byName) return byName.id;
  }
  const clip = audioClipsFor(s)[0];
  if (clip) return clip.channelId;
  return s.session.getState().selectedChannelId;
}

