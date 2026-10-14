import type { Services } from '@app/services';
import {
  audioChannelOf,
  audioClipsFor,
  detectSourceBpm,
  formatCents,
  normalizeClips,
  setClipLevels,
  setFollowTempo,
  setPitch,
  setReverse,
  setSourceBpm,
  sliceAtTransients,
} from '@app/actions/audio-clips';
import {
  consolidate,
  consolidationSet,
  freezeChannel,
  frozenCopyOf,
  unfreezeChannel,
} from '@app/actions/render-to-audio';
import { clipGain, dbToGain, formatDb, gainToDb, MAX_CLIP_GAIN } from '@core/audio/envelope';
import { playbackMode, type FollowMode } from '@core/audio/playback';
import type { AudioClip, ChannelId, ClipId } from '@core/model/types';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd, sep, type DynamicMenuEntry } from '../../shell/menus';

const FOLLOW: { mode: FollowMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off: plays at its own speed', hint: 'Tempo changes don’t touch it (pitch changes its speed, like a turntable)' },
  { mode: 'resample', label: 'Resample: speed follows the tempo', hint: 'Faster song = faster and higher, like a turntable; one source beat per song beat' },
  { mode: 'stretch', label: 'Stretch: tempo follows, pitch stays', hint: 'Time-stretched to the song tempo without changing its pitch (computed in the background)' },
];

/** `{ clip }` from a command's args, else the selected audio clips. */
function clipsOf(s: Services, args: unknown): AudioClip[] {
  const id = args && typeof args === 'object' ? (args as { clip?: unknown }).clip : undefined;
  return audioClipsFor(s, typeof id === 'string' ? [id as ClipId] : undefined);
}

