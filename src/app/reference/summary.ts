/**
 * The reference as the Studio reads it: a compact block in its context each turn, and the data behind
 * the `get_reference` read tool. Numbers only (the reference's measurements next to the musician's song).
 */
import { keyName } from '@core/dj/key';
import type { Project, ReferenceTrack } from '@core/model/types';
import { mainTone, TONE_BANDS } from '@core/reference/bands';
import { modeOfScale } from '@core/reference/key';
import { planReferenceSections, planStrip } from '@core/reference/plan';
import { referenceFacts, referenceKeyName, sectionKindName } from '@core/reference/track';
import { songSections } from '@core/query/sections';
import { ticksPerBar } from '@core/time/ppq';
import { barSecondsOf } from './match';
import { referenceState, type ToneReport } from './state';

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const sign = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(r1(x));

/** The tonal comparison made for this project and this reference, if any (it may be old: the song can have changed since). */
export function lastTone(p: Project): ToneReport | null {
  const t = referenceState.getState().tone;
  return t && p.reference && t.projectId === p.projectId && t.referenceHash === p.reference.hash ? t : null;
}

/** The musician's song as sections of the playlist: "Intro 8 · Drop 16". */
function mySections(p: Project): { name: string; bars: number }[] {
  const bar = ticksPerBar(p.transport.timeSig);
  return songSections(p).map((s) => ({ name: s.name, bars: Math.round((s.to - s.from) / bar) }));
}

/** The song's key as set ("F minor"), or null. */
function mineKey(p: Project): string | null {
  const k = p.transport.key;
  return k ? keyName({ root: k.root, mode: modeOfScale(k.scale) }) : null;
}

/** Lines for the Studio's context (empty without a reference). */
export function referenceLines(p: Project): string[] {
  const ref = p.reference;
  if (!ref) return [];
  const lines = [`<reference> “${ref.title}”: ${referenceFacts(ref).join(', ')}.`];
  if (ref.sections.length)
    lines.push(
      `  Sections (bars of its own tempo, energy 0–1): ${ref.sections.map((s) => `${sectionKindName(s.kind)} ${s.bars} (${r2(s.energy)})`).join(' · ')}`,
    );
  lines.push(`  Tonal balance of its loud parts (share of the energy per band, dB under the total): ${mainTone(ref).map((v, i) => `${TONE_BANDS[i]!.id} ${r1(v)}`).join(', ')}`);
  const mine: string[] = [`${r2(p.transport.bpm)} BPM`, mineKey(p) ? `key ${mineKey(p)}` : 'no key set'];
  if (ref.bpm !== null) mine.push(`tempo ${sign(p.transport.bpm - ref.bpm)} BPM from the reference`);
  const sections = mySections(p);
  lines.push(`  Your song: ${mine.join(', ')}${sections.length ? `; sections ${planStrip(sections)}` : ''}.`);
  const tone = lastTone(p);
  if (tone) lines.push(`  Last tone check (${tone.song.what}): ${tone.comparison.off.length ? tone.lines.join(' ') : tone.lines[0]}`);
  lines.push('</reference>');
  return lines;
}

/** The JSON of `get_reference`. */
export function referenceReport(p: Project): Record<string, unknown> {
  const ref: ReferenceTrack | undefined = p.reference;
  if (!ref) return { reference: null, note: 'No reference is set. set_reference makes one from a library song, a sample or a file.' };
  const plan = planReferenceSections(ref, barSecondsOf(p));
  const tone = lastTone(p);
  const key = referenceKeyName(ref);
  const tonal = (bands: readonly number[]) => Object.fromEntries(TONE_BANDS.map((b, i) => [b.id, r1(bands[i] ?? -60)]));
  return {
    reference: {
      title: ref.title,
      tempo_bpm: ref.bpm,
      key,
      key_confidence: ref.key?.confidence ?? null,
      lufs: ref.lufs,
      true_peak_db: ref.truePeakDb,
      stereo_width: ref.width,
      duration_sec: Math.round(ref.durationSec),
      sections: ref.sections.map((s) => ({
        part: s.kind,
        bars: s.bars,
        from_sec: Math.round(s.startSec),
        energy: s.energy,
        tone_db: tonal(s.bands),
        stereo_width: s.width,
      })),
      tone_db: tonal(ref.bands),
      loud_parts_tone_db: tonal(mainTone(ref)),
      tone_db_note: 'share of the energy per band in dB under the total (sub <60 Hz, bass 60–150, lowMid 150–400, mid 400–1k, upperMid 1–2.5k, presence 2.5–5k, highs 5–10k, air >10k)',
    },
    yours: {
      tempo_bpm: r2(p.transport.bpm),
      key: mineKey(p),
      sections: mySections(p),
    },
    differences: {
      ...(ref.bpm !== null ? { tempo_bpm: r2(p.transport.bpm - ref.bpm) } : {}),
    },
    arrangement_at_your_tempo: plan.sections.map((s) => ({ name: s.name, bars: s.bars, energy_1_5: s.energy })),
    ...(plan.notes.length ? { arrangement_notes: plan.notes } : {}),
    tone_check: tone
      ? {
          listened_to: tone.song.what,
          song_lufs: r1(tone.song.lufs),
          off_by_more_than_db: tone.comparison.thresholdDb,
          findings: tone.lines,
          bands: tone.comparison.bands.map((b) => ({ band: b.band.id, mix_minus_reference_db: b.diffDb })),
          note: 'measured earlier: the song may have changed since; match_reference with tone measures again',
        }
      : { note: 'not measured yet: match_reference with tone: true listens to the mix and compares' },
  };
}
