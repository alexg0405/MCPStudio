/**
 * Which notes share a chord and which voice each chord is in. Notes that start and end together are one chord. Chords
 * that overlap in time need their own voice; a staff has at most two (voice 1 with stems up, voice 2 with stems down).
 * A drum part uses the two voices by limb: hands in voice 1, feet (kick, pedal hi-hat) in voice 2.
 */
import type { Tick } from '../model/types';
import { drumPlace } from './drums';
import type { Meter } from './meter';
import type { QuantizedNote } from './quantize';

/** Notes that sound together from `start` to `end`. */
export interface VoiceEvent {
  start: Tick;
  end: Tick;
  notes: QuantizedNote[];
}

/** The events of one staff, split into its two voices. */
export interface StaffVoices {
  voices: [VoiceEvent[], VoiceEvent[]];
  /** How many notes were cut short because three overlapped. */
  simplified: number;
}

/** Notes with the same start and end become one chord. */
function chordsOf(notes: readonly QuantizedNote[]): VoiceEvent[] {
  const byKey = new Map<string, VoiceEvent>();
  for (const note of notes) {
    const id = `${note.start}:${note.end}`;
    const event = byKey.get(id);
    if (event) event.notes.push(note);
    else byKey.set(id, { start: note.start, end: note.end, notes: [note] });
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start || b.end - a.end);
}

const topKey = (event: VoiceEvent): number => Math.max(...event.notes.map((note) => note.note.key));

/**
 * A note that runs a little into the start of the next one (a legato line) is shortened to where the next starts, so a
 * melody stays one voice. "A little" is up to one grid step.
 */
function trimLegato(events: VoiceEvent[], gridTicks: Tick): void {
  for (const event of events) {
    let nextStart = Number.POSITIVE_INFINITY;
    for (const other of events) if (other.start > event.start && other.start < event.end) nextStart = Math.min(nextStart, other.start);
    if (nextStart < event.end && event.end - nextStart <= gridTicks) event.end = nextStart;
  }
}

/** Puts the chords of a pitched staff into voices. */
export function pitchedVoices(notes: readonly QuantizedNote[], gridTicks: Tick): StaffVoices {
  const events = chordsOf(notes);
  trimLegato(events, gridTicks);
  events.sort((a, b) => a.start - b.start || topKey(b) - topKey(a));
  const voices: [VoiceEvent[], VoiceEvent[]] = [[], []];
  let simplified = 0;
  for (const event of events) {
    const free = voices.findIndex((voice) => (voice[voice.length - 1]?.end ?? 0) <= event.start);
    if (free >= 0) {
      voices[free]!.push(event);
      continue;
    }
    // Three chords at once: the voice that ends sooner is cut short where this chord starts.
    const sooner = (voices[0][voices[0].length - 1] as VoiceEvent).end <= (voices[1][voices[1].length - 1] as VoiceEvent).end ? 0 : 1;
    const last = voices[sooner]![voices[sooner]!.length - 1] as VoiceEvent;
    simplified += last.notes.length;
    last.end = Math.max(last.start + 1, event.start);
    voices[sooner]!.push(event);
  }
  return { voices, simplified };
}

/** The next place after `start` where a beat group begins in the bar structure, so a hit never lasts into the next beat. */
function nextGroupEdge(meter: Meter, start: Tick): Tick {
  const barStart = Math.floor(start / meter.barTicks) * meter.barTicks;
  for (const edge of meter.groupEdges) if (barStart + edge > start) return barStart + edge;
  return barStart + meter.barTicks;
}

/** Puts drum hits into hand and foot voices; each hit lasts until the next hit of its voice or the end of its beat. */
export function drumVoices(notes: readonly QuantizedNote[], meter: Meter): StaffVoices {
  const hands: QuantizedNote[] = [];
  const feet: QuantizedNote[] = [];
  for (const note of notes) (drumPlace(note.note.key).isFoot ? feet : hands).push(note);
  return { voices: [timedHits(hands, meter), timedHits(feet, meter)], simplified: 0 };
}

function timedHits(hits: readonly QuantizedNote[], meter: Meter): VoiceEvent[] {
  const starts = [...new Set(hits.map((hit) => hit.start))].sort((a, b) => a - b);
  const events: VoiceEvent[] = [];
  starts.forEach((start, index) => {
    const nextStart = starts[index + 1] ?? Number.POSITIVE_INFINITY;
    const end = Math.min(nextStart, nextGroupEdge(meter, start));
    events.push({ start, end, notes: hits.filter((hit) => hit.start === start) });
  });
  return events;
}