function firstClip(s: Services, args: unknown): AudioClip | null {
  const clips = clipsOf(s, args);
  if (clips.length === 0) {
    s.session.getState().toast('Select an audio clip on the playlist first.');
    return null;
  }
  return clips[0] as AudioClip;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

async function pitchDialog(s: Services, clip: AudioClip): Promise<void> {
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
async function sourceTempoDialog(s: Services, channelId: ChannelId, then?: FollowMode): Promise<boolean> {
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

async function followTempo(s: Services, clip: AudioClip, mode: FollowMode, sourceBpm?: number): Promise<void> {
  const ch = audioChannelOf(s.doc.getState().project, clip);
  if (!ch) return;
  if (mode !== 'off' && !sourceBpm && !ch.sourceBpm) {
    await sourceTempoDialog(s, ch.id, mode);
    return;
  }
  setFollowTempo(s, ch.id, mode, sourceBpm);
  if (mode === 'stretch') s.session.getState().setHint('Stretching in the background: it plays in time meanwhile');
}

async function levelsDialog(s: Services, clip: AudioClip): Promise<void> {
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

async function runFreeze(s: Services, channelId: ChannelId): Promise<void> {
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

async function runConsolidate(s: Services): Promise<void> {
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
function freezeTarget(s: Services, args: unknown): ChannelId | null {
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

/** The audio entries of a clip's ▾ menu (and of the Playlist menu for the selection). */
export function audioClipMenu(s: Services, clip: AudioClip): MenuEntry[] {
  const p = s.doc.getState().project;
  const ch = audioChannelOf(p, clip);
  if (!ch) return [];
  const mode = playbackMode(ch);
  const frozen = frozenCopyOf(p, ch.id);
  return [
    {
      label: 'Reverse',
      checked: mode.reverse,
      hint: 'Plays this sound backwards (every clip of it keeps its part of the audio)',
      onSelect: () => setReverse(s, ch.id, !mode.reverse),
    },
    {
      label: `Pitch… (${formatCents(mode.cents)})`,
      hint: 'Shift the pitch in semitones and cents',
      onSelect: () => void pitchDialog(s, clip),
    },
    {
      kind: 'submenu',
      label: `Follow tempo (${mode.follow === 'off' ? 'off' : mode.follow})`,
      hint: 'How it follows the song tempo: not at all, by speeding up (resample), or time-stretched',
      items: [
        ...FOLLOW.map((f) => ({
          label: f.label,
          hint: f.hint,
          checked: mode.follow === f.mode,
          onSelect: () => void followTempo(s, clip, f.mode),
        })),
        { kind: 'separator' as const },
        {
          label: `Source tempo… (${ch.sourceBpm ? `${Math.round(ch.sourceBpm * 100) / 100} BPM` : 'not set'})`,
          hint: 'The tempo the audio was played at (detected from it, or typed)',
          onSelect: () => void sourceTempoDialog(s, ch.id),
        },
      ],
    },
    {
      label: 'Gain and fades…',
      hint: `Exact values: gain now ${formatDb(clipGain(clip))} (or drag the handles along the top of the clip)`,
      onSelect: () => void levelsDialog(s, clip),
    },
    {
      label: 'Normalize',
      hint: 'Sets the clip gain so its loudest moment peaks at −0.3 dB',
      onSelect: () =>
        void normalizeClips(s, audioClipsFor(s).length > 1 ? audioClipsFor(s) : [clip]).then((n) =>
          s.session.getState().setHint(n ? 'Normalized to −0.3 dB' : 'Nothing to normalize (silent)'),
        ),
    },
    {
      label: 'Slice at transients',
      hint: 'Cuts the clip at every hit (drum hits, plucked notes) so each one is its own clip',
      onSelect: () =>
        void sliceAtTransients(s, clip).then((n) =>
          s.session.getState().toast(n > 1 ? `Sliced into ${n} clips.` : 'No hits found to slice at.'),
        ),
    },
    { kind: 'separator' },
    {
      label: s.editor.getState().clipSelection.length > 1 ? 'Consolidate selection' : 'Consolidate this clip',
      hint: 'Renders the selected clips (effects, automation and all) into one new audio clip that replaces them',
      onSelect: () => void runConsolidate(s),
    },
    frozen?.frozenFrom
      ? {
          label: 'Unfreeze',
          hint: 'Deletes the frozen audio and plays the original channel again',
          onSelect: () => void unfreezeChannel(s, ch.id),
        }
      : {
          label: 'Freeze channel…',
          hint: 'Renders this channel to an audio clip and mutes the original (saves processing; Unfreeze undoes it)',
          onSelect: () => void runFreeze(s, ch.id),
        },
  ];
}

/**
 * Audio clip editing: the clip ▾ menu entries (reverse, pitch, follow tempo, gain and fades,
 * normalize, slice, consolidate, freeze), the Playlist menu, the channel rack's Freeze, and a
 * command for each (the AI reaches them through these; they act on the selected audio clips or a
 * `{ clip }` argument).
 */
export function register(services: Services): void {
  const { commands } = services;
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
    run: async (s) => {
      const clip = firstClip(s, undefined);
      if (clip) await levelsDialog(s, clip);
    },
  });
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

  const selectionEntries = (): DynamicMenuEntry[] => {
    const clip = audioClipsFor(services)[0];
    if (!clip) return [{ label: 'Select an audio clip to edit it here', disabled: true, run: () => {} }];
    const toDynamic = (e: MenuEntry): DynamicMenuEntry | null => {
      if (e.kind === 'separator' || e.kind === 'label' || e.kind === 'swatches') return null;
      if (e.kind === 'submenu') {
        const items = typeof e.items === 'function' ? e.items() : e.items;
        return { label: e.label, ...(e.hint ? { hint: e.hint } : {}), run: () => {}, children: items.map(toDynamic).filter((x): x is DynamicMenuEntry => !!x) };
      }
      return { label: e.label, ...(e.hint ? { hint: e.hint } : {}), ...(e.checked ? { checked: true } : {}), ...(e.disabled ? { disabled: true } : {}), run: e.onSelect };
    };
    return audioClipMenu(services, clip).map(toDynamic).filter((x): x is DynamicMenuEntry => !!x);
  };
  addMenuItems('playlist', [
    { kind: 'submenu', id: 'audio-clip', label: 'Audio clip', order: 30, items: () => [{ kind: 'dynamic', id: 'audio-clip-edits', order: 0, entries: selectionEntries }] },
    cmd('playlist.consolidate', 31),
    cmd('channels.freeze', 32),
    sep(39),
  ]);
}
