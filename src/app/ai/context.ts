/**
 * The project as the AI sees it each turn: the song, every channel with its plugin settings, the
 * mixer (levels, routes, effects with their settings, sidechains), patterns, the playlist and what is
 * selected. Ids are included so actions can refer to things exactly; only settings that differ from
 * the plugin defaults are listed.
 */
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { gainToDecibels } from '@core/model/fader';
import { kitPiece } from '@core/model/kit';
import { MASTER, type Channel, type ChannelId, type Insert, type Pattern, type PluginInstance, type PatternId, type Project } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import { laneRuns, patternSpans, songCheck } from '@core/query/arrangement';
import { songLength } from '@core/query/playlist';
import { patternLength } from '@core/query/queries';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { ParamSpec, ParamSpecs } from '@agstudio/sdk';
import { arrangementLines, derivedLabel } from '../arrange/summary';
import { musicLibraryLines } from '../dj/library';
import { deckLines } from './ops/decks';
import { launcherLines } from './ops/launcher';
import { djLines } from '../dj/mix';
import { referenceLines } from '../reference/summary';
import { noteName } from '../assistant/context';
import { noteLines } from './note-lines';

export { noteLines };
import { recentFiles } from '../persistence/recent-files';
import type { ResolvedFocus } from './focus';
import { aiCommands } from './commands';
import type { Services } from '../services';

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const r2 = (v: number) => Math.round(v * 100) / 100;
const db = (gain: number) => (gain <= 0 ? '-inf dB' : `${r2(gainToDecibels(gain))} dB`);

/**
 * Size budget. The text grows with the project, so a very large one is shortened, the least important
 * parts first, until it fits. A project under the budget is never shortened (its text is unchanged).
 */
export const CONTEXT_BUDGET = 40_000;
const SHORT_NOTE = '(details shortened: the project is very large)';
/** Parameter values kept per plugin, and playlist runs kept per track, when shortened. */
const SHORT_VALUES = 3;
const SHORT_RUNS = 8;

/** What a render shortens. Each step in `STEPS` adds one more part, in the order the budget cuts them. */
interface Shortening {
  /** Notes of patterns other than the current one: a count and pitch range instead of per channel. */
  otherNotes: boolean;
  /** Plugin settings beyond the first few: names only. */
  settings: boolean;
  /** Playlist runs beyond the first few per track. */
  runs: boolean;
  /** Channels that play nowhere: one line. */
  silentChannels: boolean;
  /** Patterns beyond the most relevant ones: id and name only. */
  patternsCompact: boolean;
  /** Channels beyond the ones the full patterns use (and the selected one): one line each. */
  channelsCompact: boolean;
}
const FULL: Shortening = {
  otherNotes: false,
  settings: false,
  runs: false,
  silentChannels: false,
  patternsCompact: false,
  channelsCompact: false,
};
const STEPS: Shortening[] = [
  FULL,
  { ...FULL, otherNotes: true },
  { ...FULL, otherNotes: true, settings: true },
  { ...FULL, otherNotes: true, settings: true, runs: true },
  { ...FULL, otherNotes: true, settings: true, runs: true, silentChannels: true },
  { ...FULL, otherNotes: true, settings: true, runs: true, silentChannels: true, patternsCompact: true },
  { ...FULL, otherNotes: true, settings: true, runs: true, silentChannels: true, patternsCompact: true, channelsCompact: true },
];

/** Patterns kept in full, and channels kept in full, when shortened. */
const FULL_PATTERNS = 60;
const FULL_CHANNELS = 80;

type Section = 'patterns' | 'channels' | 'mixer' | 'playlist';
/** One render: what it shortens, which sections it actually cut (only those say so), and the focus. */
interface Render {
  shorten: Shortening;
  cut: Set<Section>;
  focus: ResolvedFocus | null;
}
const fullRender = (focus: ResolvedFocus | null = null): Render => ({ shorten: FULL, cut: new Set(), focus });
/** The note under a section header, when the render cut that section. */
const cutNote = (r: Render, section: Section): string[] => (r.cut.has(section) ? [SHORT_NOTE] : []);

