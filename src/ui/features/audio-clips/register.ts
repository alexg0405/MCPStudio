import type { Services } from '@app/services';
import { audioChannelOf, audioClipsFor, normalizeClips, setClipLevels, setPitch, setReverse, setSourceBpm, sliceAtTransients } from '@app/actions/audio-clips';
import { frozenCopyOf, unfreezeChannel } from '@app/actions/render-to-audio';
import { dbToGain, formatDb, MAX_CLIP_GAIN } from '@core/audio/envelope';
import type { FollowMode } from '@core/audio/playback';
import type { AudioClip } from '@core/model/types';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { audioClipMenu, selectionMenuEntries } from './audio-clip-menu';
import { clipsOf, firstClip, followTempo, freezeTarget, levelsDialog, num, pitchDialog, runConsolidate, runFreeze, sourceTempoDialog } from './audio-clip-actions';

export { audioClipMenu } from './audio-clip-menu';

/**
 * Audio clip editing: the clip ▾ menu entries (reverse, pitch, follow tempo, gain and fades,
 * normalize, slice, consolidate, freeze), the Playlist menu, the channel rack's Freeze, and a
 * command for each (the AI reaches them through these; they act on the selected audio clips or a
 * `{ clip }` argument).
 */
export function register(services: Services): void {
  registerClipCommands(services);
  registerRenderCommands(services);
  registerMenus(services);
}

/** Reverse, pitch, follow tempo, source tempo, gain, fades, normalize, slice and the gain and fades dialog. */
function registerClipCommands({ commands }: Services): void {
  const clipArg = 'optional { clip: id } (default: the selected audio clips)';

  commands.register<{ clip?: string; reverse?: boolean }>({
    id: 'audioClip.reverse',
    title: 'Reverse audio clip',
    category: 'Audio clip',
    hint: 'Play the selected audio clip’s sound backwards (on/off)',
    argsHint: `${clipArg}; { reverse: true | false } sets it instead of toggling`,
    checked: (s) => {
      const c = audioClipsFor(s)[0];
      const ch = c ? audioChannelOf(s.doc.getState().project, c) : null;
      return !!ch?.reverse;
    },
    run: (s, args) => {
      const clip = firstClip(s, args);
      const ch = clip ? audioChannelOf(s.doc.getState().project, clip) : null;
      if (ch) setReverse(s, ch.id, typeof args?.reverse === 'boolean' ? args.reverse : !ch.reverse);
    },
  });
  commands.register<number | { semitones?: number; cents?: number; clip?: string }>({
    id: 'audioClip.pitch',
    title: 'Pitch audio clip…',
    category: 'Audio clip',
    hint: 'Shift the selected audio clip’s pitch in semitones (with tempo follow off it also changes the speed)',
    argsHint: `semitones (e.g. 3 or -12), or { semitones, cents, clip }; without: a dialog`,
    run: async (s, args) => {
      const clip = firstClip(s, args);
      if (!clip) return;
      const ch = audioChannelOf(s.doc.getState().project, clip);
      if (!ch) return;
      const st = typeof args === 'object' ? num(args?.semitones) : num(args);
      const ct = typeof args === 'object' ? (num(args?.cents) ?? 0) : 0;
      if (st === null && ct === 0) await pitchDialog(s, clip);
      else setPitch(s, ch.id, (st ?? 0) * 100 + ct);
    },
  });
  commands.register<FollowMode | { mode?: FollowMode; sourceBpm?: number; clip?: string }>({
    id: 'audioClip.followTempo',
    title: 'Audio clip: follow tempo',
    category: 'Audio clip',
    hint: 'Off: own speed; Resample: speed follows the tempo; Stretch: tempo follows, pitch stays',
    argsHint: "'off' | 'resample' | 'stretch', or { mode, sourceBpm (the tempo it was played at), clip }",
    run: async (s, args) => {
      const clip = firstClip(s, args);
      if (!clip) return;
      const mode = typeof args === 'string' ? args : (args?.mode ?? 'stretch');
      const bpm = typeof args === 'object' ? (num(args?.sourceBpm) ?? undefined) : undefined;
      if (mode === 'off' || mode === 'resample' || mode === 'stretch') await followTempo(s, clip, mode, bpm);
    },
  });
  commands.register<number | { bpm?: number; clip?: string }>({
    id: 'audioClip.sourceTempo',
    title: 'Audio clip: source tempo…',
    category: 'Audio clip',
    hint: 'The tempo the audio was played at (BPM), detected or typed, so it can follow the song tempo',
    argsHint: 'BPM (e.g. 92), or { bpm, clip }; without: a dialog with the detected tempo',
    run: async (s, args) => {
      const clip = firstClip(s, args);
      if (!clip) return;
      const bpm = typeof args === 'object' ? num(args?.bpm) : num(args);
      if (bpm !== null) setSourceBpm(s, clip.channelId, bpm);
      else await sourceTempoDialog(s, clip.channelId);
    },
  });
  commands.register<number | { db?: number; clip?: string }>({
    id: 'audioClip.gain',
    title: 'Audio clip gain',
    category: 'Audio clip',
    hint: 'Turn the selected audio clips up or down, in dB (−48 to +12)',
    argsHint: 'dB (e.g. -3 or 2.5), or { db, clip }',
    run: (s, args) => {
      const db = typeof args === 'object' ? num(args?.db) : num(args);
      const clips = clipsOf(s, args);
      if (db === null || clips.length === 0) return void firstClip(s, args);
      setClipLevels(s, clips, { gain: Math.min(MAX_CLIP_GAIN, dbToGain(Math.max(-48, db))) }, `Clip gain ${formatDb(dbToGain(db))}`);
    },
  });
  commands.register<{ in?: number; out?: number; clip?: string }>({
    id: 'audioClip.fades',
    title: 'Audio clip fades',
    category: 'Audio clip',
    hint: 'Fade the selected audio clips in and out (milliseconds; 0 removes a fade)',
    argsHint: '{ in: ms, out: ms, clip } (either fade may be left out)',
    run: async (s, args) => {
      const clips = clipsOf(s, args);
      if (clips.length === 0) return void firstClip(s, args);
      if (!args || (args.in === undefined && args.out === undefined)) return levelsDialog(s, clips[0] as AudioClip);
      const edits = {
        ...(num(args.in) !== null ? { fadeIn: (num(args.in) as number) / 1000 } : {}),
        ...(num(args.out) !== null ? { fadeOut: (num(args.out) as number) / 1000 } : {}),
      };
      setClipLevels(s, clips, edits, 'Clip fades');
    },
  });
  commands.register<{ clip?: string }>({
    id: 'audioClip.normalize',
    title: 'Normalize audio clip',
    category: 'Audio clip',
    hint: 'Set the clip gain so the loudest moment peaks at −0.3 dB',
    argsHint: clipArg,
    run: async (s, args) => {
      const clips = clipsOf(s, args);
      if (clips.length === 0) return void firstClip(s, args);
      await normalizeClips(s, clips);
    },
  });
  commands.register<{ clip?: string; sensitivity?: number }>({
    id: 'audioClip.sliceAtTransients',
    title: 'Slice audio clip at transients',
    category: 'Audio clip',
    hint: 'Cut the clip at every hit (drum hits, plucked notes) so each one is its own clip',
    argsHint: `${clipArg}; { sensitivity: 0–1 } (higher finds softer hits, default 0.5)`,
    run: async (s, args) => {
      const clip = firstClip(s, args);
      if (!clip) return;
      const sensitivity = num(args?.sensitivity);
      const n = await sliceAtTransients(s, clip, sensitivity === null ? {} : { sensitivity });
      s.session.getState().toast(n > 1 ? `Sliced into ${n} clips.` : 'No hits found to slice at.');
    },
  });
  commands.register({
    id: 'audioClip.levels',
    title: 'Audio clip gain and fades…',
    category: 'Audio clip',
    hint: 'Type exact values for the selected clip’s gain (dB) and fades (ms)',
    // A dialog; edit_audio_clip sets the gain and fades.
    ai: false,
    run: async (s) => {
      const clip = firstClip(s, undefined);
      if (clip) await levelsDialog(s, clip);
    },
  });
}

