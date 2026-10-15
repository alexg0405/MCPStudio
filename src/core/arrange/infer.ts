/**
 * Reading an existing song the way the arranger needs it: its sections (from the markers, else from
 * where what plays changes), each section's energy (which parts play and how busy they are), fills
 * that sit on their own track on top of the groove, and the transition sounds and crashes already
 * there (so `develop` doesn't add a second riser where one is).
 */
import type { FxKind } from '../model/fx';
import { parseFxName } from '../model/fx';
import type { ChannelId, ClipId, LaneId, MarkerId, PatternClip, PatternId, Project, Tick } from '../model/types';
import { mutedLanes, songLength } from '../query/playlist';
import { songSections } from '../query/sections';
import { ticksPerBar } from '../time/ppq';
import type { VariantEnv } from './fills';
import { lengthOfPattern, playedNotes, silentChannels, toNoteSet } from './notes';
import type { SectionCaps } from './phrases';
import { isBassRole, isDrumRole, isMusicRole, noteRole } from './roles';
import { roleFromName, type SectionRole } from './sections';

export interface InferredSection {
  name: string;
  role: SectionRole;
  from: Tick;
  to: Tick;
  bars: number;
  energy: number;
  markerId: MarkerId | null;
  caps: SectionCaps;
  /** The shortest drum or bass loop playing, in bars (0: none). */
  loopBars: number;
}

const BEAT = 960;

/** Pattern clips that play (not muted, on a playing track, of a pattern that exists). */
function audiblePatternClips(p: Project): PatternClip[] {
  const off = mutedLanes(p.playlist);
  return Object.values(p.playlist.clips).filter(
    (c): c is PatternClip => c.kind === 'pattern' && !c.muted && !off.has(c.laneId) && !!p.patterns[c.patternId],
  );
}

/** How full a stretch of the song is, 1–5: kick, backbeat, hats, bass, how many music parts, how busy. */
export function estimateEnergy(p: Project, from: Tick, to: Tick, env: VariantEnv): number {
  const bar = ticksPerBar(p.transport.timeSig);
  const bars = Math.max(1, (to - from) / bar);
  const notes = playedNotes(p, from, to);
  let kick = 0;
  let snare = 0;
  let hats = 0;
  let perc = 0;
  let bass = 0;
  const music = new Set<ChannelId>();
  for (const n of notes) {
    const cr = env.roles.get(n.channelId) ?? 'other';
    const r = noteRole(cr, n.key);
    if (r === 'kick') kick++;
    else if (r === 'snare' || r === 'clap' || r === 'rim') snare++;
    else if (r === 'hat' || r === 'open-hat') hats++;
    else if (r === 'perc' || r === 'tom') perc++;
    if (isBassRole(cr)) bass++;
    if (isMusicRole(cr)) music.add(n.channelId);
  }
  const per = (x: number) => x / bars;
  let score = 0;
  if (per(kick) >= 0.5) score += 1.2;
  if (per(snare) >= 0.5) score += 0.6;
  if (per(hats) >= 4) score += 0.5;
  else if (per(hats) >= 1.5) score += 0.25;
  if (per(hats) >= 12) score += 0.2;
  if (per(perc) >= 2) score += 0.2;
  if (per(bass) >= 0.5) score += 1;
  score += music.size >= 3 ? 0.8 : music.size === 2 ? 0.5 : music.size === 1 ? 0.3 : 0;
  if (per(notes.length) > 24) score += 0.3;
  return Math.min(5, Math.max(1, 1 + Math.round((Math.max(0, score - 0.6) / 4.2) * 4)));
}

/** What the clips playing in [from, to) can play, and their shortest drum or bass loop. */
export function sectionContent(p: Project, from: Tick, to: Tick, env: VariantEnv): { caps: SectionCaps; loopBars: number } {
  const bar = ticksPerBar(p.transport.timeSig);
  const caps: SectionCaps = { drums: false, hats: false, openHat: false, slide: false };
  let loopBars = 0;
  // How long each pattern plays here: a loop plays at least twice (a one-off fill isn't a loop).
  const played = new Map<PatternId, Tick>();
  for (const c of audiblePatternClips(p))
    if (c.start < to && c.start + c.length > from)
      played.set(c.patternId, (played.get(c.patternId) ?? 0) + Math.min(to, c.start + c.length) - Math.max(from, c.start));
  for (const c of audiblePatternClips(p)) {
    if (c.start >= to || c.start + c.length <= from) continue;
    let drums = false;
    let bass = false;
    for (const [cid, list] of toNoteSet(p.patterns[c.patternId]!.notes)) {
      const cr = env.roles.get(cid) ?? 'other';
      for (const n of list) {
        const r = noteRole(cr, n.key);
        if (isDrumRole(r)) drums = true;
        if (r === 'hat') caps.hats = true;
        if (cr === '808') caps.slide = true;
        if (isBassRole(cr)) bass = true;
      }
    }
    caps.drums ||= drums;
    const len = lengthOfPattern(p, c.patternId);
    if ((drums || bass) && (played.get(c.patternId) ?? 0) >= 2 * len) {
      const bars = len / bar;
      if (bars > 0 && (loopBars === 0 || bars < loopBars)) loopBars = bars;
    }
  }
  if (caps.hats) caps.openHat = [...env.roles.values()].includes('open-hat') || [...env.roles.values()].includes('kit');
  return { caps, loopBars };
}