/** Settings that differ from the plugin's defaults, as `name value` (formatted in the param's unit). */
function paramSummary(s: Services, inst: PluginInstance, r: Render, section: Section): string {
  const def = s.plugins.get(inst.pluginId);
  if (!def) return 'plugin not installed';
  const specs = def.params as ParamSpecs;
  const out: { id: string; text: string }[] = [];
  for (const [id, spec] of Object.entries(specs) as [string, ParamSpec][]) {
    const v = inst.params[id];
    if (v === undefined || v === spec.default) continue;
    const value = `${spec.type === 'float' || spec.type === 'int' ? r2(Number(v)) : String(v)}${
      spec.type === 'float' && spec.unit && spec.unit !== '%' ? ` ${spec.unit}` : ''
    }`;
    out.push({ id, text: `${id} ${value}` });
  }
  if (out.length === 0) return 'defaults';
  if (!r.shorten.settings || out.length <= SHORT_VALUES) return out.map((x) => x.text).join(', ');
  r.cut.add(section);
  return out.map((x, i) => (i < SHORT_VALUES ? x.text : x.id)).join(', ');
}

/** Pitch range and count of a pattern's notes, for the patterns the song is not showing in detail. */
function noteSummary(p: Project, pattern: Pattern): string {
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of p.channelOrder) {
    for (const n of Object.values(pattern.notes[id] ?? {})) {
      count++;
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
    }
  }
  if (count === 0) return 'empty';
  const range = lo === hi ? noteName(lo) : `${noteName(lo)}–${noteName(hi)}`;
  return `${count} note${count === 1 ? '' : 's'}, ${range}`;
}

/** Channels with notes in a pattern the song plays, or with a clip on the playlist. */
function channelsThatPlay(p: Project): Set<string> {
  const placed = patternSpans(p);
  const out = new Set<string>();
  for (const pid of placed.keys()) {
    const pat = p.patterns[pid];
    if (pat) for (const [ch, notes] of Object.entries(pat.notes)) if (Object.keys(notes ?? {}).length) out.add(ch);
  }
  for (const clip of Object.values(p.playlist.clips)) if (clip.kind !== 'pattern') out.add(clip.channelId);
  return out;
}

/** What a channel is, in one word for a compact line. */
function channelKind(s: Services, ch: Channel): string {
  if (ch.kind === 'instrument') return pluginName(s, ch.plugin.pluginId);
  return ch.kind === 'audioClip' ? 'audio clip' : 'automation';
}

/** The patterns that play inside the focus (the part the request is about), in song order. */
function focusPatterns(p: Project, focus: ResolvedFocus | null): PatternId[] {
  if (!focus) return [];
  if (focus.notes) return [focus.notes.patternId];
  const inside = new Set<PatternId>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern') continue;
    const inFocus = focus.clips ? focus.clips.has(c.id) : c.start < focus.to && c.start + c.length > focus.from;
    if (inFocus) inside.add(c.patternId);
  }
  return p.patternOrder.filter((pid) => inside.has(pid));
}

/**
 * The patterns kept in full when the project is shortened: the current one, then the ones playing in
 * the focus, then the most used on the playlist, up to `FULL_PATTERNS`.
 */
function fullPatterns(p: Project, current: PatternId | null, focus: ResolvedFocus | null): Set<PatternId> {
  const uses = new Map<PatternId, number>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind === 'pattern') uses.set(c.patternId, (uses.get(c.patternId) ?? 0) + 1);
  }
  const order = new Map(p.patternOrder.map((pid, i) => [pid, i] as const));
  const byUse = p.patternOrder
    .filter((pid) => (uses.get(pid) ?? 0) > 0)
    .sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || order.get(a)! - order.get(b)!);
  const picked = new Set<PatternId>();
  for (const pid of [...(current ? [current] : []), ...focusPatterns(p, focus), ...byUse]) {
    if (picked.size >= FULL_PATTERNS) break;
    if (p.patterns[pid]) picked.add(pid);
  }
  return picked;
}

/**
 * The channels kept in full when shortened: the selected one, then the channels with notes in the full
 * patterns (in rack order), up to `FULL_CHANNELS`.
 */
function fullChannels(p: Project, patterns: ReadonlySet<PatternId>, selected: ChannelId | null): Set<string> {
  const used = new Set<string>();
  for (const pid of patterns) {
    const pat = p.patterns[pid];
    if (pat) for (const [ch, notes] of Object.entries(pat.notes)) if (Object.keys(notes ?? {}).length) used.add(ch);
  }
  const picked = new Set<string>();
  if (selected && p.channels[selected]) picked.add(selected);
  for (const id of p.channelOrder) {
    if (picked.size >= FULL_CHANNELS) break;
    if (used.has(id)) picked.add(id);
  }
  return picked;
}

