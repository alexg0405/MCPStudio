/** Sound filters (filter, remove_filter): Nightcore, Slowed + reverb, Telephone, Lo-fi… on a part of the song. */
import { current } from 'immer';
import { FILTERS, findFilter } from '@core/filters/presets';
import {
  clipsTarget,
  markerTarget,
  rangeTarget,
  songTarget,
  targetLabel,
  type FilterTarget,
} from '@core/filters/target';
import type { AudioClipChannel, ClipId, Project } from '@core/model/types';
import { filtersOver, removeSoundFilter } from '@core/ops/filters';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import { num, str } from './values';

const IDS = FILTERS.map((f) => f.id);

/** The part a filter action means: clips, bars, a section, the whole song, else the part asked about, else the whole song. */
function targetOf(action: Record<string, unknown>, context: OpContext, project: Project): FilterTarget {
  const bar = context.bar();
  if (action.whole_song === true) return songTarget(project) ?? fail('the playlist is empty: there is no song to filter yet');
  if (Array.isArray(action.clips) && action.clips.length) {
    const ids = action.clips.map(str).filter((x): x is string => !!x) as ClipId[];
    return clipsTarget(project, ids) ?? fail('none of those clips plays (they are missing, muted or automation)');
  }
  const section = str(action.section);
  if (section) {
    const want = section.toLowerCase();
    const markers = Object.values(project.playlist.markers);
    const m = markers.find((x) => x.name.toLowerCase() === want) ?? markers.find((x) => x.name.toLowerCase().startsWith(want));
    if (!m) fail(`there is no marker “${section}” (sections are the spans between markers)`);
    return markerTarget(project, m!.id) ?? fail(`“${section}” has no section`);
  }
  const fromBar = num(action.from_bar);
  if (fromBar !== undefined) {
    const first = Math.max(1, Math.round(fromBar));
    const last = Math.max(first, Math.round(num(action.to_bar) ?? first));
    return rangeTarget(project, (first - 1) * bar, last * bar) ?? fail('that span of bars is empty');
  }
  const part = context.focus.range();
  if (part) return rangeTarget(project, part.from, part.to) ?? fail('the part asked about is empty');
  return songTarget(project) ?? fail('the playlist is empty: there is no song to filter yet');
}

export const filters: OpModule = {
  schemas: [
    S.op(
      'filter',
      'Plays a part of the song (or the whole song) through a sound filter: renders it to audio, then speeds it up or slows it down like a record (speed filters: the pitch follows, the part’s tempo changes, the bars stay where they are) or changes its tone. The replaced clips are kept: remove_filter or Undo brings them back. One undo step with the answer.',
      {
        filter: { type: 'string', enum: IDS, description: FILTERS.map((f) => `${f.id}: ${f.description}`).join('; ') },
        from_bar: S.int('1-based first bar of the part (with to_bar).'),
        to_bar: S.int('1-based last bar of the part (inclusive; default from_bar).'),
        section: S.str('A section by its marker name ("Chorus"), instead of bars.'),
        clips: { type: 'array', items: { type: 'string' }, description: 'Clip ids (clip_…): only these clips (tone filters; a speed filter takes every track over them).' },
        whole_song: S.bool('The whole song.'),
      },
      ['filter'],
    ),
    S.op(
      'remove_filter',
      'Removes a sound filter: its audio goes and the clips it replaced play again. One undo step.',
      {
        clip: S.str('The filtered audio clip (clip_…), or leave out and give bar.'),
        bar: S.int('A 1-based bar inside the filtered part.'),
      },
    ),
  ],
  prompt: {
    id: 'filters',
    order: 24,
    text: `Sound filters (filter, remove_filter):
- "Nightcore it", "make it slowed + reverb", "sped up version", "daycore", "chipmunk": a speed filter (nightcore, sped-up, slowed, slowed-reverb, daycore, chipmunk) on the whole song (whole_song: true) unless a part is named. It plays faster and higher (or slower and lower) like a record; the part's tempo changes and the bars stay where they are, so the song gets shorter or longer.
- "Make the chorus sound like a phone call", "muffle bars 9–16", "lo-fi the intro", "8-bit", "dreamy", "wider", "mono", "backwards": a tone filter (telephone, radio, underwater, lofi, vinyl, 8-bit, dreamy, wide, mono, reverse) on that part: section with the marker name, or from_bar and to_bar, or clips for single clips.
- The filter renders the part to audio (like consolidate), so edit the notes before filtering. Its effects sit on a mixer track named after the filter: tweak them there when asked ("less reverb on the slowed part"). Never build these effects by hand when a filter fits.
- remove_filter (with the filtered clip, or a bar inside it) puts the original clips back.`,
  },
  handlers: {
    filter: (action, context) => {
      const f = findFilter(str(action.filter) ?? '') ?? fail(`filter must be one of ${IDS.join(', ')}`);
      const project = current(context.draft) as Project;
      const target = targetOf(action, context, project);
      context.state.after.push({ kind: 'filter', filter: f.id, target });
      context.touch(target.from, target.to);
      return `${f.name} on ${targetLabel(project, target)} (rendered after the answer)`;
    },
    remove_filter: (action, context) => {
      const project = current(context.draft) as Project;
      const clipId = str(action.clip);
      const bar = num(action.bar);
      const filtered = Object.values(project.channels).filter((x): x is AudioClipChannel => x.kind === 'audioClip' && !!x.filter);
      const clip = clipId ? project.playlist.clips[clipId as ClipId] : undefined;
      const tick = bar !== undefined ? (Math.round(bar) - 1) * context.bar() : null;
      const channel =
        filtered.find((x) => clip?.kind === 'audio' && clip.channelId === x.id) ??
        filtered.find((x) => tick !== null && x.filter!.from <= tick && tick < x.filter!.to) ??
        (clipId === undefined && tick === null && filtered.length === 1 ? filtered[0] : undefined);
      if (!channel?.filter) return fail('no filtered part there (give the filtered clip or a bar inside it)');
      const over = filtersOver(project, channel.id);
      if (over.length) fail(`“${over[0]!.name}” was made over it later: remove that filter first`);
      const { from, to } = channel.filter;
      removeSoundFilter(context.draft, channel.id);
      context.touch(from, to);
      return `Removed ${channel.name}: the original clips play again`;
    },
  },
};
