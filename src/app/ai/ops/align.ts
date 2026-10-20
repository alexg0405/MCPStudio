/**
 * Vocal alignment of recorded audio clips (the Align window's work): line doubles, backing vocals and ad-libs up with a
 * lead (`align_clips`), snap a vocal's syllables to the grid (`tighten_timing`) or take an alignment away
 * (`remove_alignment`). Each is a plain edit of the clips' alignment settings; the aligned audio is made in the
 * background after the edit (a few seconds per minute of audio) and the clip plays it when it is ready.
 */
import { DEFAULT_GRID_STEP_TICKS, GRID_STEPS } from '@core/audio/align/edit';
import { alignProblem, guideProblem } from '@core/audio/align/plan';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { setAlign } from '@core/ops/align';
import { editProblem, guideEdit, gridEdit } from '../../actions/align';
import * as S from '../schema/parts';
import type { AiAction } from '../schema';
import { fail, type OpContext, type OpModule } from './context';
import { num, str } from './values';

/** The audio clips an action names: by `clips` ids, or all audio clips on the 1-based `tracks`; or the single `clip` (id, or track + bar). */
function clipsOf(context: OpContext, action: AiAction, except?: ClipId): AudioClip[] {
  const found = new Map<ClipId, AudioClip>();
  const add = (clip: { kind: string; id: ClipId }) => {
    if (clip.kind === 'audio' && clip.id !== except) found.set(clip.id, clip as AudioClip);
  };
  if (Array.isArray(action.clips)) {
    for (const raw of action.clips) {
      const id = str(raw) ?? fail('clips takes clip ids (clip_…)');
      add(context.project.playlist.clips[id as ClipId] ?? fail(`there is no clip "${id}"`));
    }
  }
  if (Array.isArray(action.tracks)) {
    for (const raw of action.tracks) {
      const lane = context.lane(raw);
      for (const clip of Object.values(context.project.playlist.clips)) if (clip.laneId === lane) add(clip);
    }
  }
  if (found.size === 0 && (action.clip !== undefined || action.track !== undefined)) add(context.clip(action));
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** The grid step in ticks from a name like "1/16" (default 1/16). */
function stepOf(raw: unknown): number {
  const text = str(raw);
  if (!text) return DEFAULT_GRID_STEP_TICKS;
  const hit = GRID_STEPS.find((g) => g.label.startsWith(text.trim()) || text.trim().startsWith(g.label.split(' ')[0] as string));
  return hit ? hit.ticks : fail(`unknown grid "${text}" (${GRID_STEPS.map((g) => g.label.split(' ')[0]).join(', ')})`);
}

/** What happened to each clip, as the change line and warnings: the clips set, and why others were left out. */
function summarize(context: OpContext, done: AudioClip[], skipped: { clip: AudioClip; reason: string }[], what: string): string {
  for (const s of skipped) context.warn(`${s.clip.id}: ${s.reason}`);
  if (done.length === 0) return fail(skipped.length ? skipped.map((s) => s.reason).join('; ') : 'there is no audio clip to work on');
  const names = done.map((c) => (context.project.channels[c.channelId]?.name ?? c.id) as string);
  return `${what} ${names.length === 1 ? `“${names[0]}”` : `${names.length} clips (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})`}`;
}

/**
 * Why a clip cannot take the edit. The committed project answers when it knows the clip (its tempo map is safe to
 * memoize); a clip made earlier in the same answer is only in the draft, where the check that does not need the tempo is used.
 */
function problemOf(context: OpContext, draft: Project, id: ClipId, edit: ReturnType<typeof guideEdit>): string | null {
  if (context.base.playlist.clips[id]) return editProblem(context.base, id, edit);
  return alignProblem(draft, id) ?? (edit.mode === 'guide' ? guideProblem(draft, id, edit.guide) : null);
}

/** Sets an edit on each clip that can take it. */
function applyTo(
  context: OpContext,
  clips: AudioClip[],
  check: (project: Project, id: ClipId) => string | null,
  edit: (id: ClipId) => ReturnType<typeof guideEdit>,
): { done: AudioClip[]; skipped: { clip: AudioClip; reason: string }[] } {
  const done: AudioClip[] = [];
  const skipped: { clip: AudioClip; reason: string }[] = [];
  for (const clip of clips) {
    const reason = check(context.project, clip.id);
    if (reason) skipped.push({ clip, reason });
    else {
      setAlign(context.draft, clip.id, edit(clip.id));
      context.touch(clip.start, clip.start + clip.length, [clip.id]);
      done.push(clip);
    }
  }
  return { done, skipped };
}

