/** Song sections: the span from each marker to the next one (the last runs to the song's end). */
import type { MarkerId, Project, Tick } from '../model/types';
import { ticksPerBar } from '../time/ppq';
import { songLength } from './playlist';

export interface Section {
  markerId: MarkerId;
  name: string;
  from: Tick;
  /** Exclusive end. */
  to: Tick;
}

/** Sections in song order. Of several markers at one position, the first (by name) names the section. */
export function songSections(p: Project): Section[] {
  const sorted = Object.values(p.playlist.markers).sort((a, b) => a.tick - b.tick || a.name.localeCompare(b.name));
  const bar = ticksPerBar(p.transport.timeSig);
  const end = songLength(p);
  const out: Section[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (i > 0 && sorted[i - 1]!.tick === m.tick) continue;
    const next = sorted.find((x) => x.tick > m.tick);
    out.push({ markerId: m.id, name: m.name, from: m.tick, to: next?.tick ?? Math.max(end, m.tick + bar) });
  }
  return out;
}

/** The section playing at `tick` (null before the first marker). */
export function sectionAt(p: Project, tick: Tick): Section | null {
  return songSections(p).find((x) => x.from <= tick && tick < x.to) ?? null;
}

/** The section spanning exactly from–to, if there is one. */
export function sectionMatching(p: Project, from: Tick, to: Tick): Section | null {
  return songSections(p).find((x) => x.from === from && x.to === to) ?? null;
}
