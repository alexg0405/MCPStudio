/**
 * Turning a track analysis plus a tonal measurement into the numbers a project keeps about its reference
 * song (`Project.reference`), and reading them back in words. Only derived measurements: nothing here can
 * carry the song's audio, melodies or chords.
 */
import { camelotOf, keyName } from '../dj/key';
import { ANALYSIS_VERSION, type TrackAnalysis } from '../dj/types';
import type { ReferenceSection, ReferenceTrack, SampleId } from '../model/types';
import { TONE_BANDS } from './bands';

/** What the audio measured (the analysis does not know it): the whole song and each of its sections. */
export interface ToneMeasure {
  bands: number[];
  width: number;
  /** One per section of the analysis, in order. */
  sections: { bands: number[]; width: number }[];
}

/** The most energy values kept (long songs are averaged down to this many). */
export const MAX_ENERGY_POINTS = 1024;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const finite = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

/** The length of a bar of the reference's own grid in seconds (2 s without a grid). */
export const referenceBarSeconds = (a: Pick<TrackAnalysis, 'grid'>): number => (a.grid ? (a.grid.beatsPerBar * 60) / a.grid.bpm : 2);

function energyPoints(energy: readonly number[]): number[] {
  if (energy.length <= MAX_ENERGY_POINTS) return energy.map((e) => r2(finite(e, 0)));
  const out: number[] = [];
  const step = energy.length / MAX_ENERGY_POINTS;
  for (let i = 0; i < MAX_ENERGY_POINTS; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j++) sum += energy[j] ?? 0;
    out.push(r2(sum / (to - from)));
  }
  return out;
}

/** The reference's numbers from its analysis and tonal measurement. */
export function buildReference(a: TrackAnalysis, tone: ToneMeasure, meta: { title: string; sampleId?: SampleId }): ReferenceTrack {
  const barSec = referenceBarSeconds(a);
  const empty = TONE_BANDS.map(() => -60);
  const sections: ReferenceSection[] = a.sections.map((s, i) => ({
    kind: s.kind,
    startSec: r2(s.start),
    endSec: r2(s.end),
    bars: Math.max(1, Math.round((s.end - s.start) / barSec)),
    energy: r2(Math.max(0, Math.min(1, finite(s.energy, 0)))),
    bands: tone.sections[i]?.bands ?? empty,
    width: r2(finite(tone.sections[i]?.width ?? 0, 0)),
  }));
  return {
    ...(meta.sampleId ? { sampleId: meta.sampleId } : {}),
    title: meta.title.slice(0, 160),
    hash: a.hash,
    durationSec: r2(a.durationSec),
    bpm: a.grid ? r2(a.grid.bpm) : null,
    beatsPerBar: a.grid?.beatsPerBar ?? 4,
    key: a.key ? { root: a.key.root, mode: a.key.mode, camelot: a.key.camelot, confidence: r2(a.key.confidence) } : null,
    lufs: r1(finite(a.lufs, -70)),
    truePeakDb: r1(finite(a.truePeakDb, -70)),
    bands: tone.bands,
    width: r2(finite(tone.width, 0)),
    energy: energyPoints(a.energy),
    sections,
    version: a.version,
  };
}

/** Whether the numbers come from an older analysis (they are measured again when the song is looked at). */
export const isStale = (ref: Pick<ReferenceTrack, 'version'>): boolean => ref.version !== ANALYSIS_VERSION;

const KIND_NAME: Record<ReferenceSection['kind'], string> = {
  intro: 'Intro',
  build: 'Build',
  drop: 'Drop',
  break: 'Break',
  verse: 'Verse',
  outro: 'Outro',
  body: 'Main part',
};
export const sectionKindName = (k: ReferenceSection['kind']): string => KIND_NAME[k];

/** "Intro 16 · Drop 32 · Break 16 · Drop 32" (bars). */
export function sectionStrip(ref: Pick<ReferenceTrack, 'sections'>): string {
  return ref.sections.map((s) => `${KIND_NAME[s.kind]} ${s.bars}`).join(' · ');
}

/** "A minor (8A)" or null. */
export function referenceKeyName(ref: Pick<ReferenceTrack, 'key'>): string | null {
  return ref.key ? `${keyName(ref.key)} (${camelotOf(ref.key.root, ref.key.mode)})` : null;
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const sign = (x: number, digits = 1) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}`;

/** Facts for a line of text (the Studio's context, the read tool, the panel's header). */
export function referenceFacts(ref: ReferenceTrack): string[] {
  const out = [
    ref.bpm !== null ? `${ref.bpm} BPM` : 'no steady tempo found',
    ref.key ? `key ${referenceKeyName(ref)}${ref.key.confidence < 0.3 ? ' (unsure)' : ''}` : 'no key found',
    `${sign(ref.lufs)} LUFS`,
    `true peak ${sign(ref.truePeakDb)} dBTP`,
    `stereo width ${ref.width.toFixed(2)}`,
    mmss(ref.durationSec),
  ];
  return out;
}

/** The master's loudness a reference asks for (LUFS), kept within what a Limiter can reach. */
export const loudnessTarget = (ref: Pick<ReferenceTrack, 'lufs'>): number => Math.max(-30, Math.min(-4, ref.lufs));
