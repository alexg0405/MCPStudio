/**
 * What changed between two states of a project, in plain words: a few short phrases for the Versions timeline ("+3 clips,
 * mixer: Kick −2.0 dB, new pattern 'Drop 2'") and a full list for when someone asks "what is different?". The mixer's
 * sentences come from the snapshot diff (`core/snapshots/diff.ts`), so a fader or an effect setting reads the same
 * everywhere. Pure and quick on big songs: parts of the project that are the same object in both states (Immer shares
 * what an edit did not touch) are skipped without a look.
 */
import type { PluginInfoResolver } from '../automation/labels';
import { gainToDecibels } from '../model/fader';
import type { Channel, Insert, InsertId, Note, Pattern, Project, SlotId } from '../model/types';
import { captureMixerState, type MixerState } from '../snapshots/capture';
import { diffMixerStates } from '../snapshots/diff';
import { songKeyText } from './facts';

/** What changed: the short phrases (most important first) and every difference as a sentence. */
export interface ProjectChanges {
  parts: string[];
  lines: string[];
}

/** The most phrases a one-line summary names before it counts the rest. */
const MAX_SUMMARY_PARTS = 4;
/** Mixer tracks named in a phrase before "and N more". */
const MAX_NAMED_TRACKS = 2;
/** Tempo and levels closer than this are the same (stored as doubles). */
const SAME_WITHIN = 1e-9;

const noPlugins: PluginInfoResolver = () => undefined;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (name: string) => `'${name}'`;

