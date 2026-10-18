/**
 * DJ auto-mix in the project: songs in → analyzed → planned (`core/dj/plan.ts`) → written as one
 * undo step. The mix is two deck tracks on the mixer (`mix-mixer.ts`), one audio clip channel per song
 * with its clips on the "Deck A" / "Deck B" playlist tracks, the mix's tempo curve, the transition curves,
 * risers and a marker per song (`mix-write.ts`). `Project.dj` remembers the songs, options and
 * tweaks, and what the mix made: making it again replaces exactly that.
 *
 * This file is the entry: making, re-planning and describing a mix. The names that moved to the
 * modules above are re-exported here, so callers import from `mix.ts` as before.
 */
import type { Draft } from 'immer';
import {
  DEFAULT_MIX_OPTIONS,
  planMix,
  type MixOptions,
  type MixPlan,
  type MixTrackInput,
  type TransitionTweak,
} from '@core/dj/plan';
import type { TrackAnalysis } from '@core/dj/types';
import type { DjMixOptions, Project } from '@core/model/types';
import { importAudioFile } from '../actions/samples';
import type { Services } from '../services';
import { peekAnalysis, trackAnalyzer } from './analyzer';
import { writeMixInDraft } from './mix-write';
import type { MixSong } from './mix-types';

export { DECK_NAMES, DELAY, ECHO_NAME, EQ_PRO, FILTER, LIMITER, ensureDecks } from './mix-mixer';
export type { DeckSlots, MixSong, MixWriteResult } from './mix-types';
export { DJ_FX_LANE, TEMPO_LANE, removeMixInDraft, writeMixInDraft } from './mix-write';

/** The options the planner takes, from the ones the project remembers and the transition tweaks. */
const toPlanOptions = (o: DjMixOptions, tweaks: Record<string, TransitionTweak>): MixOptions => ({
  order: o.order,
  energy: o.energy,
  transition: o.transition,
  mixTempo: o.mixTempo,
  ...(o.lengthTargetMin ? { lengthTargetMin: o.lengthTargetMin } : {}),
  ...(o.keyLock ? { keyLock: true } : {}),
  tweaks,
});

/** The options a mix is made with when nothing else is asked: the planner's defaults, with the tempo following each song. */
export const DEFAULT_DJ_OPTIONS: DjMixOptions = {
  order: DEFAULT_MIX_OPTIONS.order,
  energy: DEFAULT_MIX_OPTIONS.energy,
  transition: DEFAULT_MIX_OPTIONS.transition,
  mixTempo: 'follow',
};

// ---------------------------------------------------------------------------------------------
// From songs to a mix

/** What `makeMix` and `importSongs` can be told besides the songs. */
export interface MakeMixOptions {
  signal?: AbortSignal;
  /** Analysis progress: the song being analyzed (0-based), how many, and its fraction. */
  onProgress?(p: { index: number; count: number; title: string; fraction: number }): void;
  /** Fold the edit into this undo entry (the Studio's answer). */
  amend?: number;
}

/** A written mix: its plan, the lines that say what changed, and the planner's warnings. */
export interface MakeMixResult {
  plan: MixPlan;
  changes: string[];
  warnings: string[];
}

/** Analyses of songs: cached, or computed now (one at a time, with progress). */
export async function analyzeSongs(s: Services, songs: readonly MixSong[], opts: MakeMixOptions = {}): Promise<Map<string, TrackAnalysis>> {
  const out = new Map<string, TrackAnalysis>();
  const analyzer = trackAnalyzer(s);
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i]!;
    if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const cached = peekAnalysis(s, song.ref);
    if (cached) {
      out.set(song.ref.id, cached);
      continue;
    }
    if (!analyzer) throw new Error('Song analysis is not available in this version yet.');
    opts.onProgress?.({ index: i, count: songs.length, title: song.title, fraction: 0 });
    const a = await analyzer.analyze(s, song.ref, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (p) => opts.onProgress?.({ index: i, count: songs.length, title: song.title, fraction: p.fraction }),
    });
    out.set(song.ref.id, a);
  }
  return out;
}