function pluginName(s: Services, pluginId: string): string {
  return s.plugins.get(pluginId)?.name ?? `${pluginId} (missing)`;
}

/** "automation of “Cutoff · 3xOsc”: 3 points, 400 Hz → 8.0 kHz" (values as the control shows them). */
function automationSummary(s: Services, p: Project, ch: Extract<Channel, { kind: 'automation' }>): string {
  const info = (id: string) => {
    const def = s.plugins.get(id);
    return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
  };
  const target = ch.target;
  if (!target) return `automation that drives nothing yet: ${ch.points.length} points`;
  const what = targetName(p, target, info) ?? 'a control that no longer exists';
  const res = resolveTarget(p, target, (id) => s.plugins.get(id)?.params as ParamSpecs | undefined, ch.range);
  const pts = ch.points;
  const span =
    res && pts.length > 0
      ? `, ${formatAutomationValue(res, target, pts[0]!.value)} → ${formatAutomationValue(res, target, pts[pts.length - 1]!.value)}`
      : '';
  return `automation of “${what}”: ${pts.length} point${pts.length === 1 ? '' : 's'}${span}`;
}

/** The app around the project: the file, what is switched on, what Undo would revert. */
function appLine(s: Services): string {
  const file = s.files.store.getState();
  const h = s.history.status();
  const on = aiCommands(s)
    .filter((d) => d.checked && s.commands.isChecked(d.id))
    .map((d) => d.title);
  const recent = recentFiles()
    .slice(0, 8)
    .map((f) => `"${f.name.replace(/\.agproj$/i, '')}"`);
  const parts = [
    `file "${file.name}"${h.dirty ? ' (unsaved changes)' : ' (saved)'}`,
    recent.length ? `recent projects: ${recent.join(', ')}` : '',
    on.length ? `on right now: ${on.join(', ')}` : 'no toggles on',
    h.undoLabel ? `undo would revert “${h.undoLabel}”` : 'nothing to undo',
  ];
  return `App: ${parts.filter(Boolean).join('; ')}.`;
}

function channelLine(s: Services, p: Project, ch: Channel, index: number, r: Render): string {
  const head = `${index}. "${ch.name}" ${ch.id}`;
  const flags = [ch.muted ? 'muted' : '', ch.solo ? 'solo' : ''].filter(Boolean).join(', ');
  if (ch.kind === 'automation') return `${head} — ${automationSummary(s, p, ch)}${flags ? ` (${flags})` : ''}`;
  const out = `→ ${insertLabel(p, ch.output)}${ch.output === MASTER ? '' : ` "${p.mixer.inserts[ch.output]?.name ?? ''}"`}`;
  const mix = `vol ${db(ch.volume)}, pan ${r2(ch.pan)}${ch.kind === 'instrument' && ch.pitch ? `, pitch ${ch.pitch} ct` : ''}${
    flags ? `, ${flags}` : ''
  }`;
  if (ch.kind === 'audioClip') {
    const edits = [
      ch.pitch ? `pitch ${ch.pitch} ct` : '',
      ch.reverse ? 'reversed' : '',
      ch.stretch && ch.stretch !== 'off' ? `follows the tempo (${ch.stretch})` : '',
      ch.sourceBpm ? `recorded at ${ch.sourceBpm} BPM` : '',
    ].filter(Boolean);
    return `${head} — audio clip "${p.samples[ch.sampleId]?.name ?? '?'}"${edits.length ? ` (${edits.join(', ')})` : ''}; ${mix}; ${out}`;
  }
  const sample = ch.plugin.samples?.main ? p.samples[ch.plugin.samples.main] : undefined;
  const kit = sample?.source.kind === 'builtin' ? kitPiece(sample.source.generator)?.name : sample?.name;
  return `${head} — ${pluginName(s, ch.plugin.pluginId)} (${ch.plugin.pluginId})${kit ? ` sample "${kit}"` : ''}; ${mix}; ${out}\n   settings: ${paramSummary(s, ch.plugin, r, 'channels')}`;
}

