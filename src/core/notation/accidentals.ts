/**
 * Which accidentals a staff shows. The key signature sets what each letter means; a sign is drawn when a note differs from
 * what is in force for its letter and octave in this bar, and the bar line forgets it. A note that returns to the key's
 * own value in the bar after one that left it gets a reminder (a courtesy accidental, drawn in brackets). A tied note
 * that carries on shows no sign again.
 */
import { accidentalSign, signatureAlter } from './spelling';
import type { ChordItem, KeySignature, Measure, Step } from './types';

/** The alteration of each letter at the end of the last bar, for the letters that left the signature. */
type LeftOver = Map<Step, number>;

/** The chords of a staff in one bar in the order they are played, voice 1 first when they start together. */
function chordsInOrder(measure: Measure, staff: number): ChordItem[] {
  const out: Array<{ chord: ChordItem; voice: number }> = [];
  for (const voice of measure.staves[staff]?.voices ?? []) {
    for (const item of voice.items) if (item.kind === 'chord') out.push({ chord: item, voice: voice.number });
  }
  out.sort((a, b) => a.chord.tick - b.chord.tick || a.voice - b.voice);
  return out.map((entry) => entry.chord);
}

/** Sets `accidental` and `isCourtesy` on the heads of one staff, bar after bar. */
export function placeAccidentals(measures: readonly Measure[], staff: number, signature: KeySignature): void {
  let previous: LeftOver = new Map();
  for (const measure of measures) {
    const inForce = new Map<string, number>();
    const left: LeftOver = new Map();
    const reminded = new Set<Step>();
    for (const chord of chordsInOrder(measure, staff)) {
      for (const head of chord.heads) {
        const { step, alter, octave } = head.spelling;
        const place = `${step}:${octave}`;
        const current = inForce.get(place) ?? signatureAlter(signature.fifths, step);
        if (head.tiedFromPrevious) {
          inForce.set(place, alter);
        } else if (alter !== current) {
          head.accidental = alter === 0 ? 'natural' : accidentalSign(alter);
          inForce.set(place, alter);
        } else if (needsReminder(previous, reminded, step, alter, signature, inForce.has(place))) {
          head.accidental = alter === 0 ? 'natural' : accidentalSign(alter);
          head.isCourtesy = true;
        }
        reminded.add(step);
        if (alter !== signatureAlter(signature.fifths, step)) left.set(step, alter);
        else left.delete(step);
      }
    }
    previous = left;
  }
}

/** True when the last bar left this letter altered, this note is back at the key's value and the letter has not come up yet. */
function needsReminder(previous: LeftOver, reminded: ReadonlySet<Step>, step: Step, alter: number, signature: KeySignature, hasSet: boolean): boolean {
  if (hasSet || reminded.has(step)) return false;
  const was = previous.get(step);
  return was !== undefined && was !== alter && alter === signatureAlter(signature.fifths, step);
}