/** The planner's inputs: the songs that have an analysis, in the given order. */
const inputsOf = (songs: readonly MixSong[], analyses: ReadonlyMap<string, TrackAnalysis>): MixTrackInput[] =>
  songs.flatMap((x) => {
    const analysis = analyses.get(x.ref.id);
    return analysis ? [{ id: x.ref.id, title: x.title, analysis, ...(x.pinned ? { pinned: true } : {}) }] : [];
  });

/** Plans and writes a mix of songs whose analyses are known (in a draft; sync). */
export function mixInDraft(
  d: Draft<Project>,
  s: Services,
  songs: readonly MixSong[],
  analyses: ReadonlyMap<string, TrackAnalysis>,
  options: DjMixOptions,
  tweaks: Record<string, TransitionTweak> = {},
): MakeMixResult {
  const plan = planMix(inputsOf(songs, analyses), toPlanOptions(options, tweaks));
  const changes = writeMixInDraft(d, s, plan, new Map(songs.map((x) => [x.ref.id, x])), options, tweaks);
  return { plan, changes, warnings: plan.warnings };
}

/** Analyzes (as needed), plans and writes a mix as one undo step. Songs need at least one. */
export async function makeMix(s: Services, songs: readonly MixSong[], options: DjMixOptions = DEFAULT_DJ_OPTIONS, opts: MakeMixOptions = {}): Promise<MakeMixResult> {
  if (songs.length === 0) throw new Error('Pick some songs for the mix first.');
  const analyses = await analyzeSongs(s, songs, opts);
  let result: MakeMixResult | null = null;
  s.history.transact(
    `DJ mix: ${songs.length} songs`,
    (d) => {
      result = mixInDraft(d, s, songs, analyses, options);
    },
    opts.amend !== undefined ? { amend: opts.amend } : {},
  );
  const r = result as MakeMixResult | null;
  if (!r) throw new Error('The mix could not be made.');
  afterMix(s);
  return r;
}

/** After a mix is written: song mode from the top, the playlist on the mix. */
export function afterMix(s: Services): void {
  const view = s.view.getState();
  view.setMode('song');
  view.setLoop(null);
  view.setSongStart(0);
}

/** Imports audio files (stored once by content), then analyzes, plans and writes the mix. */
export async function importSongs(
  s: Services,
  files: readonly Pick<File, 'name' | 'arrayBuffer'>[],
  options: DjMixOptions = DEFAULT_DJ_OPTIONS,
  opts: MakeMixOptions = {},
): Promise<MakeMixResult> {
  const songs: MixSong[] = [];
  for (const f of files) {
    const ref = await importAudioFile(s, f);
    if (ref) songs.push({ ref, title: ref.name });
  }
  return makeMix(s, songs, options, opts);
}

// ---------------------------------------------------------------------------------------------
// The mix that is there

/** The current mix's songs (samples of the project) in mix order, or null without a mix. */
export function currentMixSongs(p: Project): MixSong[] | null {
  if (!p.dj) return null;
  return p.dj.songs.flatMap((x) => {
    const ref = p.samples[x.sampleId];
    return ref ? [{ ref, title: x.title, ...(x.pinned ? { pinned: true } : {}) }] : [];
  });
}

/**
 * Plans the current mix again with changed tweaks or options, in a draft (keeping its order, so only
 * what changed moves). Throws when the songs' analyses aren't cached.
 */
export function replanInDraft(
  d: Draft<Project>,
  s: Services,
  base: Project,
  patch: { tweaks?: Record<string, TransitionTweak | null>; options?: Partial<DjMixOptions> },
): MakeMixResult {
  const dj = base.dj;
  const songs = currentMixSongs(base);
  if (!dj || !songs) throw new Error('There is no DJ mix in this project yet.');
  const analyses = new Map<string, TrackAnalysis>();
  for (const x of songs) {
    const a = peekAnalysis(s, x.ref);
    if (!a) throw new Error(`“${x.title}” isn't analyzed in this browser yet: open the DJ window to analyze it.`);
    analyses.set(x.ref.id, a);
  }
  const tweaks: Record<string, TransitionTweak> = { ...dj.tweaks };
  for (const [k, v] of Object.entries(patch.tweaks ?? {})) {
    if (v === null) delete tweaks[k];
    else tweaks[k] = { ...tweaks[k], ...v };
  }
  // The order stays as it is; options can change the rest.
  const options: DjMixOptions = { ...dj.options, ...patch.options, order: patch.options?.order ?? 'keep' };
  const res = mixInDraft(d, s, songs, analyses, options, tweaks);
  if (d.dj && options.order === 'keep') d.dj.options.order = dj.options.order;
  return res;
}