function insertLines(s: Services, p: Project, ins: Insert, r: Render): string[] {
  const label = insertLabel(p, ins.id);
  const flags = [ins.muted ? 'muted' : '', ins.solo ? 'solo' : ''].filter(Boolean).join(', ');
  const routes =
    ins.id === MASTER
      ? ''
      : ins.routes.length === 0
        ? '; routed nowhere (silent)'
        : `; routes → ${ins.routes
            .map((route) => `${insertLabel(p, route.to)} ${db(route.level)}${route.pre ? ' pre-fader' : ''}`)
            .join(', ')}`;
  const lines = [
    `- ${label}${ins.id === MASTER ? '' : ` "${ins.name}"`} ${ins.id}: vol ${db(ins.volume)}, pan ${r2(ins.pan)}${flags ? `, ${flags}` : ''}${routes}`,
  ];
  ins.fx.forEach((slot, i) => {
    const sc = slot.sidechain ? `, sidechain from ${insertLabel(p, slot.sidechain)}` : '';
    lines.push(
      `   fx ${i + 1}: ${pluginName(s, slot.plugin.pluginId)} (${slot.plugin.pluginId}) ${slot.id}${slot.enabled ? '' : ' BYPASSED'}, mix ${Math.round(
        slot.mix * 100,
      )}%${sc}; settings: ${paramSummary(s, slot.plugin, r, 'mixer')}`,
    );
  });
  return lines;
}

/** Each pattern: its channels with note counts, and where it plays in the song. */
export function patternLines(
  p: Project,
  r: Render = fullRender(),
  current: PatternId | null = null,
  full: ReadonlySet<PatternId> | null = null,
): string[] {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const spans = patternSpans(p);
  const lines: string[] = [];
  for (const pid of p.patternOrder) {
    const pat = p.patterns[pid];
    if (!pat) continue;
    if (full && pid !== current && !full.has(pid)) {
      r.cut.add('patterns');
      lines.push(`- ${pat.id} · "${pat.name}"`);
      continue;
    }
    const bars = patternLength(pat, ts) / bar;
    const used = p.channelOrder
      .filter((c) => Object.keys(pat.notes[c] ?? {}).length > 0)
      .map((c) => `${p.channels[c]?.name ?? c} (${Object.keys(pat.notes[c] ?? {}).length})`);
    const summarise = r.shorten.otherNotes && pid !== current && used.length > 0;
    if (summarise) r.cut.add('patterns');
    const content = summarise ? noteSummary(p, pat) : used.length ? used.join(', ') : 'empty';
    const at = spans.get(pid);
    const plays = at?.length ? `plays at ${at.map((s) => barSpan(s.from, s.to, ts)).join(', ')}` : 'not in the song';
    const variant = derivedLabel(p, pat);
    lines.push(
      `- "${pat.name}" ${pat.id}, ${r2(bars)} bar${bars === 1 ? '' : 's'}${variant ? ` (${variant})` : ''}: ${content}; ${plays}`,
    );
  }
  return lines;
}

/** Runs per track beyond which the listing says how many more there are (it never cuts silently). */
const MAX_RUNS = 120;

/**
 * The playlist: every track's clips, back-to-back repeats as one run ("“Drop” ×8 bars 37–52"), split
 * at the marker sections, which are listed first. Clip ids for short runs; longer runs are found by
 * track and bar.
 */
