/**
 * Shaping the musician's own song after the reference's measurements, as edits of a draft (one History
 * recipe): the tempo, the key (their pitched notes move; drums stay) and the arrangement (the reference's
 * section lengths and energy arc, played by the project's own patterns through the arranger). Loudness and
 * tonal balance need rendering: see `loudness.ts` and `song-tone.ts`.
 *
 * Only measurements cross over. Nothing here reads a note, chord or sample of the reference.
 */
import { current, isDraft, type Draft } from 'immer';
import { inferStyle } from '@core/beat/style';
import type { ClipId, Project, ReferenceTrack, Tick } from '@core/model/types';
import { setBpm, setSongKey } from '@core/ops/notes';
import { assignMaterial, materialOf } from '@core/reference/material';
import { keyMove, keyText, projectKey, transposeSong } from '@core/reference/key';
import { planReferenceSections, planStrip } from '@core/reference/plan';
import type { SectionSpec } from '@core/arrange/sections';
import { ticksPerBar, PPQ } from '@core/time/ppq';
import { variantEnvFor, rolesOf } from '../arrange/env';
import { arrangeInDraft, type SpanGuard } from '../arrange/run';
import type { Services } from '../services';

export interface MatchOptions {
  tempo?: boolean;
  key?: boolean;
  arrangement?: boolean;
}

export interface MatchResult {
  /** Plain lines: what changed (the first sums up). */
  changes: string[];
  /** What could not be done, and why. */
  warnings: string[];
  /** The song span the arrangement edited. */
  touched: { from: Tick; to: Tick } | null;
  clipIds: ClipId[];
}

const plain = (d: Draft<Project>): Project => (isDraft(d) ? (current(d) as unknown as Project) : (d as unknown as Project));

/** The length of one bar of the project in seconds, at its starting tempo. */
export function barSecondsOf(p: Project): number {
  return (ticksPerBar(p.transport.timeSig) / PPQ) * (60 / p.transport.bpm);
}

const fmtBpm = (x: number) => (Math.abs(x - Math.round(x)) < 0.005 ? String(Math.round(x)) : x.toFixed(2));

/**
 * Tempo, key and arrangement of the reference, applied to `d`. Order matters: the tempo first (the sections'
 * bar counts are worked out at the new tempo), then the key, then the arrangement.
 */
export function matchInDraft(d: Draft<Project>, s: Services, base: Project, ref: ReferenceTrack, opts: MatchOptions, guard?: SpanGuard): MatchResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  let touched: MatchResult['touched'] = null;
  let clipIds: ClipId[] = [];
  const p0 = plain(d);

  if (opts.tempo) {
    if (ref.bpm === null) warnings.push(`The reference has no steady beat the analysis could follow, so the tempo stays at ${fmtBpm(p0.transport.bpm)} BPM.`);
    else if (Math.abs(p0.transport.bpm - ref.bpm) < 0.005) changes.push(`The tempo is already ${fmtBpm(ref.bpm)} BPM`);
    else {
      const was = p0.transport.bpm;
      setBpm(d, ref.bpm);
      changes.push(`Tempo ${fmtBpm(was)} → ${fmtBpm(d.transport.bpm)} BPM`);
    }
  }

  if (opts.key) {
    const key = ref.key;
    if (!key) warnings.push('The reference has no clear key, so the key stays as it is.');
    else if (key.confidence < 0.3) warnings.push(`The key of the reference (${keyText(key)}) is uncertain, so the key stays as it is.`);
    else {
      const p = plain(d);
      const roles = rolesOf(p);
      const mine = projectKey(p, roles);
      if (!mine) {
        setSongKey(d, { root: key.root, scale: key.mode });
        changes.push(`Song key set to ${keyText(key)} (your notes didn’t say which key they are in, so none moved)`);
      } else {
        const move = keyMove(mine, key);
        if (move.semitones === 0) {
          if (mine.from === 'notes') setSongKey(d, { root: mine.root, scale: mine.mode });
          changes.push(`Already in the key of the reference (${keyText(mine)}${move.relative ? `, the relative of ${keyText(key)}` : ''})`);
        } else {
          const moved = transposeSong(d, roles, move.semitones);
          const scale = p.transport.key?.scale ?? mine.mode;
          setSongKey(d, { root: move.to.root, scale });
          const dir = move.semitones > 0 ? `up ${move.semitones}` : `down ${-move.semitones}`;
          changes.push(
            `Key ${keyText(mine)} → ${keyText(move.to)}${move.relative ? ` (the relative of ${keyText(key)})` : ''}: ${moved} pitched note${moved === 1 ? '' : 's'} moved ${dir} semitone${Math.abs(move.semitones) === 1 ? '' : 's'}, drums unchanged`,
          );
        }
      }
    }
  }

  if (opts.arrangement) {
    const p = plain(d);
    const style = inferStyle(p);
    const env = variantEnvFor(p, style);
    const planned = planReferenceSections(ref, barSecondsOf(p));
    warnings.push(...planned.notes.filter((n) => /\b(left off|more than)/.test(n)));
    const assigned = assignMaterial(planned.sections, materialOf(p, env));
    if (!assigned.length) {
      warnings.push('There are no patterns with notes to arrange yet: make a beat first, then arrange it like the reference.');
    } else {
      const sections: SectionSpec[] = assigned.map((a) => ({
        name: a.name,
        bars: a.bars,
        role: a.role,
        energy: a.energy,
        play: a.play,
        without: [],
        vary: 'auto',
        transitionIn: 'auto',
        fill: 'auto',
      }));
      const res = arrangeInDraft(d, s, base, { replace: true, style, sections, fx: 'auto', mix: 'keep', ending: 'auto' }, guard);
      touched = res.touched;
      clipIds = res.clipIds;
      changes.push(`Sections follow the reference: ${planStrip(assigned)} (${assigned.reduce((n, a) => n + a.bars, 0)} bars)`);
      changes.push(...res.changes.slice(0, 1));
      warnings.push(...res.warnings);
      const sources = [...new Set(assigned.map((a) => a.from))];
      changes.push(`The sections play your own ${sources.length === 1 ? sources[0]! : 'patterns (' + sources.slice(0, 3).join(', ') + (sources.length > 3 ? '…' : '') + ')'}`);
    }
  }
  return { changes, warnings, touched, clipIds };
}
