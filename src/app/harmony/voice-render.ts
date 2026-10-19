/**
 * From a lead to the audio of its harmony voices: plan what each voice sings (key, chord track, guide melody), render each voice
 * in a Worker over a stretch of the lead's sample, and store a voice as a sample the size of the lead's (silent outside the
 * part the lead clip plays, which compresses to nothing), so every voice clip lines up with the lead and its trims keep working.
 */
import {
  chordTonePitchClasses,
  humanizeNotes,
  planTargets,
  shiftsFromTargets,
  type PlanContext,
  type SourceNote,
} from '@core/harmony/voices';
import type { HarmonyHumanize, HarmonyRule, Project, SampleRef } from '@core/model/types';
import { chordAt } from '@core/query/chords';
import { encodeOffThread } from '../export/encode';
import { importSampleBytes } from '../persistence/sample-import';
import { HarmonyError, type Lead } from './voice-lead';
import { renderVoice } from './voice-jobs';

/** What one voice needs to be planned and rendered. */
export interface VoiceInput {
  rule: HarmonyRule;
  formantCents: number;
  humanize: HarmonyHumanize;
  /** The voice's own seed (see `voiceSeed`). */
  seed: number;
}

/** A voice as the renderer takes it: the notes to sing and where each goes. */
export interface VoicePlan {
  notes: readonly SourceNote[];
  /** Semitones from how the lead sang each note; null = silent there. */
  shifts: readonly (number | null)[];
  formantCents: number;
  humanize: HarmonyHumanize;
  seed: number;
}

/** What planning reads from the song: the key and the chord track. */
export function planContextOf(project: Project): PlanContext {
  const key = project.transport.key;
  return {
    key: key ?? null,
    chordTonesAt: (tick) => {
      const chord = chordAt(project, tick);
      return chord ? chordTonePitchClasses(chord) : null;
    },
  };
}

/**
 * Plans every voice of a group together (the chord voices keep their order across the whole stack). Throws `HarmonyError` in
 * plain words when a rule cannot be planned.
 */
export function planVoices(project: Project, lead: Lead, voices: readonly VoiceInput[]): VoicePlan[] {
  let targets: (number | null)[][];
  try {
    targets = planTargets(lead.leadNotes, voices.map((v) => v.rule), planContextOf(project));
  } catch (e) {
    throw new HarmonyError(e instanceof Error ? e.message : String(e));
  }
  return voices.map((voice, i) => ({
    notes: lead.notes,
    shifts: shiftsFromTargets(lead.leadNotes, targets[i] as (number | null)[]),
    formantCents: voice.formantCents,
    humanize: voice.humanize,
    seed: voice.seed,
  }));
}

/** The frames [startFrame, endFrame) of the lead's sample that a render covers. */
export interface Region {
  startFrame: number;
  endFrame: number;
}

/** The lead's own region (its part plus a margin). */
export const wholeRegion = (lead: Lead): Region => ({ startFrame: lead.startFrame, endFrame: lead.endFrame });

/** Renders a voice over a region of the lead's sample in a Worker. Returns the region's frames. */
export async function renderRegion(lead: Lead, plan: VoicePlan, region: Region): Promise<Float32Array[]> {
  const rate = lead.data.sampleRate;
  const start = region.startFrame / rate;
  const end = region.endFrame / rate;
  const inside = plan.notes.map((n, i) => ({ n, i })).filter(({ n }) => n.to > start && n.from < end);
  const notes = inside.map(({ n }) => n);
  const shifts = inside.map(({ i }) => plan.shifts[i] ?? null);
  const humanize = humanizeNotes(plan.notes.length, plan.humanize, plan.seed);
  return renderVoice({
    channels: lead.data.channels.map((c) => c.slice(region.startFrame, region.endFrame)),
    sampleRate: rate,
    start,
    notes,
    shifts,
    humanize: inside.map(({ i }) => humanize[i] as (typeof humanize)[number]),
    formantCents: plan.formantCents,
  });
}

/** Puts a rendered region into a silent copy of the lead's whole sample, turned down if it would clip. */
export function spliceVoice(lead: Lead, region: Region, rendered: readonly Float32Array[]): Float32Array[] {
  const total = lead.data.channels[0]?.length ?? 0;
  let peak = 0;
  for (const part of rendered) for (let i = 0; i < part.length; i++) peak = Math.max(peak, Math.abs(part[i] as number));
  const scale = peak > 1 ? 1 / peak : 1;
  return rendered.map((part) => {
    const full = new Float32Array(total);
    for (let i = 0; i < part.length; i++) full[region.startFrame + i] = (part[i] as number) * scale;
    return full;
  });
}

/** Stores a voice's full-length audio through the sample store as 24-bit FLAC; returns its sample entry. */
export async function storeVoice(lead: Lead, full: Float32Array[], name: string): Promise<SampleRef> {
  const bytes = await encodeOffThread(full, lead.data.sampleRate, { codec: 'flac', bits: 24, kbps: 0 });
  const stored = await importSampleBytes(bytes, `${name}.flac`);
  return { ...stored, durationSec: lead.data.duration, sampleRate: lead.data.sampleRate, channels: full.length };
}

/** Renders a voice over the lead's whole region and stores it. */
export async function renderAndStore(lead: Lead, plan: VoicePlan, name: string): Promise<SampleRef> {
  const region = wholeRegion(lead);
  const rendered = await renderRegion(lead, plan, region);
  return storeVoice(lead, spliceVoice(lead, region, rendered), name);
}
