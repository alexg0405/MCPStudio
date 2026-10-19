/**
 * Harmony voices from a sung lead as user actions ("Make harmonies…", "Update harmonies"; the dialog, the commands, the AI and
 * MCP share these). Each voice is a PSOLA render of the lead's notes shifted to a target (`core/harmony/voices`), stored through
 * the sample store and played by an ordinary audio clip on a new track under the lead. The clip keeps a record of how it was made
 * (`AudioClip.harmony`), so "Update harmonies" can make it again when the lead, the chords or the key change.
 *
 * One run is one undo step: the tracks, channels, samples and clips arrive together.
 */
import { describeRule, voiceSeed } from '@core/harmony/voices';
import { paletteColor, makeLane } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { AudioClip, AudioClipChannel, ClipId, HarmonyVoiceRecord, Project } from '@core/model/types';
import { addHarmonyVoices, setHarmonyRender, type NewHarmonyVoice } from '@core/ops/harmony-voices';
import { currentHarmonySignature, harmonyVoices, staleHarmonyVoices, voicesOfLead, type HarmonyVoice } from '@core/query/harmony-voices';
import { hashString } from '@core/arrange/random';
import type { Services } from '../services';
import { whileBusy } from '../storage/busy';
import { audioChannel } from '../actions/render-to-audio';
import { HarmonyError, prepareLead, type Lead } from './voice-lead';
import { planVoices, renderAndStore } from './voice-render';
import { type HarmonySpec } from './voice-spec';

export { HarmonyError } from './voice-lead';

/** What a run did, for the toast and the AI's answer. */
export interface HarmonyResult {
  /** Voices made or updated. */
  voices: number;
  /** Sung notes the voices follow. */
  notes: number;
  message: string;
}

/** One run at a time: a second request while one renders is told to wait. */
let running = false;

async function exclusive<T>(job: () => Promise<T>): Promise<T> {
  if (running) throw new HarmonyError('Harmonies are already being made: wait for them to finish.');
  running = true;
  try {
    return await job();
  } finally {
    running = false;
  }
}

/** The channel of a new voice: it plays like the lead (pitch, tempo follow), on the lead's mixer track, at the voice's level and pan. */
function voiceChannel(lead: Lead, spec: HarmonySpec['voices'][number], sampleId: AudioClipChannel['sampleId'], colorIndex: number): AudioClipChannel {
  const name = `${lead.channel.name} · ${describeRule(spec.rule)}`;
  const channel = audioChannel(name, paletteColor(colorIndex), sampleId, lead.channel.output);
  channel.volume = Math.min(1.25, Math.pow(10, spec.levelDb / 20));
  channel.pan = Math.max(-1, Math.min(1, spec.pan));
  if (lead.channel.pitch !== undefined) channel.pitch = lead.channel.pitch;
  if (lead.channel.stretch !== undefined) channel.stretch = lead.channel.stretch;
  if (lead.channel.sourceBpm !== undefined) channel.sourceBpm = lead.channel.sourceBpm;
  return channel;
}

/** The clip of a voice: the lead's own place, trim, fades and gain, with the record of how it was made. */
function voiceClip(lead: Lead, laneId: NewHarmonyVoice['lane']['id'], channelId: AudioClipChannel['id'], record: HarmonyVoiceRecord): AudioClip {
  const { clip } = lead;
  return {
    kind: 'audio',
    id: newId.clip(),
    laneId,
    start: clip.start,
    length: clip.length,
    channelId,
    offsetSec: clip.offsetSec,
    ...(clip.gain !== undefined ? { gain: clip.gain } : {}),
    ...(clip.fadeIn !== undefined ? { fadeIn: clip.fadeIn } : {}),
    ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
    harmony: record,
  };
}

/**
 * Makes harmony voices from a lead clip: new tracks right under it, one undo step. Resolves with what was made; rejects with
 * `HarmonyError` in plain words (no key for a diatonic rule, no sung notes, missing audio…).
 */
export function makeHarmonies(s: Services, clipId: ClipId, spec: HarmonySpec): Promise<HarmonyResult> {
  return exclusive(() => makeHarmoniesNow(s, clipId, spec));
}

async function makeHarmoniesNow(s: Services, clipId: ClipId, spec: HarmonySpec): Promise<HarmonyResult> {
  const project = s.doc.getState().project;
  const lead = await prepareLead(s, project, clipId);
  const group = newId.clip();
  const baseSeed = spec.seed ?? hashString(group);
  const records: HarmonyVoiceRecord[] = spec.voices.map((v, i) => ({
    group,
    voice: i,
    source: clipId,
    rule: v.rule,
    formantCents: v.formantCents,
    humanize: spec.humanize,
    seed: voiceSeed(i, baseSeed),
  }));
  const plans = planVoices(project, lead, records);
  const made = await whileBusy(async () => {
    const out: NewHarmonyVoice[] = [];
    for (let i = 0; i < plans.length; i++) {
      const voice = spec.voices[i] as HarmonySpec['voices'][number];
      const record = records[i] as HarmonyVoiceRecord;
      const sample = await renderAndStore(lead, plans[i] as (typeof plans)[number], `${lead.channel.name} harmony ${i + 1}`);
      const signature = currentHarmonySignature(project, record);
      if (signature) record.renderedFor = signature;
      const channel = voiceChannel(lead, voice, sample.id, project.channelOrder.length + i);
      const lane = makeLane(`${lead.channel.name} harmony ${i + 1}`);
      const leadLane = project.playlist.lanes[lead.clip.laneId];
      if (leadLane?.color) lane.color = leadLane.color;
      out.push({ lane, channel, sample, clip: voiceClip(lead, lane.id, channel.id, record) });
    }
    return out;
  }, { project });
  const label = made.length === 1 ? 'Make harmony' : `Make harmonies (${made.length} voices)`;
  const committed = s.history.transact(label, (d) => addHarmonyVoices(d, lead.clip.laneId, made));
  if (!committed) throw new HarmonyError('The harmonies could not be added.');
  const names = spec.voices.map((v) => describeRule(v.rule)).join(', ');
  return { voices: made.length, notes: lead.notes.length, message: `Made ${made.length === 1 ? 'a harmony voice' : `${made.length} harmony voices`} (${names}) from ${lead.notes.length} sung notes.` };
}

