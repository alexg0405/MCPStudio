/** The playlist: placing patterns, audio clip edits, markers, clearing. */
import type { Draft } from 'immer';
import { newId } from '@core/model/ids';
import { tempoMapOf } from '@core/automation/tempo';
import type { AudioClip, Clip, ClipId, LaneId, MarkerId, PatternClip, Tick } from '@core/model/types';
import { setAudioClipEdits } from '@core/ops/audio-edits';
import { addMarker, moveMarker, removeMarker, renameMarker } from '@core/ops/markers';
import { addClips, clearRange, removeClips } from '@core/ops/playlist';
import { stackedCopies } from '@core/query/arrangement';
import { patternLength } from '@core/query/queries';
import { barSpan } from '@core/time/bars';
import { dbToGain } from '@agstudio/sdk';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { bool, lower, num, r2, str } from './values';

export const playlist: OpModule = {
  schemas: [
    S.op(
      'place_pattern',
      'Places a pattern on the playlist (song mode).',
      {
        pattern: S.PATTERN,
        bar: S.int('1-based bar where it starts.'),
        track: S.int('1-based playlist track (it must exist; default: the first free track there).'),
        bars: S.num('Clip length in bars (default: the pattern length).'),
        times: S.int('Place it this many times back to back (default 1).'),
        replace: S.bool('With track: first clear that track where the new clips go (clips reaching past are trimmed).'),
      },
      ['pattern', 'bar'],
    ),
    S.op(
      'edit_audio_clip',
      'Changes one audio clip on the playlist (ids are in the playlist listing): its gain and fades.',
      {
        clip: S.str('The clip id (clip_…).'),
        gain_db: S.num('Clip gain in dB (−60…+12; 0 = as recorded).'),
        fade_in: S.num('Fade-in length in seconds (0 = none).'),
        fade_out: S.num('Fade-out length in seconds (0 = none).'),
      },
      ['clip'],
    ),
    S.op(
      'marker',
      'Adds, renames, moves or removes a playlist marker (a named song position like "Verse" or "Drop").',
      {
        action: { type: 'string', enum: ['add', 'edit', 'remove'] },
        marker: S.str('edit/remove: the marker’s id (mk_…) or exact name.'),
        name: S.str('add/edit: its name.'),
        bar: S.num('add/edit: the 1-based bar it sits at (fractions allowed).'),
        color: S.str('Hex color.'),
      },
      ['action'],
    ),
    S.op('clear_playlist', 'Removes playlist clips (all, or those overlapping the bars / on the track given).', {
      from_bar: S.int('1-based first bar.'),
      to_bar: S.int('1-based last bar (inclusive).'),
      track: S.int('1-based playlist track (it must exist).'),
      trim: S.bool('Cut clips that reach past the bars at the edges and keep their outside parts (default: remove every clip that touches the bars).'),
    }),
  ],
  handlers: {
    place_pattern: (action, context) => {
      const { draft } = context;
      const bar = context.bar;
      const patternId = context.pattern(action.pattern);
      const barNo = Math.max(1, Math.round(num(action.bar) ?? 1));
      const length = Math.max(
        1,
        Math.round((num(action.bars) ?? patternLength({ ...draft.patterns[patternId]! }, draft.transport.timeSig) / bar()) * bar()),
      );
      const times = Math.max(1, Math.min(64, Math.round(num(action.times) ?? 1)));
      const start = (barNo - 1) * bar();
      const end = start + length * times;
      context.focus.span(start, end, 'place pattern');
      let laneId: LaneId | undefined = action.track !== undefined ? context.lane(action.track) : undefined;
      if (laneId && draft.playlist.lanes[laneId]?.takes)
        fail(`track ${action.track} belongs to a recording's takes and holds only that recording: pick another track`);
      if (bool(action.replace)) {
        if (!laneId) fail('replace needs the track to clear');
        clearRange(draft, start, end, {
          lanes: new Set([laneId!]),
          trim: true,
          tempo: tempoMapOf(context.base, 'song'),
          only: context.focus.clearable,
        });
      }
      if (!laneId) {
        const busy = (lane: string) =>
          Object.values(draft.playlist.clips).some((x) => x.laneId === lane && x.start < end && x.start + x.length > start);
        const ordinary = draft.playlist.laneOrder.filter((l) => !draft.playlist.lanes[l]?.takes);
        laneId = ordinary.find((l) => !busy(l)) ?? ordinary[0];
      }
      if (!laneId) fail('the playlist has no tracks');
      // The same pattern already playing at that time (on any track) would play twice as loud: skip those.
      const playing = Object.values(draft.playlist.clips).filter((x) => x.kind === 'pattern' && x.patternId === patternId && !x.muted);
      const clips: Clip[] = [];
      const skipped: { from: Tick; to: Tick }[] = [];
      for (let i = 0; i < times; i++) {
        const at = start + i * length;
        if (playing.some((x) => x.start < at + length && x.start + x.length > at)) {
          const last = skipped[skipped.length - 1];
          if (last && last.to === at) last.to = at + length;
          else skipped.push({ from: at, to: at + length });
          continue;
        }
        const clip: PatternClip = {
          kind: 'pattern',
          id: newId.clip(),
          laneId: laneId!,
          start: at,
          length,
          patternId: patternId,
          offset: 0,
        };
        clips.push(clip);
      }
      const name = draft.patterns[patternId]!.name;
      const where = skipped.map((x) => barSpan(x.from, x.to, draft.transport.timeSig)).join(', ');
      if (clips.length === 0) fail(`“${name}” already plays at ${where}, so nothing was added (it would play twice)`);
      addClips(draft, clips);
      context.touch(start, end, clips.map((x) => x.id));
      context.state.after.push({ kind: 'mode', mode: 'song' });
      const lane = draft.playlist.laneOrder.indexOf(laneId!) + 1;
      return `Placed “${name}” on track ${lane} at bar ${barNo}${times > 1 ? ` ×${clips.length}` : ''}${
        skipped.length ? ` (skipped ${where}: it already plays there)` : ''
      }`;
    },

    edit_audio_clip: (action, context) => {
      const { draft } = context;
      const id = (str(action.clip) ?? fail('which audio clip?')) as ClipId;
      const clip = draft.playlist.clips[id];
      if (clip?.kind !== 'audio') fail(`there is no audio clip "${id}"`);
      context.focus.clip(id, 'edit audio clip');
      const gain = num(action.gain_db);
      const fadeIn = num(action.fade_in);
      const fadeOut = num(action.fade_out);
      setAudioClipEdits(draft, id, {
        ...(gain !== undefined ? { gain: gain <= -60 ? 0 : dbToGain(Math.min(12, gain)) } : {}),
        ...(fadeIn !== undefined ? { fadeIn } : {}),
        ...(fadeOut !== undefined ? { fadeOut } : {}),
      });
      const after = draft.playlist.clips[id] as Draft<AudioClip>;
      const name = draft.channels[after.channelId]?.name ?? 'audio';
      const out = [
        gain !== undefined ? `gain ${r2(gain)} dB` : '',
        fadeIn !== undefined ? `fade-in ${Math.round((after.fadeIn ?? 0) * 1000)} ms` : '',
        fadeOut !== undefined ? `fade-out ${Math.round((after.fadeOut ?? 0) * 1000)} ms` : '',
      ].filter(Boolean);
      return `Audio clip “${name}”: ${out.join(', ') || 'unchanged'}`;
    },

    marker: (action, context) => {
      const { draft } = context;
      const subAction = str(action.action);
      const barT = context.bar();
      const at = num(action.bar);
      const tick = at !== undefined ? Math.max(0, Math.round((at - 1) * barT)) : undefined;
      const find = (): MarkerId => {
        const ref = str(action.marker) ?? fail('which marker?');
        if (draft.playlist.markers[ref as MarkerId]) return ref as MarkerId;
        const hit = Object.values(draft.playlist.markers).find((m) => lower(m.name) === lower(ref));
        return (hit?.id ?? fail(`there is no marker "${ref}"`)) as MarkerId;
      };
      const color = str(action.color);
      const okColor = color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
      if (subAction === 'add') {
        const name = str(action.name) ?? 'Marker';
        addMarker(draft, tick ?? 0, name, okColor ? { color: okColor } : {});
        return `Marker “${name}” at bar ${r2((tick ?? 0) / barT + 1)}`;
      }
      if (subAction === 'edit') {
        const id = find();
        const name = str(action.name);
        if (name) renameMarker(draft, id, name);
        if (tick !== undefined) moveMarker(draft, id, tick);
        if (okColor) draft.playlist.markers[id]!.color = okColor;
        const m = draft.playlist.markers[id]!;
        return `Marker “${m.name}” at bar ${r2(m.tick / barT + 1)}`;
      }
      if (subAction === 'remove') {
        const id = find();
        const name = draft.playlist.markers[id]!.name;
        removeMarker(draft, id);
        return `Removed the marker “${name}”`;
      }
      return fail(`unknown marker action "${String(action.action)}"`);
    },

    clear_playlist: (action, context) => {
      const { draft } = context;
      const bar = context.bar;
      const part = context.focus.range();
      const from = num(action.from_bar);
      const to = num(action.to_bar);
      const t0 = from !== undefined ? (from - 1) * bar() : (part?.from ?? -Infinity);
      const t1 = to !== undefined ? to * bar() : (part?.to ?? Infinity);
      const laneId = action.track !== undefined ? context.lane(action.track) : undefined;
      // Inside a part of the song, clips reaching past it are always trimmed (their outside stays).
      const trim = part ? true : (bool(action.trim) ?? false);
      // (Without a focus this passes; with selected notes the playlist stays as it is.)
      context.focus.span(Math.max(0, t0), t1, 'clear playlist');
      if (trim && Number.isFinite(t0) && Number.isFinite(t1)) {
        const res = clearRange(draft, t0, t1, {
          ...(laneId ? { lanes: new Set([laneId]) } : {}),
          trim: true,
          tempo: tempoMapOf(context.base, 'song'),
          only: context.focus.clearable,
        });
        context.touch(t0, t1);
        return `Removed ${res.removed} playlist clip${res.removed === 1 ? '' : 's'}${res.cut ? ` (${res.cut} cut at the edges)` : ''}`;
      }
      const ids = Object.values(draft.playlist.clips)
        .filter(
          (x) => x.start < t1 && x.start + x.length > t0 && (!laneId || x.laneId === laneId) && context.focus.clearable(x as Clip),
        )
        .map((x) => x.id);
      removeClips(draft, ids);
      if (Number.isFinite(t0) && Number.isFinite(t1)) context.touch(t0, t1);
      return `Removed ${ids.length} playlist clip${ids.length === 1 ? '' : 's'}`;
    },
  },
  // A safety net: clips this answer added on top of the same clips (any track) would play twice.
  beforeCommit: (context) => {
    const copies = stackedCopies(context.project, context.state.clips);
    if (!copies.length) return;
    removeClips(
      context.draft,
      copies.map((x) => x.clipId),
    );
    const timeSig = context.draft.transport.timeSig;
    const span = barSpan(Math.min(...copies.map((x) => x.from)), Math.max(...copies.map((x) => x.to)), timeSig);
    context.note(`Removed ${copies.length} clip${copies.length === 1 ? '' : 's'} that doubled what already plays (${span})`);
  },
};