function roleFor(name: string, energy: number, index: number, count: number): SectionRole {
  const named = roleFromName(name);
  if (named) return named;
  if (index === 0 && energy <= 2) return 'intro';
  if (index === count - 1 && energy <= 2) return 'outro';
  if (energy >= 4) return 'drop';
  if (energy <= 2) return 'break';
  return 'verse';
}

/**
 * The song's sections within [from, to): its markers, or where the set of patterns playing changes
 * (parts shorter than 2 bars join the one before). Each gets its part, energy and content.
 */
export function inferSections(p: Project, env: VariantEnv, range?: { from: Tick; to: Tick }): InferredSection[] {
  const bar = ticksPerBar(p.transport.timeSig);
  const end = songLength(p);
  const from = Math.max(0, range?.from ?? 0);
  const to = Math.min(range?.to ?? end, end);
  if (to <= from) return [];
  let spans: { name: string; from: Tick; to: Tick; markerId: MarkerId | null }[] = [];
  const marks = songSections(p);
  if (marks.length) {
    if (marks[0]!.from > 0) spans.push({ name: 'Start', from: 0, to: marks[0]!.from, markerId: null });
    for (const m of marks) spans.push({ name: m.name, from: m.from, to: m.to, markerId: m.markerId });
  } else {
    // Where what plays changes, bar by bar.
    const clips = audiblePatternClips(p);
    const sig = (b: number) => {
      const t0 = b * bar;
      const t1 = t0 + bar;
      const roots = new Set<string>();
      for (const c of clips) if (c.start < t1 && c.start + c.length > t0) roots.add(p.patterns[c.patternId]?.derived?.from ?? c.patternId);
      return [...roots].sort().join();
    };
    const count = Math.ceil(end / bar);
    let start = 0;
    let current = sig(0);
    for (let b = 1; b <= count; b++) {
      const s = b < count ? sig(b) : '\u0000end';
      if (s === current) continue;
      spans.push({ name: `Part ${spans.length + 1}`, from: start * bar, to: b * bar, markerId: null });
      start = b;
      current = s;
    }
    // Parts shorter than 2 bars join the one before.
    const merged: typeof spans = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.to - s.from < 2 * bar) last.to = s.to;
      else merged.push({ ...s });
    }
    spans = merged.map((s, i) => ({ ...s, name: `Part ${i + 1}` }));
  }
  const clipped = spans
    .map((s) => ({ ...s, from: Math.max(s.from, from), to: Math.min(s.to, to) }))
    .filter((s) => s.to > s.from);
  return clipped.map((s, i) => {
    const energy = estimateEnergy(p, s.from, s.to, env);
    const content = sectionContent(p, s.from, s.to, env);
    return {
      name: s.name,
      role: roleFor(s.name, energy, i, clipped.length),
      from: s.from,
      to: s.to,
      bars: Math.max(1, Math.round((s.to - s.from) / bar)),
      energy,
      markerId: s.markerId,
      ...content,
    };
  });
}

/** A fill that plays from its own clip: drums only, short (or named a fill), its hits in its second half. */
export interface FillClip {
  clipId: ClipId;
  laneId: LaneId;
  patternId: PatternId;
  /** Where its hits start (on the beat) and where the clip ends. */
  from: Tick;
  to: Tick;
}

export function fillLikeClips(p: Project, env: VariantEnv): FillClip[] {
  const bar = ticksPerBar(p.transport.timeSig);
  const out: FillClip[] = [];
  for (const c of audiblePatternClips(p)) {
    const pat = p.patterns[c.patternId]!;
    const len = lengthOfPattern(p, c.patternId);
    const set = toNoteSet(pat.notes);
    let total = 0;
    let drums = 0;
    let late = 0;
    let first = Infinity;
    for (const [cid, list] of set) {
      const cr = env.roles.get(cid) ?? 'other';
      for (const n of list) {
        total++;
        if (isDrumRole(noteRole(cr, n.key))) drums++;
        if (n.tick >= len / 2) late++;
        first = Math.min(first, n.tick);
      }
    }
    const short = len <= bar || /\b(fill|roll)\b/i.test(pat.name);
    if (total < 4 || drums !== total || !short || late < total * 0.7 || c.length > len) continue;
    const at = c.start + Math.max(0, first - c.offset);
    out.push({ clipId: c.id, laneId: c.laneId, patternId: c.patternId, from: Math.floor(at / BEAT) * BEAT, to: c.start + c.length });
  }
  return out;
}