export function playlistLines(p: Project, r: Render = fullRender()): string[] {
  const ts = p.transport.timeSig;
  const sections = songSections(p);
  const end = songLength(p);
  const cap = r.shorten.runs ? SHORT_RUNS : MAX_RUNS;
  const lines = [
    `Playlist (song mode plays it). Bar ranges are 1-based and inclusive ("bars 81–112" is 32 bars)${
      end ? `; the song is ${end / ticksPerBar(ts)} bars long` : ''
    }.`,
    sections.length
      ? `Sections (markers): ${sections.map((x) => `"${x.name}" ${barSpan(x.from, x.to, ts)} ${x.markerId}`).join('; ')}`
      : 'Sections (markers): none',
  ];
  if (Object.keys(p.playlist.clips).length === 0) {
    lines.push('The playlist is empty.');
    return lines;
  }
  const cuts = sections.map((x) => x.from);
  p.playlist.laneOrder.forEach((laneId, i) => {
    const runs = laneRuns(p, laneId, cuts);
    if (!runs.length) return;
    const lane = p.playlist.lanes[laneId];
    const name = lane && !/^Track \d+$/.test(lane.name) ? ` "${lane.name}"` : '';
    const flags = [lane?.muted ? 'muted' : '', lane?.solo ? 'solo' : ''].filter(Boolean).join(', ');
    if (runs.length > cap && r.shorten.runs) r.cut.add('playlist');
    const parts = runs.slice(0, cap).map((run) => {
      const clip = p.playlist.clips[run.clipIds[0]!]!;
      let what: string;
      if (clip.kind === 'pattern') what = `"${p.patterns[clip.patternId]?.name ?? '?'}"`;
      else if (clip.kind === 'automation') what = `automation "${p.channels[clip.channelId]?.name ?? '?'}"`;
      else {
        const edits = [
          clip.gain !== undefined ? `gain ${db(clip.gain)}` : '',
          clip.fadeIn ? `fade-in ${Math.round(clip.fadeIn * 1000)} ms` : '',
          clip.fadeOut ? `fade-out ${Math.round(clip.fadeOut * 1000)} ms` : '',
        ].filter(Boolean);
        what = `audio "${p.channels[clip.channelId]?.name ?? '?'}"${edits.length ? ` (${edits.join(', ')})` : ''}`;
      }
      const ids = run.count <= 3 ? ` ${run.clipIds.join(', ')}` : '';
      const extra = [run.muted ? 'muted' : '', run.stacked ? `STACKED: plays ${run.stacked + 1}× here` : ''].filter(Boolean);
      return `${what}${run.count > 1 ? ` ×${run.count}` : ''} ${barSpan(run.from, run.to, ts)}${extra.length ? ` (${extra.join(', ')})` : ''}${ids}`;
    });
    const more =
      runs.length > cap ? `; … +${runs.length - cap} more up to ${barSpan(runs[runs.length - 1]!.from, runs[runs.length - 1]!.to, ts)}` : '';
    lines.push(`- Track ${i + 1}${name}${flags ? ` (${flags})` : ''}: ${parts.join('; ')}${more}`);
  });
  if (r.cut.has('playlist')) lines.splice(2, 0, SHORT_NOTE);
  return lines;
}

/** Problems in the arrangement, in plain words with the action that fixes them. */
export function songCheckLines(p: Project): string[] {
  const ts = p.transport.timeSig;
  const lane = (id: string) => `Track ${p.playlist.laneOrder.indexOf(id as never) + 1}`;
  const out: string[] = [];
  for (const issue of songCheck(p)) {
    switch (issue.kind) {
      case 'stacked':
        out.push(
          `- ${barSpan(issue.from, issue.to, ts)} play the same clips ${issue.times} times at once (${issue.lanes.map(lane).join(', ')}): that part is ${issue.times}× too loud. The tidy action removes the copies.`,
        );
        break;
      case 'doubled':
        out.push(
          `- "${p.patterns[issue.patternId]?.name ?? '?'}" overlaps itself at ${barSpan(issue.from, issue.to, ts)} (it plays twice there).`,
        );
        break;
      case 'repeats':
        out.push(
          `- "${p.patterns[issue.patternId]?.name ?? '?'}" repeats ${issue.count} times unchanged on ${lane(issue.laneId)} (${barSpan(issue.from, issue.to, ts)}).`,
        );
        break;
      case 'unnamedLanes':
        out.push(`- ${issue.count} track${issue.count === 1 ? ' has' : 's have'} no name ("Track N"): the track action names them.`);
        break;
      case 'duplicateAutomation':
        out.push(`- ${issue.count} automation channels "${issue.name}" are the same curve: tidy merges them.`);
        break;
    }
  }
  return out;
}

/**
 * The project text, within `CONTEXT_BUDGET` characters where it can be. Each step in `STEPS` shortens one
 * more part; the first step that fits is the answer, so a project under the budget is rendered in full.
 */
export function projectContext(s: Services, focus: ResolvedFocus | null = null): string {
  let text = '';
  for (const shorten of STEPS) {
    text = renderContext(s, { shorten, cut: new Set(), focus });
    if (text.length <= CONTEXT_BUDGET) break;
  }
  return text;
}

