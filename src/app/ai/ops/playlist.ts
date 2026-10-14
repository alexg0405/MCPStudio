/** The playlist: placing patterns, audio clip edits, markers, clearing. */
import type { Draft } from 'immer';
import { newId } from '@core/model/ids';
import type { AudioClip, Clip, ClipId, MarkerId, PatternClip } from '@core/model/types';
import { setAudioClipEdits } from '@core/ops/audio-edits';
import { addMarker, moveMarker, removeMarker, renameMarker } from '@core/ops/markers';
import { addClips, removeClips } from '@core/ops/playlist';
import { patternLength } from '@core/query/queries';
import { dbToGain } from '@agstudio/sdk';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { lower, num, r2, str } from './values';

export const playlist: OpModule = {
  schemas: [
    S.op(
      'place_pattern',
      'Places a pattern on the playlist (song mode).',
      {
        pattern: S.PATTERN,
        bar: S.int('1-based bar where it starts.'),
        track: S.int('1-based playlist track (default: the first free track there).'),
        bars: S.num('Clip length in bars (default: the pattern length).'),
        times: S.int('Place it this many times back to back (default 1).'),
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
      track: S.int('1-based playlist track.'),
    }),
  ],
  handlers: {
    place_pattern: (a, c) => {
      const { d } = c;
      const bar = c.bar;
      const pid = c.pattern(a.pattern);
      const barNo = Math.max(1, Math.round(num(a.bar) ?? 1));
      const length = Math.max(
        1,
        Math.round((num(a.bars) ?? patternLength({ ...d.patterns[pid]! }, d.transport.timeSig) / bar()) * bar()),
      );
      const times = Math.max(1, Math.min(64, Math.round(num(a.times) ?? 1)));
      const start = (barNo - 1) * bar();
      const end = start + length * times;
      c.focus.span(start, end, 'place pattern');
      let laneId = d.playlist.laneOrder[Math.round((num(a.track) ?? 0) - 1)];
      if (!laneId) {
        const busy = (lane: string) =>
          Object.values(d.playlist.clips).some((x) => x.laneId === lane && x.start < end && x.start + x.length > start);
        laneId = d.playlist.laneOrder.find((l) => !busy(l)) ?? d.playlist.laneOrder[0];
      }
      if (!laneId) fail('the playlist has no tracks');
      const clips: Clip[] = [];
      for (let i = 0; i < times; i++) {
        const clip: PatternClip = {
          kind: 'pattern',
          id: newId.clip(),
          laneId: laneId!,
          start: start + i * length,
          length,
          patternId: pid,
          offset: 0,
        };
        clips.push(clip);
      }
      addClips(d, clips);
      c.touch(start, end, clips.map((x) => x.id));
      c.state.after.push({ kind: 'mode', mode: 'song' });
      const lane = d.playlist.laneOrder.indexOf(laneId!) + 1;
      return `Placed “${d.patterns[pid]!.name}” on track ${lane} at bar ${barNo}${times > 1 ? ` ×${times}` : ''}`;
    },

    edit_audio_clip: (a, c) => {
      const { d } = c;
      const id = (str(a.clip) ?? fail('which audio clip?')) as ClipId;
      const clip = d.playlist.clips[id];
      if (clip?.kind !== 'audio') fail(`there is no audio clip "${id}"`);
      c.focus.clip(id, 'edit audio clip');
      const gain = num(a.gain_db);
      const fadeIn = num(a.fade_in);
      const fadeOut = num(a.fade_out);
      setAudioClipEdits(d, id, {
        ...(gain !== undefined ? { gain: gain <= -60 ? 0 : dbToGain(Math.min(12, gain)) } : {}),
        ...(fadeIn !== undefined ? { fadeIn } : {}),
        ...(fadeOut !== undefined ? { fadeOut } : {}),
      });
      const after = d.playlist.clips[id] as Draft<AudioClip>;
      const name = d.channels[after.channelId]?.name ?? 'audio';
      const out = [
        gain !== undefined ? `gain ${r2(gain)} dB` : '',
        fadeIn !== undefined ? `fade-in ${Math.round((after.fadeIn ?? 0) * 1000)} ms` : '',
        fadeOut !== undefined ? `fade-out ${Math.round((after.fadeOut ?? 0) * 1000)} ms` : '',
      ].filter(Boolean);
      return `Audio clip “${name}”: ${out.join(', ') || 'unchanged'}`;
    },

    marker: (a, c) => {
      const { d } = c;
      const action = str(a.action);
      const barT = c.bar();
      const at = num(a.bar);
      const tick = at !== undefined ? Math.max(0, Math.round((at - 1) * barT)) : undefined;
      const find = (): MarkerId => {
        const ref = str(a.marker) ?? fail('which marker?');
        if (d.playlist.markers[ref as MarkerId]) return ref as MarkerId;
        const hit = Object.values(d.playlist.markers).find((m) => lower(m.name) === lower(ref));
        return (hit?.id ?? fail(`there is no marker "${ref}"`)) as MarkerId;
      };
      const color = str(a.color);
      const okColor = color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
      if (action === 'add') {
        const name = str(a.name) ?? 'Marker';
        addMarker(d, tick ?? 0, name, okColor ? { color: okColor } : {});
        return `Marker “${name}” at bar ${r2((tick ?? 0) / barT + 1)}`;
      }
      if (action === 'edit') {
        const id = find();
        const name = str(a.name);
        if (name) renameMarker(d, id, name);
        if (tick !== undefined) moveMarker(d, id, tick);
        if (okColor) d.playlist.markers[id]!.color = okColor;
        const m = d.playlist.markers[id]!;
        return `Marker “${m.name}” at bar ${r2(m.tick / barT + 1)}`;
      }
      if (action === 'remove') {
        const id = find();
        const name = d.playlist.markers[id]!.name;
        removeMarker(d, id);
        return `Removed the marker “${name}”`;
      }
      return fail(`unknown marker action "${String(a.action)}"`);
    },

    clear_playlist: (a, c) => {
      const { d } = c;
      const bar = c.bar;
      const part = c.focus.range();
      const from = num(a.from_bar);
      const to = num(a.to_bar);
      const t0 = from !== undefined ? (from - 1) * bar() : (part?.from ?? -Infinity);
      const t1 = to !== undefined ? to * bar() : (part?.to ?? Infinity);
      const laneId = num(a.track) !== undefined ? d.playlist.laneOrder[Math.round(num(a.track)! - 1)] : undefined;
      const ids = Object.values(d.playlist.clips)
        .filter((x) => x.start < t1 && x.start + x.length > t0 && (!laneId || x.laneId === laneId))
        .map((x) => x.id);
      removeClips(d, ids);
      return `Removed ${ids.length} playlist clip${ids.length === 1 ? '' : 's'}`;
    },
  },
};