/** Structural equality of plain data, quick when both sides are the same object. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < SAME_WITHIN;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && sameData(left[key], right[key]));
}

/** "+3", "−2" (a real minus sign, as in a mixer's dB readout). */
const signed = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n)}`;

/** A fader change in dB, "−2.0 dB" or "+1.5 dB". */
function decibelChange(from: number, to: number): string | null {
  const before = gainToDecibels(from);
  const after = gainToDecibels(to);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const delta = Math.round((after - before) * 10) / 10;
  if (delta === 0) return null;
  return `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)} dB`;
}

function songChanges(before: Project, after: Project, out: ProjectChanges): void {
  const a = before.transport;
  const b = after.transport;
  if (a.bpm !== b.bpm) {
    out.parts.push(`tempo ${a.bpm} → ${b.bpm} BPM`);
    out.lines.push(`Tempo ${a.bpm} → ${b.bpm} BPM`);
  }
  if (a.timeSig.num !== b.timeSig.num || a.timeSig.den !== b.timeSig.den) {
    out.parts.push(`time signature ${a.timeSig.num}/${a.timeSig.den} → ${b.timeSig.num}/${b.timeSig.den}`);
    out.lines.push(`Time signature ${a.timeSig.num}/${a.timeSig.den} → ${b.timeSig.num}/${b.timeSig.den}`);
  }
  const keyBefore = songKeyText(a.key);
  const keyAfter = songKeyText(b.key);
  if (keyBefore !== keyAfter) {
    out.parts.push(`key ${keyBefore ?? 'none'} → ${keyAfter ?? 'none'}`);
    out.lines.push(`Key ${keyBefore ?? 'none'} → ${keyAfter ?? 'none'}`);
  }
  if (Math.abs(a.swing - b.swing) > SAME_WITHIN) {
    out.lines.push(`Swing ${Math.round(a.swing * 100)}% → ${Math.round(b.swing * 100)}%`);
    out.parts.push('swing');
  }
  if (before.meta.title !== after.meta.title) out.lines.push(`Title “${before.meta.title}” → “${after.meta.title}”`);
}

function patternChanges(before: Project, after: Project, out: ProjectChanges): void {
  for (const pattern of Object.values(after.patterns)) {
    const old = before.patterns[pattern.id];
    if (!old) {
      out.parts.push(`new pattern ${quote(pattern.name)}`);
      out.lines.push(`New pattern ${quote(pattern.name)}`);
    } else if (old.name !== pattern.name) {
      out.parts.push(`pattern ${quote(old.name)} renamed ${quote(pattern.name)}`);
      out.lines.push(`Pattern ${quote(old.name)} renamed to ${quote(pattern.name)}`);
    }
  }
  for (const pattern of Object.values(before.patterns)) {
    if (after.patterns[pattern.id]) continue;
    out.parts.push(`removed pattern ${quote(pattern.name)}`);
    out.lines.push(`Removed pattern ${quote(pattern.name)}`);
  }
}

function clipChanges(before: Project, after: Project, out: ProjectChanges): void {
  const a = before.playlist;
  const b = after.playlist;
  if (a.clips !== b.clips) {
    let added = 0;
    let removed = 0;
    let edited = 0;
    for (const clip of Object.values(b.clips)) {
      const old = a.clips[clip.id];
      if (!old) added++;
      else if (!sameData(old, clip)) edited++;
    }
    for (const clip of Object.values(a.clips)) if (!b.clips[clip.id]) removed++;
    if (added > 0) out.parts.push(`+${plural(added, 'clip')}`);
    if (removed > 0) out.parts.push(`−${plural(removed, 'clip')}`);
    if (edited > 0) out.parts.push(`${plural(edited, 'clip')} changed`);
    const bits = [
      added > 0 ? `${plural(added, 'clip')} added` : '',
      removed > 0 ? `${plural(removed, 'clip')} removed` : '',
      edited > 0 ? `${plural(edited, 'clip')} moved or changed` : '',
    ].filter(Boolean);
    if (bits.length > 0) out.lines.push(`Playlist: ${bits.join(', ')}`);
  }
  if (a.lanes !== b.lanes) {
    const newLanes = Object.keys(b.lanes).filter((id) => !a.lanes[id as keyof typeof a.lanes]).length;
    const goneLanes = Object.keys(a.lanes).filter((id) => !b.lanes[id as keyof typeof b.lanes]).length;
    if (newLanes > 0) out.parts.push(`+${plural(newLanes, 'track')}`);
    if (goneLanes > 0) out.parts.push(`−${plural(goneLanes, 'track')}`);
    if (newLanes > 0) out.lines.push(`Playlist: ${plural(newLanes, 'track')} added`);
    if (goneLanes > 0) out.lines.push(`Playlist: ${plural(goneLanes, 'track')} removed`);
  }
  if (a.markers !== b.markers && !sameData(a.markers, b.markers)) {
    const added = Object.keys(b.markers).filter((id) => !a.markers[id as keyof typeof a.markers]).length;
    const removed = Object.keys(a.markers).filter((id) => !b.markers[id as keyof typeof b.markers]).length;
    if (added > 0) out.parts.push(`+${plural(added, 'marker')}`);
    if (removed > 0) out.parts.push(`−${plural(removed, 'marker')}`);
    out.lines.push(`Markers: ${added} added, ${removed} removed, ${Math.max(0, Object.keys(b.markers).length - added)} kept`);
  }
}

/** Notes added, removed and edited in one pattern that exists in both states. */
function patternNoteChanges(old: Pattern, now: Pattern): { added: number; removed: number; edited: number } {
  const tally = { added: 0, removed: 0, edited: 0 };
  if (old.notes === now.notes) return tally;
  const channels = new Set([...Object.keys(old.notes), ...Object.keys(now.notes)]);
  for (const channelId of channels) {
    const was = old.notes[channelId as keyof typeof old.notes] as Record<string, Note> | undefined;
    const is = now.notes[channelId as keyof typeof now.notes] as Record<string, Note> | undefined;
    if (was === is) continue;
    for (const [id, note] of Object.entries(is ?? {})) {
      const earlier = was?.[id];
      if (!earlier) tally.added++;
      else if (!sameData(earlier, note)) tally.edited++;
    }
    for (const id of Object.keys(was ?? {})) if (!is?.[id]) tally.removed++;
  }
  return tally;
}

function noteChanges(before: Project, after: Project, out: ProjectChanges): void {
  if (before.patterns === after.patterns) return;
  const total = { added: 0, removed: 0, edited: 0 };
  for (const pattern of Object.values(after.patterns)) {
    const old = before.patterns[pattern.id];
    if (!old) continue;
    const tally = patternNoteChanges(old, pattern);
    total.added += tally.added;
    total.removed += tally.removed;
    total.edited += tally.edited;
    const bits = [
      tally.added > 0 ? `${plural(tally.added, 'note')} added` : '',
      tally.removed > 0 ? `${plural(tally.removed, 'note')} removed` : '',
      tally.edited > 0 ? `${plural(tally.edited, 'note')} edited` : '',
    ].filter(Boolean);
    if (bits.length > 0) out.lines.push(`Pattern ${quote(pattern.name)}: ${bits.join(', ')}`);
  }
  if (total.added > 0) out.parts.push(`${signed(total.added)} ${total.added === 1 ? 'note' : 'notes'}`);
  if (total.removed > 0) out.parts.push(`${signed(-total.removed)} ${total.removed === 1 ? 'note' : 'notes'}`);
  if (total.edited > 0) out.parts.push(`${plural(total.edited, 'note')} edited`);
}

function channelChanges(before: Project, after: Project, out: ProjectChanges): void {
  if (before.channels === after.channels) return;
  let edited = 0;
  for (const channel of Object.values(after.channels) as Channel[]) {
    const old = before.channels[channel.id];
    if (!old) {
      out.parts.push(`new ${channel.kind === 'automation' ? 'automation' : 'channel'} ${quote(channel.name)}`);
      out.lines.push(`New ${channel.kind === 'automation' ? 'automation channel' : 'channel'} ${quote(channel.name)}`);
    } else if (!sameData(old, channel)) {
      edited++;
      out.lines.push(`Channel ${quote(channel.name)}: settings changed`);
    }
  }
  for (const channel of Object.values(before.channels) as Channel[]) {
    if (after.channels[channel.id]) continue;
    out.parts.push(`removed channel ${quote(channel.name)}`);
    out.lines.push(`Removed channel ${quote(channel.name)}`);
  }
  if (edited > 0) out.parts.push(`${plural(edited, 'channel')} changed`);
}

/** The state of the tracks that both versions have, with only the effects both have (the rest is said on its own). */
function sharedMixerStates(before: Project, after: Project): { from: MixerState; to: MixerState } {
  const from = captureMixerState(before);
  const to = captureMixerState(after);
  for (const id of Object.keys(to.inserts) as InsertId[]) {
    const old = from.inserts[id];
    const now = to.inserts[id];
    if (!old || !now) continue;
    for (const slotId of Object.keys(now.fx) as SlotId[]) if (!old.fx[slotId]) delete now.fx[slotId];
    for (const slotId of Object.keys(old.fx) as SlotId[]) if (!now.fx[slotId]) delete old.fx[slotId];
  }
  for (const id of Object.keys(to.inserts) as InsertId[]) if (!from.inserts[id]) delete to.inserts[id];
  for (const id of Object.keys(from.inserts) as InsertId[]) if (!to.inserts[id]) delete from.inserts[id];
  return { from, to };
}

/** Effects added to or removed from a track that both states have. */
function effectChanges(
  old: Insert,
  now: Insert,
  plugins: PluginInfoResolver,
  out: ProjectChanges,
  counts: { added: number; removed: number },
): void {
  const name = now.name;
  const effectName = (pluginId: string) => plugins(pluginId)?.name ?? pluginId;
  const oldSlots = new Set(old.fx.map((slot) => slot.id));
  const nowSlots = new Set(now.fx.map((slot) => slot.id));
  for (const slot of now.fx) {
    if (oldSlots.has(slot.id)) continue;
    counts.added++;
    out.lines.push(`${name}: effect added (${effectName(slot.plugin.pluginId)})`);
  }
  for (const slot of old.fx) {
    if (nowSlots.has(slot.id)) continue;
    counts.removed++;
    out.lines.push(`${name}: effect removed (${effectName(slot.plugin.pluginId)})`);
  }
}

function mixerChanges(before: Project, after: Project, plugins: PluginInfoResolver, out: ProjectChanges): void {
  if (before.mixer === after.mixer) return;
  const faderTexts: string[] = [];
  const effects = { added: 0, removed: 0 };
  for (const id of after.mixer.order) {
    const now = after.mixer.inserts[id];
    const old = before.mixer.inserts[id];
    if (!now) continue;
    if (!old) {
      out.parts.push(`new mixer track ${quote(now.name)}`);
      out.lines.push(`New mixer track ${quote(now.name)}`);
      continue;
    }
    if (Math.abs(old.volume - now.volume) > SAME_WITHIN) {
      const delta = decibelChange(old.volume, now.volume);
      faderTexts.push(delta ? `${now.name} ${delta}` : `${now.name} fader`);
    }
    effectChanges(old, now, plugins, out, effects);
  }
  for (const id of before.mixer.order) {
    const old = before.mixer.inserts[id];
    if (old && !after.mixer.inserts[id]) {
      out.parts.push(`removed mixer track ${quote(old.name)}`);
      out.lines.push(`Removed mixer track ${quote(old.name)}`);
    }
  }
  const { from, to } = sharedMixerStates(before, after);
  const differences = diffMixerStates(after, from, to, plugins);
  out.lines.push(...differences.map((difference) => difference.text));
  const isFader = (text: string) => /: fader /.test(text);
  const otherSettings = differences.filter((difference) => !isFader(difference.text)).length;
  if (effects.added > 0) out.parts.push(`+${plural(effects.added, 'effect')}`);
  if (effects.removed > 0) out.parts.push(`−${plural(effects.removed, 'effect')}`);
  if (faderTexts.length === 0 && otherSettings === 0) return;
  const named = faderTexts.slice(0, MAX_NAMED_TRACKS);
  const hidden = faderTexts.length - named.length + otherSettings;
  const tail = hidden > 0 ? (named.length > 0 ? ` and ${hidden} more` : `${plural(hidden, 'setting')} changed`) : '';
  out.parts.push(`mixer: ${named.join(', ')}${tail}`);
}

function sampleChanges(before: Project, after: Project, out: ProjectChanges): void {
  if (before.samples === after.samples) return;
  const added = Object.keys(after.samples).filter((id) => !before.samples[id as keyof typeof before.samples]).length;
  const removed = Object.keys(before.samples).filter((id) => !after.samples[id as keyof typeof after.samples]).length;
  if (added > 0) out.parts.push(`+${plural(added, 'sample')}`);
  if (removed > 0) out.parts.push(`−${plural(removed, 'sample')}`);
  if (added > 0) out.lines.push(`${plural(added, 'sample')} added`);
  if (removed > 0) out.lines.push(`${plural(removed, 'sample')} removed`);
}

/** The parts of a project not covered above: a change there is named once, without detail. */
const OTHER_PARTS: ReadonlyArray<readonly [keyof Project, string]> = [
  ['chords', 'chords'],
  ['lyrics', 'lyrics'],
  ['launcher', 'clip launcher'],
  ['controllers', 'controller links'],
  ['dj', 'DJ mix'],
  ['reference', 'reference track'],
  ['mixSnapshots', 'mixer snapshots'],
];

function otherChanges(before: Project, after: Project, out: ProjectChanges): void {
  for (const [key, label] of OTHER_PARTS) {
    if (before[key] === after[key] || sameData(before[key], after[key])) continue;
    out.parts.push(label);
    out.lines.push(`The ${label} changed`);
  }
}

/** What changed from `before` to `after`. `plugins` names effect parameters in the full list (default: ids only). */
export function describeProjectChanges(
  before: Project,
  after: Project,
  plugins: PluginInfoResolver = noPlugins,
): ProjectChanges {
  const out: ProjectChanges = { parts: [], lines: [] };
  songChanges(before, after, out);
  patternChanges(before, after, out);
  clipChanges(before, after, out);
  noteChanges(before, after, out);
  channelChanges(before, after, out);
  mixerChanges(before, after, plugins, out);
  sampleChanges(before, after, out);
  otherChanges(before, after, out);
  return out;
}

/** The phrases as one line ("+3 clips, mixer: Kick −2.0 dB, new pattern 'Drop 2'"), the rest counted. */
export function summarizeChanges(parts: readonly string[], maxParts = MAX_SUMMARY_PARTS): string {
  if (parts.length === 0) return 'No changes';
  const shown = parts.slice(0, maxParts);
  const more = parts.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${plural(more, 'other change')}` : shown.join(', ');
}