/** Consolidate, freeze and unfreeze: commands that render to audio. */
function registerRenderCommands({ commands }: Services): void {
  commands.register({
    id: 'playlist.consolidate',
    title: 'Consolidate selection into one audio clip',
    category: 'Playlist',
    hint: 'Renders the selected clips (or the loop region) with their effects and automation into one audio clip that replaces them',
    run: (s) => runConsolidate(s),
  });
  commands.register<string>({
    id: 'channels.freeze',
    title: 'Freeze channel to audio',
    category: 'Channels',
    hint: 'Renders a channel’s part in the song to an audio clip and mutes the original (saves processing; Unfreeze undoes it)',
    argsHint: 'a channel id or name (default: the selected audio clip’s channel, or the selected channel)',
    run: async (s, args) => {
      const id = freezeTarget(s, args);
      if (id) await runFreeze(s, id);
      else s.session.getState().toast('Select a channel to freeze first.');
    },
  });
  commands.register<string>({
    id: 'channels.unfreeze',
    title: 'Unfreeze channel',
    category: 'Channels',
    hint: 'Deletes a frozen channel’s audio and plays the original again',
    argsHint: 'the frozen channel or its original (id or name; default: the selection)',
    run: (s, args) => {
      const id = freezeTarget(s, args);
      if (!id || !unfreezeChannel(s, id)) s.session.getState().toast('That channel isn’t frozen.');
    },
  });
}

/** The clip's right-click menu, the channel rack's Freeze entry and the Playlist menu's Audio clip submenu. */
function registerMenus(services: Services): void {
  addContextMenuItems('playlist.clip', ({ clip }, s) => (clip.kind === 'audio' ? audioClipMenu(s, clip) : []));
  addContextMenuItems('rack.channel', ({ channelId }, s) => {
    const p = s.doc.getState().project;
    const ch = p.channels[channelId];
    if (!ch || ch.kind === 'automation') return [];
    const frozen = frozenCopyOf(p, channelId);
    return frozen
      ? [{ label: 'Unfreeze', hint: 'Plays the original channel again', onSelect: () => void unfreezeChannel(s, channelId) }]
      : [
          {
            label: 'Freeze to audio',
            hint: 'Renders what this channel plays in the song to an audio clip and mutes it (Unfreeze undoes it)',
            onSelect: () => void runFreeze(s, channelId),
          },
        ];
  });
  addMenuItems('playlist', [
    { kind: 'submenu', id: 'audio-clip', label: 'Audio clip', order: 30, items: () => [{ kind: 'dynamic', id: 'audio-clip-edits', order: 0, entries: () => selectionMenuEntries(services) }] },
    cmd('playlist.consolidate', 31),
    cmd('channels.freeze', 32),
    sep(39),
  ]);
}