function renderContext(s: Services, r: Render): string {
  const p = s.doc.getState().project;
  const view = s.view.getState();
  const session = s.session.getState();
  const ts = p.transport.timeSig;
  const lines: string[] = [];
  const key = p.transport.key ? `${NOTE[p.transport.key.root]} ${p.transport.key.scale}` : 'not set';
  const current = view.currentPatternId ? p.patterns[view.currentPatternId] : undefined;
  lines.push(
    `Song: ${p.transport.bpm} BPM, ${ts.num}/${ts.den}, swing ${Math.round(p.transport.swing * 100)}%, key ${key}. Mode: ${view.mode}. Current pattern: ${
      current ? `"${current.name}" ${current.id}` : 'none'
    }.`,
  );
  lines.push(appLine(s));

  const selected = session.selectedChannelId;
  const fullPats = r.shorten.patternsCompact ? fullPatterns(p, current?.id ?? null, r.focus) : null;
  const keep = r.shorten.channelsCompact && fullPats ? fullChannels(p, fullPats, selected) : null;
  const plays = r.shorten.silentChannels ? channelsThatPlay(p) : null;
  const channels: string[] = [];
  const silent: string[] = [];
  p.channelOrder.forEach((id, i) => {
    const ch = p.channels[id];
    if (!ch) return;
    if (plays && !plays.has(id) && id !== selected) silent.push(`#${i + 1} "${ch.name}" ${id}`);
    else if (keep && !keep.has(id)) {
      r.cut.add('channels');
      channels.push(`${i + 1} · ${id} · "${ch.name}" · ${channelKind(s, ch)}`);
    } else channels.push(channelLine(s, p, ch, i + 1, r));
  });
  if (silent.length) {
    r.cut.add('channels');
    channels.push(`Play nowhere (no notes in the song, no clips): ${silent.join(', ')}`);
  }
  if (p.channelOrder.length === 0) channels.push('(none)');
  lines.push('', 'Channels (channel rack order):', ...cutNote(r, 'channels'), ...channels);

  const mixer: string[] = [];
  const quiet: number[] = [];
  p.mixer.order.forEach((id, n) => {
    const ins = p.mixer.inserts[id];
    if (!ins) return;
    const used = p.channelOrder.some((c) => {
      const ch = p.channels[c];
      return ch && ch.kind !== 'automation' && ch.output === id;
    });
    const plain =
      id !== MASTER &&
      !used &&
      ins.fx.length === 0 &&
      ins.volume === 1 &&
      ins.pan === 0 &&
      !ins.muted &&
      ins.routes.length === 1 &&
      ins.routes[0]!.to === MASTER &&
      /^Insert \d+$/.test(ins.name) &&
      !Object.values(p.mixer.inserts).some((o) => o.routes.some((route) => route.to === id));
    if (plain) quiet.push(n);
    else mixer.push(...insertLines(s, p, ins, r));
  });
  if (quiet.length) mixer.push(`- Inserts ${quiet.join(', ')}: empty (default settings, routed to Master)`);
  lines.push('', 'Mixer tracks (number = position; channels feed the track shown after →):', ...cutNote(r, 'mixer'), ...mixer);

  const patterns = patternLines(p, r, current?.id ?? null, fullPats);
  lines.push('', 'Patterns:', ...cutNote(r, 'patterns'), ...patterns);
  if (current) {
    lines.push(
      `  Notes of the current pattern (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8):`,
    );
    lines.push(...noteLines(p, current));
  }

  lines.push('', ...playlistLines(p, r));
  const arrangement = arrangementLines(p);
  if (arrangement.length) lines.push(...arrangement);
  const djMix = djLines(p);
  if (djMix.length) lines.push('', ...djMix);
  const refLines = referenceLines(p);
  if (refLines.length) lines.push('', ...refLines);
  const music = musicLibraryLines(s);
  if (music.length) lines.push('', ...music);
  const live = deckLines(s);
  if (live.length) lines.push('', ...live);
  const jam = launcherLines(s);
  if (jam.length) lines.push('', ...jam);
  const check = songCheckLines(p);
  if (check.length) lines.push('', 'Song check (problems in the arrangement right now):', ...check);

  const sel = session.selectedChannelId ? p.channels[session.selectedChannelId] : undefined;
  const selIns = session.selectedInsertId ? p.mixer.inserts[session.selectedInsertId] : undefined;
  lines.push(
    '',
    `Selected: channel ${sel ? `"${sel.name}"` : 'none'}, mixer track ${selIns ? insertLabel(p, selIns.id) : 'none'}.`,
  );
  return lines.join('\n');
}
