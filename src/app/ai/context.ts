/**
 * The project as the AI sees it each turn: the song, every channel with its plugin settings, the
 * mixer (levels, routes, effects with their settings, sidechains), patterns, the playlist and what is
 * selected. Ids are included so actions can refer to things exactly; only settings that differ from
 * the plugin defaults are listed.
 */
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget } from '@core/automation/targets';
import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import { gainToDecibels } from '@core/model/fader';
import { kitPiece } from '@core/model/kit';
import { MASTER, type Channel, type Insert, type PluginInstance, type Project } from '@core/model/types';
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
import { djLines } from '../dj/mix';
import { channelSound, noteName } from '../assistant/context';
import { recentFiles } from '../persistence/recent-files';
import { aiCommands } from './commands';
import type { Services } from '../services';

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const r2 = (v: number) => Math.round(v * 100) / 100;
const db = (gain: number) => (gain <= 0 ? '-inf dB' : `${r2(gainToDecibels(gain))} dB`);

/** Settings that differ from the plugin's defaults, as `name value` (formatted in the param's unit). */
function paramSummary(s: Services, inst: PluginInstance): string {
  const def = s.plugins.get(inst.pluginId);
  if (!def) return 'plugin not installed';
  const specs = def.params as ParamSpecs;
  const out: string[] = [];
  for (const [id, spec] of Object.entries(specs) as [string, ParamSpec][]) {
    const v = inst.params[id];
    if (v === undefined || v === spec.default) continue;
    out.push(
      `${id} ${spec.type === 'float' || spec.type === 'int' ? r2(Number(v)) : String(v)}${
        spec.type === 'float' && spec.unit && spec.unit !== '%' ? ` ${spec.unit}` : ''
      }`,
    );
  }
  return out.length ? out.join(', ') : 'defaults';
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

function channelLine(s: Services, p: Project, ch: Channel, index: number): string {
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
  return `${head} — ${pluginName(s, ch.plugin.pluginId)} (${ch.plugin.pluginId})${kit ? ` sample "${kit}"` : ''}; ${mix}; ${out}\n   settings: ${paramSummary(s, ch.plugin)}`;
}

function insertLines(s: Services, p: Project, ins: Insert): string[] {
  const label = insertLabel(p, ins.id);
  const flags = [ins.muted ? 'muted' : '', ins.solo ? 'solo' : ''].filter(Boolean).join(', ');
  const routes =
    ins.id === MASTER
      ? ''
      : ins.routes.length === 0
        ? '; routed nowhere (silent)'
        : `; routes → ${ins.routes
            .map((r) => `${insertLabel(p, r.to)} ${db(r.level)}${r.pre ? ' pre-fader' : ''}`)
            .join(', ')}`;
  const lines = [
    `- ${label}${ins.id === MASTER ? '' : ` "${ins.name}"`} ${ins.id}: vol ${db(ins.volume)}, pan ${r2(ins.pan)}${flags ? `, ${flags}` : ''}${routes}`,
  ];
  ins.fx.forEach((slot, i) => {
    const sc = slot.sidechain ? `, sidechain from ${insertLabel(p, slot.sidechain)}` : '';
    lines.push(
      `   fx ${i + 1}: ${pluginName(s, slot.plugin.pluginId)} (${slot.plugin.pluginId}) ${slot.id}${slot.enabled ? '' : ' BYPASSED'}, mix ${Math.round(
        slot.mix * 100,
      )}%${sc}; settings: ${paramSummary(s, slot.plugin)}`,
    );
  });
  return lines;
}

const fmtStep = (steps: number) => String(Math.round(steps * 100) / 100);
const fmtVel = (v: number) => (Math.abs(v - 0.8) < 0.005 ? '' : `@${String(r2(v)).replace(/^0(?=\.)/, '')}`);

/** Each pattern: its channels with note counts, and where it plays in the song. */
export function patternLines(p: Project): string[] {
  const ts = p.transport.timeSig;
  const bar = ticksPerBar(ts);
  const spans = patternSpans(p);
  const lines: string[] = [];
  for (const pid of p.patternOrder) {
    const pat = p.patterns[pid];
    if (!pat) continue;
    const bars = patternLength(pat, ts) / bar;
    const used = p.channelOrder
      .filter((c) => Object.keys(pat.notes[c] ?? {}).length > 0)
      .map((c) => `${p.channels[c]?.name ?? c} (${Object.keys(pat.notes[c] ?? {}).length})`);
    const at = spans.get(pid);
    const plays = at?.length ? `plays at ${at.map((s) => barSpan(s.from, s.to, ts)).join(', ')}` : 'not in the song';
    const variant = derivedLabel(p, pat);
    lines.push(
      `- "${pat.name}" ${pat.id}, ${r2(bars)} bar${bars === 1 ? '' : 's'}${variant ? ` (${variant})` : ''}: ${used.length ? used.join(', ') : 'empty'}; ${plays}`,
    );
  }
  return lines;
}

/** A pattern's notes per channel, as the AI writes them. */
export function noteLines(p: Project, pattern: Project['patterns'][keyof Project['patterns']]): string[] {
  const lines: string[] = [];
  for (const id of p.channelOrder) {
    const ch = p.channels[id];
    const notes = Object.values(pattern.notes[id] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);
    if (!ch || notes.length === 0) continue;
    const sound = channelSound(p, ch);
    const drum = sound !== null && DRUM_SOUNDS.has(sound as BeatSound);
    const shown = notes.slice(0, 96).map((n) => {
      const step = fmtStep(n.tick / 240);
      return drum
        ? `${step}${fmtVel(n.velocity)}`
        : `${step}:${noteName(n.key)}/${fmtStep(n.length / 240)}${fmtVel(n.velocity)}`;
    });
    lines.push(`  ${ch.name}: ${shown.join(' ')}${notes.length > 96 ? ` … (+${notes.length - 96} more)` : ''}`);
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
export function playlistLines(p: Project): string[] {
  const ts = p.transport.timeSig;
  const sections = songSections(p);
  const end = songLength(p);
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
    const parts = runs.slice(0, MAX_RUNS).map((r) => {
      const clip = p.playlist.clips[r.clipIds[0]!]!;
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
      const ids = r.count <= 3 ? ` ${r.clipIds.join(', ')}` : '';
      const extra = [r.muted ? 'muted' : '', r.stacked ? `STACKED: plays ${r.stacked + 1}× here` : ''].filter(Boolean);
      return `${what}${r.count > 1 ? ` ×${r.count}` : ''} ${barSpan(r.from, r.to, ts)}${extra.length ? ` (${extra.join(', ')})` : ''}${ids}`;
    });
    const more =
      runs.length > MAX_RUNS ? `; … +${runs.length - MAX_RUNS} more up to ${barSpan(runs[runs.length - 1]!.from, runs[runs.length - 1]!.to, ts)}` : '';
    lines.push(`- Track ${i + 1}${name}${flags ? ` (${flags})` : ''}: ${parts.join('; ')}${more}`);
  });
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

export function projectContext(s: Services): string {
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

  lines.push('', 'Channels (channel rack order):');
  p.channelOrder.forEach((id, i) => {
    const ch = p.channels[id];
    if (ch) lines.push(channelLine(s, p, ch, i + 1));
  });
  if (p.channelOrder.length === 0) lines.push('(none)');

  lines.push('', 'Mixer tracks (number = position; channels feed the track shown after →):');
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
      !Object.values(p.mixer.inserts).some((o) => o.routes.some((r) => r.to === id));
    if (plain) quiet.push(n);
    else lines.push(...insertLines(s, p, ins));
  });
  if (quiet.length) lines.push(`- Inserts ${quiet.join(', ')}: empty (default settings, routed to Master)`);

  lines.push('', 'Patterns:', ...patternLines(p));
  if (current) {
    lines.push(
      `  Notes of the current pattern (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8):`,
    );
    lines.push(...noteLines(p, current));
  }

  lines.push('', ...playlistLines(p));
  const arrangement = arrangementLines(p);
  if (arrangement.length) lines.push(...arrangement);
  const djMix = djLines(p);
  if (djMix.length) lines.push('', ...djMix);
  const music = musicLibraryLines(s);
  if (music.length) lines.push('', ...music);
  const live = deckLines(s);
  if (live.length) lines.push('', ...live);
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