export const align: OpModule = {
  schemas: [
    S.op(
      'align_clips',
      'Lines recorded vocal clips (doubles, backing vocals, ad-libs) up with a lead clip, like VocAlign: their syllables move to the lead’s timing (consonants stay sharp, pitch is kept) and, with pitch > 0, their pitch is pulled towards the lead’s pitch contour (a harmony keeps its interval). Give the lead as guide (a clip id) or guide_track (+ guide_bar), and the clips to align as clips (ids) and/or tracks (every audio clip on those 1-based playlist tracks). tightness 0–100: 0 only fixes big offsets, 100 follows syllable by syllable (default 70). pitch 0–100 %: how much of the pitch deviation is corrected (default 0). The aligned audio is made in the background and the original recording is kept; Undo restores it.',
      {
        guide: S.str('The lead: an audio clip id (clip_…).'),
        guide_track: S.int('Instead of guide: the 1-based playlist track the lead is on.'),
        guide_bar: S.num('With guide_track: a 1-based bar where the lead plays (default the start of the song).'),
        clips: { type: 'array', items: { type: 'string' }, description: 'The audio clip ids to align.' },
        tracks: { type: 'array', items: { type: 'integer' }, description: '1-based playlist tracks: every audio clip on them is aligned.' },
        tightness: S.num('0–100 (default 70): 0 = only big offsets, 100 = syllable-tight.'),
        pitch: S.num('0–100 % (default 0): how much of the pitch deviation from the lead is corrected.'),
      },
    ),
    S.op(
      'tighten_timing',
      'Snaps the syllable starts of a recorded vocal clip towards the song grid (a tight performance without cutting it up): each onset moves towards the nearest grid line by strength % (default 80), onsets further than about half a grid step are left alone, consonants stay sharp and the pitch is kept. Give the clip as clip (id, or track + bar), or clips / tracks for several. grid is "1/4", "1/8", "1/16" (default) or "1/32". The audio is made in the background and the original is kept.',
      {
        clip: S.str('An audio clip id (clip_…), or use track + bar.'),
        track: S.int('With bar: the 1-based playlist track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays.'),
        clips: { type: 'array', items: { type: 'string' }, description: 'Several audio clip ids.' },
        tracks: { type: 'array', items: { type: 'integer' }, description: '1-based playlist tracks: every audio clip on them.' },
        strength: S.num('0–100 % (default 80): how far each syllable start moves towards the grid.'),
        grid: S.str('"1/4", "1/8", "1/16" (default) or "1/32".'),
      },
    ),
    S.op(
      'remove_alignment',
      'Takes the vocal alignment (align_clips or tighten_timing) off audio clips: they play their own recording again. Clips by id (clip, or track + bar), clips, or tracks.',
      {
        clip: S.str('An audio clip id (clip_…), or use track + bar.'),
        track: S.int('With bar: the 1-based playlist track the clip is on.'),
        bar: S.num('With track: a 1-based bar where the clip plays.'),
        clips: { type: 'array', items: { type: 'string' }, description: 'Several audio clip ids.' },
        tracks: { type: 'array', items: { type: 'integer' }, description: '1-based playlist tracks: every aligned clip on them.' },
      },
    ),
  ],
  prompt: {
    id: 'align',
    order: 17,
    text: `Vocal alignment: align_clips makes doubles, backing vocals and ad-libs follow the lead (pick the lead with guide or guide_track; the clips to move with clips or tracks). "Make the double tighter" is a higher tightness (90–100 = syllable by syllable; 40–60 keeps some looseness); with pitch 50–100 their pitch also follows the lead's. tighten_timing snaps one vocal to the grid by strength % (80 keeps a little human feel). Look first with get_alignment (what is aligned, to what, and whether the aligned audio is ready: it is made in the background, so say it will be ready in a moment). Undo restores the earlier sound; remove_alignment takes it away. It works on audio that plays at its own speed (not Reverse, not Pitch or Follow tempo). Aligning comes before tuning: the Pitch editor then works on the aligned sound.`,
  },
  handlers: {
    align_clips: (action, context) => {
      const guide = context.clip({ op: 'align_clips', clip: action.guide, track: action.guide_track, bar: action.guide_bar ?? 1 });
      if (guide.kind !== 'audio') return fail('the guide has to be an audio clip (the recorded lead)');
      const clips = clipsOf(context, action, guide.id as ClipId);
      if (clips.length === 0) {
        const named = clipsOf(context, action);
        if (named.length > 0) return fail('the lead cannot follow itself: give the clips that should follow it');
        return fail('which clips should follow the lead? give clips (ids) or tracks');
      }
      const edit = guideEdit({ guide: guide.id as ClipId, ...optional('tightness', num(action.tightness)), ...optional('pitch', num(action.pitch)) });
      const { done, skipped } = applyTo(context, clips, (project, id) => problemOf(context, project, id, edit), () => edit);
      const line = summarize(context, done, skipped, 'Aligned');
      const pitch = edit.pitch ? `, pitch ${Math.round(edit.pitch)} %` : '';
      return `${line} to the lead (tightness ${Math.round(edit.tightness)}${pitch})`;
    },
    tighten_timing: (action, context) => {
      const clips = clipsOf(context, action);
      if (clips.length === 0) return fail('which clip? give clip (an id, or track and bar), clips or tracks');
      const edit = gridEdit({ ...optional('strength', num(action.strength)), stepTicks: stepOf(action.grid) });
      const { done, skipped } = applyTo(context, clips, (project, id) => problemOf(context, project, id, edit), () => edit);
      return `${summarize(context, done, skipped, 'Tightened')} to the grid (${Math.round(edit.strength ?? 0)} %)`;
    },
    remove_alignment: (action, context) => {
      const clips = clipsOf(context, action).filter((c) => c.align);
      if (clips.length === 0) return fail('none of those clips is aligned');
      for (const clip of clips) {
        setAlign(context.draft, clip.id, null);
        context.touch(clip.start, clip.start + clip.length, [clip.id]);
      }
      return `Removed the alignment from ${clips.length} clip${clips.length === 1 ? '' : 's'}`;
    },
  },
};

/** `{ key: value }` when the value is a number, else nothing (so a missing setting keeps its default). */
function optional<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: number });
}