/** Which voices an update acts on. */
export interface UpdateOptions {
  /** Only the voices of this lead (a lead clip, or one of its harmony clips); default every harmony in the project. */
  clip?: ClipId;
  /** Make the voices again even when they are up to date (a new take of the same settings is not made: the seed is kept). */
  force?: boolean;
}

/** The lead clip an update is about: the clip itself, or the lead a harmony clip was made from. */
function leadIdOf(project: Project, clipId: ClipId): ClipId {
  const clip = project.playlist.clips[clipId];
  return clip?.kind === 'audio' && clip.harmony ? clip.harmony.source : clipId;
}

/** The voices an update remakes: those of the lead asked for (or all), and only the out-of-date ones unless forced. */
function voicesToUpdate(project: Project, opts: UpdateOptions): HarmonyVoice[] {
  // A voice whose lead is gone has nothing to be made from again: it stays as it is.
  const all = opts.clip ? voicesOfLead(project, leadIdOf(project, opts.clip)) : harmonyVoices(project);
  const voices = all.filter((v) => currentHarmonySignature(project, v.record) !== null);
  if (opts.force) return voices;
  const stale = new Set(staleHarmonyVoices(project).map((v) => v.channelId));
  return voices.filter((v) => stale.has(v.channelId));
}

/** The voices to remake, gathered by the run they were made in: a run is planned whole, so its chord voices keep their order. */
function groupsToUpdate(project: Project, opts: UpdateOptions): Map<string, { lead: ClipId; all: HarmonyVoice[]; selected: Set<HarmonyVoice> }> {
  const groups = new Map<string, { lead: ClipId; all: HarmonyVoice[]; selected: Set<HarmonyVoice> }>();
  for (const voice of voicesToUpdate(project, opts)) {
    const key = `${voice.record.source}|${voice.record.group}`;
    let entry = groups.get(key);
    if (!entry) {
      const all = voicesOfLead(project, voice.record.source).filter((v) => v.record.group === voice.record.group);
      entry = { lead: voice.record.source, all, selected: new Set() };
      groups.set(key, entry);
    }
    entry.selected.add(entry.all.find((v) => v.channelId === voice.channelId) ?? voice);
  }
  return groups;
}

/**
 * Makes harmony voices again from their lead as it is now: new notes, a new chord track or key, a changed trim. Only the voices
 * that are out of date (or all of them with `force`); the clips, tracks, levels and pans stay. One undo step.
 */
export function updateHarmonies(s: Services, opts: UpdateOptions = {}): Promise<HarmonyResult> {
  return exclusive(() => updateHarmoniesNow(s, opts));
}

async function updateHarmoniesNow(s: Services, opts: UpdateOptions): Promise<HarmonyResult> {
  const project = s.doc.getState().project;
  const targets = groupsToUpdate(project, opts);
  if (targets.size === 0) {
    const any = harmonyVoices(project).length > 0;
    return { voices: 0, notes: 0, message: any ? 'The harmonies are up to date.' : 'There are no harmony voices to update. Make some with Make harmonies….' };
  }
  const renders: { voice: HarmonyVoice; sample: Awaited<ReturnType<typeof renderAndStore>>; signature: string }[] = [];
  let notes = 0;
  await whileBusy(async () => {
    for (const { lead: leadId, all, selected } of targets.values()) {
      const lead = await prepareLead(s, project, leadId);
      notes += lead.notes.length;
      const ordered = [...all].sort((a, b) => a.record.voice - b.record.voice);
      const plans = planVoices(project, lead, ordered.map((v) => v.record));
      for (let i = 0; i < ordered.length; i++) {
        const voice = ordered[i] as HarmonyVoice;
        if (!selected.has(voice)) continue;
        const channelName = project.channels[voice.channelId]?.name ?? 'Harmony';
        const sample = await renderAndStore(lead, plans[i] as (typeof plans)[number], channelName);
        renders.push({ voice, sample, signature: currentHarmonySignature(project, voice.record) as string });
      }
    }
  }, { project });
  s.history.transact(renders.length === 1 ? 'Update harmony' : `Update harmonies (${renders.length} voices)`, (d) => {
    for (const r of renders) setHarmonyRender(d, r.voice.channelId, r.sample, r.signature);
  });
  return { voices: renders.length, notes, message: `Updated ${renders.length === 1 ? 'a harmony voice' : `${renders.length} harmony voices`} from the lead as it is now.` };
}

/** How many harmony voices are out of date (for the menu entry and a hint). */
export function staleHarmonyCount(project: Project): number {
  return staleHarmonyVoices(project).length;
}
