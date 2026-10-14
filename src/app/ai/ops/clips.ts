/** One clip at a time (mute, move, length, split, its own copy, remove), track names, and cleaning up the song. */
import { tempoMapOf } from '@core/automation/tempo';
import { newId } from '@core/model/ids';
import type { Clip, PatternId, Project } from '@core/model/types';
import { editClips, makeClipUnique, removeClips, setLaneProps, splitClip } from '@core/ops/playlist';
import { tidySong } from '@core/ops/tidy';
import { barOf } from '@core/time/bars';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { bool, lower, num, str } from './values';

const clipName = (p: Project, clip: Clip): string =>
  clip.kind === 'pattern'
    ? `“${p.patterns[clip.patternId]?.name ?? 'pattern'}”`
    : `${clip.kind} “${p.channels[clip.channelId]?.name ?? '?'}”`;

export const clips: OpModule = {
  schemas: [
    S.op(
      'clip',
      'Changes one clip on the playlist, found by its id or by track + bar (the clip playing there): edit (mute, move, length), split it at a bar, make_unique (gives a pattern clip its own copy of the pattern, so editing the copy changes only this spot), or remove it.',
      {
        action: { type: 'string', enum: ['edit', 'split', 'make_unique', 'remove'] },
        clip: S.str('The clip id (clip_…), when the listing shows it.'),
        track: S.int('With bar: the 1-based track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays (fractions allowed).'),
        mute: S.bool('edit: mute or unmute it.'),
        to_track: S.int('edit: move it to this track.'),
        to_bar: S.num('edit: move its start to this bar.'),
        bars: S.num('edit: its new length in bars (shorter cuts its end; longer loops a pattern clip).'),
        at_bar: S.num('split: where to split it, as a bar (fractions allowed: 12.5 is halfway through bar 12).'),
        ref: { ...S.REF, description: 'make_unique: a name for the copy in later actions, e.g. "@fill".' },
        name: S.str('make_unique: the copy’s name (default: the pattern’s name and the bar).'),
      },
      ['action'],
    ),
    S.op(
      'track',
      'Names, colors, mutes or solos a playlist track (a row of the playlist). Name tracks after what they play ("Drums", "808", "Chords", "FX").',
      {
        track: S.int('1-based track.'),
        name: S.str('New name.'),
        color: S.str('Hex color.'),
        mute: S.bool('Mute it.'),
        solo: S.bool('Solo it.'),
      },
      ['track'],
    ),
    S.op(
      'tidy',
      'Cleans up the arrangement: removes clips stacked on themselves (the same part playing 2–3 times at once, much too loud), merges automation channels that are the same curve on the same control, and names tracks after the one thing they play.',
      {
        stacked: S.bool('Remove stacked copies (default true).'),
        automation: S.bool('Merge same-curve automation (default true).'),
        names: S.bool('Name tracks (default true).'),
      },
    ),
  ],
  prompt: {
    id: 'playlist',
    order: 15,
    text: `Playlist editing: bars are 1-based and the ranges in the project are inclusive ("bars 81–112" is 32 bars); a run like “Drop” ×8 is that many clips back to back. place_pattern skips clips that would play a pattern on top of itself (it would play twice as loud); replace: true clears the track there first. The clip action changes one clip, by id or by track + bar: mute, move, shorten, split, make_unique (to change one spot of a repeated pattern without touching the others), remove. Name tracks with the track action. When the project's song check reports stacked copies or repeated automation, fix them with tidy.`,
  },
  handlers: {
    clip: (a, c) => {
      const { d } = c;
      const clip = c.clip(a);
      const what = clipName(c.project, clip);
      const ts = d.transport.timeSig;
      const barT = c.bar();
      const at = `track ${d.playlist.laneOrder.indexOf(clip.laneId) + 1}, bar ${barOf(clip.start, ts)}`;
      switch (str(a.action)) {
        case 'edit': {
          c.focus.clip(clip.id, 'clip');
          const out: string[] = [];
          const mute = bool(a.mute);
          const toTrack = a.to_track !== undefined ? c.lane(a.to_track) : undefined;
          const toBar = num(a.to_bar);
          const bars = num(a.bars);
          const start = toBar !== undefined ? Math.max(0, Math.round((toBar - 1) * barT)) : clip.start;
          const length = bars !== undefined && bars > 0 ? Math.max(1, Math.round(bars * barT)) : clip.length;
          if (toBar !== undefined || bars !== undefined) c.focus.span(start, start + length, 'clip');
          editClips(d, [
            {
              id: clip.id,
              ...(mute !== undefined ? { muted: mute } : {}),
              ...(toTrack ? { laneId: toTrack } : {}),
              ...(toBar !== undefined ? { start } : {}),
              ...(bars !== undefined && bars > 0 ? { length } : {}),
            },
          ]);
          if (mute !== undefined) out.push(mute ? 'muted' : 'unmuted');
          if (toTrack) out.push(`to track ${d.playlist.laneOrder.indexOf(toTrack) + 1}`);
          if (toBar !== undefined) out.push(`starts at bar ${barOf(start, ts)}`);
          if (bars !== undefined && bars > 0) out.push(`${Math.round((length / barT) * 100) / 100} bars long`);
          c.touch(Math.min(clip.start, start), Math.max(clip.start + clip.length, start + length), [clip.id]);
          return out.length ? `${what} (${at}): ${out.join(', ')}` : null;
        }
        case 'split': {
          c.focus.clip(clip.id, 'clip');
          const where = num(a.at_bar) ?? fail('split needs at_bar');
          const tick = Math.round((where - 1) * barT);
          if (tick <= clip.start || tick >= clip.start + clip.length)
            fail(`bar ${where} isn't inside that clip (it plays from bar ${barOf(clip.start, ts)} to ${barOf(clip.start + clip.length, ts)})`);
          const right = newId.clip();
          splitClip(d, clip.id, tick, tempoMapOf(c.base, 'song'), right);
          c.touch(clip.start, clip.start + clip.length, [clip.id, right]);
          return `Split ${what} (${at}) at bar ${barOf(tick, ts)}`;
        }
        case 'make_unique': {
          if (clip.kind !== 'pattern') return fail('only pattern clips can get their own copy');
          c.focus.clip(clip.id, 'clip');
          const source = d.patterns[clip.patternId]!;
          let name = str(a.name) ?? `${source.name} (bar ${barOf(clip.start, ts)})`;
          const names = new Set(Object.values(d.patterns).map((x) => lower(x.name)));
          for (let n = 2; names.has(lower(name)); n++) name = `${str(a.name) ?? source.name} ${n}`;
          const copy = newId.pattern() as PatternId;
          makeClipUnique(d, clip.id, copy, name);
          c.remember(a.ref, { kind: 'pattern', id: copy });
          c.touch(clip.start, clip.start + clip.length, [clip.id]);
          return `${what} (${at}) now plays its own copy, “${name}”`;
        }
        case 'remove':
          c.focus.clip(clip.id, 'clip');
          removeClips(d, [clip.id]);
          c.touch(clip.start, clip.start + clip.length);
          return `Removed ${what} (${at})`;
        default:
          return fail(`unknown clip action "${String(a.action)}"`);
      }
    },

    track: (a, c) => {
      const laneId = c.lane(a.track);
      const out: string[] = [];
      const name = str(a.name);
      const color = str(a.color);
      const mute = bool(a.mute);
      const solo = bool(a.solo);
      setLaneProps(c.d, laneId, {
        ...(name ? { name } : {}),
        ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}),
        ...(mute !== undefined ? { muted: mute } : {}),
        ...(solo !== undefined ? { solo } : {}),
      });
      if (name) out.push(`named “${c.d.playlist.lanes[laneId]!.name}”`);
      if (mute !== undefined) out.push(mute ? 'muted' : 'unmuted');
      if (solo !== undefined) out.push(solo ? 'solo' : 'unsolo');
      return out.length ? `Track ${c.d.playlist.laneOrder.indexOf(laneId) + 1}: ${out.join(', ')}` : null;
    },

    tidy: (a, c) => {
      // In a part of the song, only its stacked copies (the rest of the clean-up is song-wide).
      const part = c.focus.range();
      const report = tidySong(c.d, {
        stacked: bool(a.stacked) ?? true,
        automation: part ? false : (bool(a.automation) ?? true),
        names: part ? false : (bool(a.names) ?? true),
        ...(part ? { range: part } : {}),
      });
      const out = [
        report.stacked ? `removed ${report.stacked} stacked cop${report.stacked === 1 ? 'y' : 'ies'}` : '',
        report.automation ? `merged ${report.automation} repeated automation channel${report.automation === 1 ? '' : 's'}` : '',
        report.named.length ? `named ${report.named.length} track${report.named.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      return out.length ? `Cleaned up the song: ${out.join(', ')}` : 'The song had nothing to clean up';
    },
  },
};
