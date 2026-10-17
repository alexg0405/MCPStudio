/**
 * The Studio's reference work that needs time, run after its answer is applied (analyzing a song, then
 * matching it; listening to the mix to compare tone). Edits are folded into the answer's undo step.
 */
import { referenceFacts } from '@core/reference/track';
import type { AfterStep } from '../assistant/after-steps';
import { analyzeAndSet, matchLoudness, toneDifference } from './actions';
import { matchInDraft } from './match';

/** "120 BPM, key A minor (8A), −9.0 LUFS, …" */
const factsLine = (ref: Parameters<typeof referenceFacts>[0]) => referenceFacts(ref).join(', ');

export const setReferenceStep: AfterStep = async (item, c) => {
  if (item.kind !== 'set_reference') return null;
  const track = await analyzeAndSet(c.s, item.ref, item.title, {
    signal: c.signal,
    ...(c.entry !== null ? { amend: c.entry } : {}),
    onProgress: (label, fraction) => c.progress(label, fraction),
  });
  return { message: `Reference set: “${track.title}”.`, changes: [factsLine(track)] };
};

export const matchReferenceStep: AfterStep = async (item, c) => {
  if (item.kind !== 'match_reference') return null;
  const { s } = c;
  const ref = s.doc.getState().project.reference;
  if (!ref) return { message: 'There is no reference song to match.', warnings: ['match_reference: no reference is set'] };
  const o = item.options;
  let entry = c.entry;
  const changes: string[] = [];
  const warnings: string[] = [];
  if (o.tempo || o.key || o.arrangement) {
    const base = s.doc.getState().project;
    let res: ReturnType<typeof matchInDraft> | null = null;
    const edited = s.history.transact(
      'Match the reference',
      (d) => {
        res = matchInDraft(d, s, base, ref, { tempo: o.tempo, key: o.key, arrangement: o.arrangement });
      },
      entry !== null ? { amend: entry } : {},
    );
    if (edited && entry === null) entry = s.history.status().cursor;
    const r = res as ReturnType<typeof matchInDraft> | null;
    if (r) {
      changes.push(...r.changes);
      warnings.push(...r.warnings);
      if (r.touched) s.view.getState().setMode('song');
    }
  }
  if (o.loudness) {
    const level = await matchLoudness(s, {
      signal: c.signal,
      whenQuiet: c.whenQuiet,
      entry,
      onProgress: (label, fraction) => c.progress(label, fraction),
    });
    if (level) {
      changes.push(level.message, ...level.changes);
      warnings.push(...level.warnings);
    } else warnings.push('match_reference: nothing plays in the busiest part of the song, so there was nothing to level');
  }
  if (o.tone) {
    const report = await toneDifference(s, {
      signal: c.signal,
      whenQuiet: c.whenQuiet,
      onProgress: (label, fraction) => c.progress(label, fraction),
    });
    if (report) changes.push(`Tonal balance of ${report.song.what} against the reference:`, ...report.lines);
  }
  return { message: 'Matched the reference.', changes, ...(warnings.length ? { warnings } : {}) };
};

export const referenceToneStep: AfterStep = async (item, c) => {
  if (item.kind !== 'reference_tone') return null;
  const report = await toneDifference(c.s, {
    signal: c.signal,
    whenQuiet: c.whenQuiet,
    onProgress: (label, fraction) => c.progress(label, fraction),
  });
  if (!report) return { message: 'Nothing to measure: nothing plays in the busiest part of the song.' };
  return { message: `I listened to ${report.song.what} and compared its tone with the reference.`, changes: report.lines };
};
