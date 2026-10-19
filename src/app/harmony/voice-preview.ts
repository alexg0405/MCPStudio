/**
 * Hearing harmonies before they are made: the first seconds of the lead's part, with the voices rendered the same way "Make
 * harmonies" will, mixed at the settings' levels and pans, as two files to compare (the lead alone, the lead with the voices).
 * They play on the audition bus, so nothing in the project changes and the song's transport is left alone.
 */
import { encodeWav } from '@core/io/wav';
import { previewMix, voiceSeed, type PreviewMixes } from '@core/harmony/voices';
import type { ClipId } from '@core/model/types';
import type { Services } from '../services';
import { hashString } from '@core/arrange/random';
import { prepareLead, type Lead } from './voice-lead';
import { planVoices, renderRegion, type Region } from './voice-render';
import type { HarmonySpec } from './voice-spec';

/** The most seconds of the lead a preview covers: enough to judge the sound, quick to make. */
export const PREVIEW_SECONDS = 20;
/** Seconds of sound rendered around the preview's part, so its first and last notes are whole. */
const PREVIEW_MARGIN_SEC = 0.3;

/** A preview as two audio files. */
export interface HarmonyPreview {
  /** Seconds each file lasts. */
  seconds: number;
  /** The lead alone, as WAV bytes. */
  leadOnly: Uint8Array;
  /** The lead with the voices, as WAV bytes, at the same level. */
  withHarmonies: Uint8Array;
}

/** The frames of the preview: the start of the lead's part, up to `PREVIEW_SECONDS`. */
function previewFrames(lead: Lead): { from: number; to: number; region: Region } {
  const rate = lead.data.sampleRate;
  const total = lead.data.channels[0]?.length ?? 0;
  const from = Math.max(0, Math.floor(lead.range.from * rate));
  const to = Math.min(total, Math.ceil(Math.min(lead.range.to, lead.range.from + PREVIEW_SECONDS) * rate));
  const margin = Math.round(PREVIEW_MARGIN_SEC * rate);
  return { from, to, region: { startFrame: Math.max(0, from - margin), endFrame: Math.min(total, to + margin) } };
}

/** Renders the voices of a request over the first seconds of the lead and mixes the two previews. Throws `HarmonyError`. */
export async function buildPreview(s: Services, clipId: ClipId, spec: HarmonySpec): Promise<HarmonyPreview> {
  const project = s.doc.getState().project;
  const lead = await prepareLead(s, project, clipId);
  const baseSeed = spec.seed ?? hashString(clipId);
  const plans = planVoices(
    project,
    lead,
    spec.voices.map((v, i) => ({ rule: v.rule, formantCents: v.formantCents, humanize: spec.humanize, seed: voiceSeed(i, baseSeed) })),
  );
  const { from, to, region } = previewFrames(lead);
  const cut = (channels: readonly Float32Array[], offset: number) => channels.map((c) => c.slice(from - offset, to - offset));
  const voices: { channels: Float32Array[]; levelDb: number; pan: number }[] = [];
  for (let i = 0; i < plans.length; i++) {
    const rendered = await renderRegion(lead, plans[i] as (typeof plans)[number], region);
    const voice = spec.voices[i] as HarmonySpec['voices'][number];
    voices.push({ channels: cut(rendered, region.startFrame), levelDb: voice.levelDb, pan: voice.pan });
  }
  const mixes = previewMix(cut(lead.data.channels, 0), voices);
  return fileOf(mixes, lead.data.sampleRate);
}

/** Both mixes as 24-bit WAV files. */
function fileOf(mixes: PreviewMixes, sampleRate: number): HarmonyPreview {
  const wav = (channels: [Float32Array, Float32Array]) => encodeWav(channels, sampleRate, { bitDepth: 24 });
  return { seconds: mixes.leadOnly[0].length / sampleRate, leadOnly: wav(mixes.leadOnly), withHarmonies: wav(mixes.withHarmonies) };
}

/** Plays one side of a preview on the audition bus. Resolves false when it could not be played. */
export function playPreview(s: Services, preview: HarmonyPreview, which: 'leadOnly' | 'withHarmonies'): Promise<boolean> {
  const bytes = preview[which];
  return s.engine.previewAudio(bytes.slice().buffer as ArrayBuffer);
}