/** Fills played on top of the groove: the clips on other tracks whose drums play under them. */
export function layeredFills(p: Project, env: VariantEnv): { fill: FillClip; under: ClipId[] }[] {
  const fills = fillLikeClips(p, env);
  const fillIds = new Set(fills.map((f) => f.clipId));
  const silent = silentChannels(p);
  const out: { fill: FillClip; under: ClipId[] }[] = [];
  for (const f of fills) {
    const under = new Set<ClipId>();
    for (const n of playedNotes(p, f.from, f.to)) {
      if (fillIds.has(n.clipId) || n.laneId === f.laneId || silent.has(n.channelId)) continue;
      if (isDrumRole(noteRole(env.roles.get(n.channelId) ?? 'other', n.key))) under.add(n.clipId);
    }
    if (under.size) out.push({ fill: f, under: [...under] });
  }
  return out;
}

export type ExistingFxKind = FxKind | 'crash';

const FX_WORDS: [RegExp, FxKind][] = [
  [/rev(erse)?\s*(crash|cymbal)|reverse/i, 'reverse-crash'],
  [/down\s*-?\s*lift|downsweep|down\s*sweep/i, 'downlifter'],
  [/sub\s*-?\s*drop|\bdrop\s*fx/i, 'sub-drop'],
  [/riser|uplift|up\s*-?\s*lift|build\s*fx|sweep\s*up/i, 'riser'],
  [/impact|boom|\bhit\b/i, 'impact'],
  [/whoosh|swoosh|sweep/i, 'whoosh'],
];

/** The FX a name says it is ("Riser", "Rev crash", "Impact 2"), if any. */
export function fxKindFromName(name: string): FxKind | undefined {
  return FX_WORDS.find(([re]) => re.test(name))?.[1];
}

const endsAtX = (k: FxKind) => k === 'riser' || k === 'reverse-crash';

/**
 * Transition sounds and crashes already in the song: where a riser or reverse crash ends, where an
 * impact, sub drop, downlifter, whoosh or crash starts (audio clips of FX sounds or named so, notes on
 * FX channels, crash hits).
 */
export function existingFx(p: Project, env: VariantEnv): { kind: ExistingFxKind; at: Tick }[] {
  const out: { kind: ExistingFxKind; at: Tick }[] = [];
  const off = mutedLanes(p.playlist);
  const silent = silentChannels(p);
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'audio' || c.muted || off.has(c.laneId) || silent.has(c.channelId)) continue;
    const ch = p.channels[c.channelId];
    if (!ch || ch.kind !== 'audioClip') continue;
    const src = p.samples[ch.sampleId]?.source;
    const gen = src?.kind === 'builtin' ? src.generator : '';
    const kind: ExistingFxKind | undefined =
      parseFxName(gen)?.kind ?? (/crash/i.test(ch.name) && !/rev/i.test(ch.name) ? 'crash' : fxKindFromName(ch.name)) ?? (gen.endsWith('/crash') ? 'crash' : undefined);
    if (!kind) continue;
    out.push({ kind, at: kind !== 'crash' && endsAtX(kind) ? c.start + c.length : c.start });
  }
  for (const n of playedNotes(p)) {
    const cr = env.roles.get(n.channelId) ?? 'other';
    if (noteRole(cr, n.key) === 'crash') {
      out.push({ kind: 'crash', at: n.tick });
      continue;
    }
    if (cr !== 'fx') continue;
    const ch = p.channels[n.channelId];
    const kind = fxKindFromName(ch?.name ?? '') ?? fxKindFromName(p.patterns[n.patternId]?.name ?? '');
    if (!kind) continue;
    out.push({ kind, at: endsAtX(kind) ? n.tick + n.length : n.tick });
  }
  // A pattern named for an FX ("Impact", "Riser") is one where it plays.
  for (const c of audiblePatternClips(p)) {
    const kind = fxKindFromName(p.patterns[c.patternId]!.name);
    if (kind) out.push({ kind, at: endsAtX(kind) ? c.start + c.length : c.start });
  }
  return out.sort((a, b) => a.at - b.at);
}
