/** The audio entries of a clip's ▾ menu, and the same entries for the Playlist menu's Audio clip submenu. */
import type { Services } from '@app/services';
import { audioChannelOf, audioClipsFor, formatCents, normalizeClips, setReverse, sliceAtTransients } from '@app/actions/audio-clips';
import { frozenCopyOf, unfreezeChannel } from '@app/actions/render-to-audio';
import { clipGain, formatDb } from '@core/audio/envelope';
import { playbackMode, type FollowMode } from '@core/audio/playback';
import type { AudioClip } from '@core/model/types';
import type { MenuEntry } from '../../controls/ContextMenu';
import type { DynamicMenuEntry } from '../../shell/menus';
import { followTempo, levelsDialog, pitchDialog, runConsolidate, runFreeze, sourceTempoDialog } from './audio-clip-actions';

const FOLLOW: { mode: FollowMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off: plays at its own speed', hint: 'Tempo changes don’t touch it (pitch changes its speed, like a turntable)' },
  { mode: 'resample', label: 'Resample: speed follows the tempo', hint: 'Faster song = faster and higher, like a turntable; one source beat per song beat' },
  { mode: 'stretch', label: 'Stretch: tempo follows, pitch stays', hint: 'Time-stretched to the song tempo without changing its pitch (computed in the background)' },
];

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

/** A menu entry as the Playlist menu's dynamic entry shape (separators and swatches have no place there and are dropped). */
function toDynamicEntry(entry: MenuEntry): DynamicMenuEntry | null {
  if (entry.kind === 'separator' || entry.kind === 'label' || entry.kind === 'swatches') return null;
  const hint = entry.hint ? { hint: entry.hint } : {};
  if (entry.kind === 'submenu') {
    const items = typeof entry.items === 'function' ? entry.items() : entry.items;
    return { label: entry.label, ...hint, run: () => {}, children: items.map(toDynamicEntry).filter((x): x is DynamicMenuEntry => !!x) };
  }
  return { label: entry.label, ...hint, ...(entry.checked ? { checked: true } : {}), ...(entry.disabled ? { disabled: true } : {}), run: entry.onSelect };
}

/** The Playlist menu's Audio clip entries for the selected clip (a hint to select one when there is none). */
export function selectionMenuEntries(s: Services): DynamicMenuEntry[] {
  const clip = audioClipsFor(s)[0];
  if (!clip) return [{ label: 'Select an audio clip to edit it here', disabled: true, run: () => {} }];
  return audioClipMenu(s, clip).map(toDynamicEntry).filter((x): x is DynamicMenuEntry => !!x);
}
