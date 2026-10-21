/**
 * Stems and beams: which way each stem points, which notes share a beam, and which noteheads of a chord sit on the other
 * side of the stem. Beam groups follow the meter: eighth notes and shorter join inside one beat group (a beat in 4/4, three
 * eighths in 6/8) and inside one triplet, and a rest ends a group.
 */
import { groupIndexAt, type Meter } from './meter';
import type { ChordItem, ClefKind, Item, Measure, StaffMeasure } from './types';

/** The diatonic position of the middle line of each clef (treble B4 = 34, bass D3 = 22, percussion as treble). */
export function middlePosition(clef: ClefKind): number {
  return clef === 'bass' ? 22 : 34;
}

const isChord = (item: Item): item is ChordItem => item.kind === 'chord';

/** How far a chord sits from the middle line: positive above. */
function offsetFromMiddle(chord: ChordItem, middle: number): number {
  const lowest = chord.heads[0]?.position ?? middle;
  const highest = chord.heads[chord.heads.length - 1]?.position ?? middle;
  return (lowest + highest) / 2 - middle;
}

/** Whether two chords may share a beam. */
function canJoin(a: ChordItem, b: ChordItem, meter: Meter): boolean {
  if (b.tick !== a.tick + a.ticks) return false;
  if (groupIndexAt(meter, a.tick) !== groupIndexAt(meter, b.tick)) return false;
  return (a.tuplet?.spanTick ?? -1) === (b.tuplet?.spanTick ?? -1);
}

/** Groups of two or more beamable chords in a voice, in order. */
function beamGroups(items: readonly Item[], meter: Meter): ChordItem[][] {
  const groups: ChordItem[][] = [];
  let run: ChordItem[] = [];
  const close = () => {
    if (run.length >= 2) groups.push(run);
    run = [];
  };
  for (const item of items) {
    if (!isChord(item) || item.flags === 0) {
      close();
      continue;
    }
    const last = run[run.length - 1];
    if (last && !canJoin(last, item, meter)) close();
    run.push(item);
  }
  close();
  return groups;
}

/** Marks the heads that must sit on the other side of the stem: the upper note of a second for stems up, the lower for stems down. */
function displaceSeconds(chord: ChordItem): void {
  const heads = chord.heads;
  for (const head of heads) head.isDisplaced = false;
  if (chord.stem === 'down') {
    for (let i = heads.length - 2; i >= 0; i--) {
      const above = heads[i + 1]!;
      const head = heads[i]!;
      if (above.position - head.position === 1 && !above.isDisplaced) head.isDisplaced = true;
    }
    return;
  }
  for (let i = 1; i < heads.length; i++) {
    const below = heads[i - 1]!;
    const head = heads[i]!;
    if (head.position - below.position === 1 && !below.isDisplaced) head.isDisplaced = true;
  }
}

/** Sets stems, beam ids and displaced heads for the voices of one staff in one bar. */
export function placeStems(staffMeasure: StaffMeasure, clef: ClefKind, meter: Meter): void {
  const middle = middlePosition(clef);
  for (const voice of staffMeasure.voices) {
    // Voice 2 always points down and voice 1 up when there are two (a lone voice 2, such as a kick drum part, still points down).
    const forced: 'up' | 'down' | null = voice.number === 2 ? 'down' : staffMeasure.voices.length > 1 ? 'up' : null;
    const groups = beamGroups(voice.items, meter);
    let nextBeam = 0;
    for (const group of groups) {
      const beamId = nextBeam++;
      for (const chord of group) chord.beamId = beamId;
    }
    const grouped = new Set(groups.flat());
    for (const item of voice.items) {
      if (!isChord(item)) continue;
      item.stem = item.value.base === 1 ? 'none' : (forced ?? directionOf(item, middle));
    }
    for (const group of groups) {
      const total = group.reduce((sum, chord) => sum + offsetFromMiddle(chord, middle), 0);
      const direction = forced ?? (total >= 0 ? 'down' : 'up');
      for (const chord of group) chord.stem = direction;
    }
    for (const item of voice.items) if (isChord(item) && (grouped.has(item) || item.stem !== 'none')) displaceSeconds(item);
  }
}

function directionOf(chord: ChordItem, middle: number): 'up' | 'down' {
  return offsetFromMiddle(chord, middle) >= 0 ? 'down' : 'up';
}

/** Runs `placeStems` for every staff of every bar. */
export function placeAllStems(measures: readonly Measure[], clefs: readonly ClefKind[], meter: Meter): void {
  for (const measure of measures) {
    measure.staves.forEach((staffMeasure, staff) => placeStems(staffMeasure, clefs[staff] ?? 'treble', meter));
  }
}