/** Changes one transition (by the incoming song's sample id) as one undo step. */
export function tweakTransition(s: Services, toSampleId: string, tweak: TransitionTweak | null): MakeMixResult {
  const base = s.doc.getState().project;
  let result: MakeMixResult | null = null;
  s.history.transact('Change a DJ transition', (d) => {
    result = replanInDraft(d, s, base, { tweaks: { [toSampleId]: tweak } });
  });
  return result as unknown as MakeMixResult;
}

/** One line per song for the Studio: title, BPM, key, start bar. */
export function djLines(p: Project): string[] {
  const dj = p.dj;
  if (!dj || dj.songs.length === 0) return [];
  const ts = p.transport.timeSig;
  const bar = 960 * ts.num * (4 / ts.den);
  const lines = [
    `DJ mix (${dj.songs.length} songs; order ${dj.options.order}, energy ${dj.options.energy}, transitions ${dj.options.transition}, tempo ${
      dj.options.mixTempo === 'follow' ? 'follows each song' : `${dj.options.mixTempo} BPM`
    }${dj.options.keyLock ? ', key lock' : ''}):`,
  ];
  dj.songs.forEach((x, i) => {
    const tweak = dj.tweaks[x.sampleId];
    const t = tweak ? ` (transition in: ${[tweak.bars !== undefined ? `${tweak.bars} bars` : '', tweak.recipe ?? '', tweak.riser ? 'riser' : ''].filter(Boolean).join(', ')})` : '';
    lines.push(`- ${i + 1}. “${x.title}”: ${x.bpm ? `${Math.round(x.bpm * 10) / 10} BPM` : 'no steady beat'}, key ${x.camelot ?? 'unknown'}, Deck ${x.deck}, from bar ${Math.floor(x.start / bar) + 1}${t}`);
  });
  return lines;
}

/** Plain words for a transition list entry: "16 bars · bass swap · 8A → 9A (a step) · +1.6 %". */
export function transitionLabel(t: MixPlan['transitions'][number], from: TrackAnalysis | null, to: TrackAnalysis | null): string {
  const recipe = { 'bass-swap': 'bass swap', filter: 'filter out', echo: 'echo out', cut: 'cut' }[t.recipe];
  const keys = from?.key && to?.key ? ` · ${from.key.camelot} → ${to.key.camelot}` : '';
  const tempo = Math.abs(t.tempoChange) > 0.0005 ? ` · ${t.tempoChange > 0 ? '+' : '−'}${Math.round(Math.abs(t.tempoChange) * 1000) / 10} %` : '';
  return `${t.bars ? `${t.bars} bars · ` : ''}${recipe}${t.riser ? ' + riser' : ''}${keys}${tempo}`;
}

/** The plan of the mix that is there (from the cached analyses), or null (no mix, or not analyzed here). */
export function planOfCurrentMix(s: Services, p: Project): MixPlan | null {
  const songs = currentMixSongs(p);
  if (!p.dj || !songs?.length) return null;
  const analyses = new Map<string, TrackAnalysis>();
  for (const x of songs) {
    const a = peekAnalysis(s, x.ref);
    if (!a) return null;
    analyses.set(x.ref.id, a);
  }
  return planMix(inputsOf(songs, analyses), toPlanOptions({ ...p.dj.options, order: 'keep' }, p.dj.tweaks));
}

/** True when the playlist has clips the mix didn't make (a mix would play on top of them). */
export function hasOtherMusic(p: Project): boolean {
  const mine = new Set<string>(p.dj?.made.channels ?? []);
  return Object.values(p.playlist.clips).some((c) => c.kind === 'pattern' || !mine.has(c.channelId));
}
