/**
 * MusicXML 4.0 (partwise) out of a score: one part with one or two staves, key, meter and tempo, voices, ties, beams,
 * tuplets, accidentals, lyrics, chord symbols, dynamics and percussion. `musicxml-read.ts` reads such a file back.
 */
import { drumPlace } from './drums';
import { escapeXml } from './xml';
import type { ChordItem, ClefKind, Item, Measure, NoteValue, RestItem, Score, Voice } from './types';

/** Divisions per quarter note: the app's own tick resolution, so every duration is an exact whole number. */
export const DIVISIONS = 960;

const TYPE_NAMES: Record<NoteValue['base'], string> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: '16th',
  32: '32nd',
  64: '64th',
};

const MODES = new Set(['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']);
const STEP_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** The chord kinds MusicXML has a word for, by the text after the root. */
const CHORD_KINDS: Readonly<Record<string, string>> = {
  '': 'major',
  m: 'minor',
  '7': 'dominant',
  maj7: 'major-seventh',
  M7: 'major-seventh',
  m7: 'minor-seventh',
  dim: 'diminished',
  '°': 'diminished',
  aug: 'augmented',
  '+': 'augmented',
  sus4: 'suspended-fourth',
  sus2: 'suspended-second',
  '6': 'major-sixth',
  m6: 'minor-sixth',
  '9': 'dominant-ninth',
  m7b5: 'half-diminished',
  dim7: 'diminished-seventh',
  '5': 'power',
};

const tag = (name: string, content: string | number, attributes = ''): string => `<${name}${attributes}>${typeof content === 'number' ? content : escapeXml(content)}</${name}>`;

function clefXml(clef: ClefKind, number: number, showNumber: boolean): string {
  const sign = clef === 'treble' ? ['G', 2] : clef === 'bass' ? ['F', 4] : ['percussion', 2];
  const line = clef === 'percussion' ? '' : tag('line', sign[1] as number);
  return `<clef${showNumber ? ` number="${number}"` : ''}>${tag('sign', sign[0] as string)}${line}</clef>`;
}

function attributesXml(score: Score): string {
  const name = score.keySignature.name.split(' ').pop() ?? 'major';
  const mode = MODES.has(name) ? name : 'major';
  const staves = score.clefs.length;
  return [
    '<attributes>',
    tag('divisions', DIVISIONS),
    `<key>${tag('fifths', score.keySignature.fifths)}${tag('mode', mode)}</key>`,
    `<time>${tag('beats', score.timeSig.num)}${tag('beat-type', score.timeSig.den)}</time>`,
    staves > 1 ? tag('staves', staves) : '',
    ...score.clefs.map((clef, i) => clefXml(clef, i + 1, staves > 1)),
    '</attributes>',
  ].join('');
}

function tempoXml(bpm: number): string {
  const rounded = Math.round(bpm * 100) / 100;
  return `<direction placement="above"><direction-type><metronome>${tag('beat-unit', 'quarter')}${tag('per-minute', rounded)}</metronome></direction-type><sound tempo="${rounded}"/></direction>`;
}

function harmonyXml(text: string): string {
  const match = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(text);
  if (!match) return '';
  const alter = (sign: string | undefined): string => (sign === '#' ? tag('root-alter', 1) : sign === 'b' ? tag('root-alter', -1) : '');
  const suffix = match[3] ?? '';
  const kind = CHORD_KINDS[suffix] ?? 'other';
  const bassAlter = match[5] === '#' ? tag('bass-alter', 1) : match[5] === 'b' ? tag('bass-alter', -1) : '';
  const bass = match[4] ? `<bass>${tag('bass-step', match[4])}${bassAlter}</bass>` : '';
  return `<harmony><root>${tag('root-step', match[1] as string)}${alter(match[2])}</root><kind text="${escapeXml(suffix)}">${kind}</kind>${bass}</harmony>`;
}

function dynamicXml(mark: string): string {
  return `<direction placement="below"><direction-type><dynamics><${mark}/></dynamics></direction-type></direction>`;
}

/** Beam state of a chord at one beam level, from the chords before and after it in its group. */
function beamState(group: readonly ChordItem[], index: number, level: number): string | null {
  const here = group[index] as ChordItem;
  if (here.flags < level) return null;
  const before = (group[index - 1]?.flags ?? 0) >= level;
  const after = (group[index + 1]?.flags ?? 0) >= level;
  if (before && after) return 'continue';
  if (before) return 'end';
  if (after) return 'begin';
  return index > 0 && (group[index - 1]?.flags ?? 0) > 0 ? 'backward hook' : 'forward hook';
}

interface VoiceContext {
  staff: number;
  voiceNumber: number;
  clefCount: number;
  isPercussion: boolean;
  partId: string;
}

function noteXml(chord: ChordItem, headIndex: number, voice: VoiceContext, state: { beams: string; tuplet: string; lyric: string }): string {
  const head = chord.heads[headIndex] as ChordItem['heads'][number];
  const parts: string[] = ['<note>'];
  if (headIndex > 0) parts.push('<chord/>');
  if (voice.isPercussion) {
    const place = drumPlace(head.key);
    parts.push(`<unpitched>${tag('display-step', STEP_NAMES[place.position % 7] as string)}${tag('display-octave', Math.floor(place.position / 7))}</unpitched>`);
  } else {
    const spelling = head.spelling;
    parts.push(`<pitch>${tag('step', STEP_NAMES[spelling.step] as string)}${spelling.alter ? tag('alter', spelling.alter) : ''}${tag('octave', spelling.octave)}</pitch>`);
  }
  parts.push(tag('duration', chord.ticks));
  if (head.tiedFromPrevious) parts.push('<tie type="stop"/>');
  if (head.tiesToNext) parts.push('<tie type="start"/>');
  if (voice.isPercussion) parts.push(`<instrument id="${voice.partId}-I${head.key}"/>`);
  parts.push(tag('voice', voice.voiceNumber), tag('type', TYPE_NAMES[chord.value.base]));
  if (chord.value.dots) parts.push('<dot/>');
  if (head.accidental && !voice.isPercussion) parts.push(tag('accidental', head.accidental, head.isCourtesy ? ' parentheses="yes"' : ''));
  if (chord.tuplet) parts.push(`<time-modification>${tag('actual-notes', chord.tuplet.actual)}${tag('normal-notes', chord.tuplet.normal)}</time-modification>`);
  if (chord.stem !== 'none') parts.push(tag('stem', chord.stem));
  if (head.shape === 'x') parts.push(tag('notehead', 'x'));
  else if (head.shape === 'diamond') parts.push(tag('notehead', 'diamond'));
  if (voice.clefCount > 1) parts.push(tag('staff', voice.staff + 1));
  if (headIndex === 0) parts.push(state.beams);
  const notations = [head.tiedFromPrevious ? '<tied type="stop"/>' : '', head.tiesToNext ? '<tied type="start"/>' : '', headIndex === 0 ? state.tuplet : ''].join('');
  if (notations) parts.push(`<notations>${notations}</notations>`);
  if (headIndex === 0 && state.lyric) parts.push(state.lyric);
  parts.push('</note>');
  return parts.join('');
}

function restXml(rest: RestItem, voice: VoiceContext, barTicks: number): string {
  const parts = ['<note>', rest.isWholeBar ? '<rest measure="yes"/>' : '<rest/>', tag('duration', rest.isWholeBar ? barTicks : rest.ticks), tag('voice', voice.voiceNumber)];
  if (!rest.isWholeBar) {
    parts.push(tag('type', TYPE_NAMES[rest.value.base]));
    if (rest.value.dots) parts.push('<dot/>');
    if (rest.tuplet) parts.push(`<time-modification>${tag('actual-notes', rest.tuplet.actual)}${tag('normal-notes', rest.tuplet.normal)}</time-modification>`);
  }
  if (voice.clefCount > 1) parts.push(tag('staff', voice.staff + 1));
  parts.push('</note>');
  return parts.join('');
}

/** The beam group a chord belongs to inside its voice's items. */
function groupOf(items: readonly Item[], chord: ChordItem): ChordItem[] {
  return items.filter((item): item is ChordItem => item.kind === 'chord' && item.beamId === chord.beamId);
}

/** The tuplet bracket mark: start on the first item of a span, stop on the last. */
function tupletMark(items: readonly Item[], item: Item): string {
  if (!item.tuplet) return '';
  const span = items.filter((other) => other.tuplet?.spanTick === item.tuplet?.spanTick);
  if (span[0] === item) return '<tuplet type="start" bracket="yes"/>';
  if (span[span.length - 1] === item) return '<tuplet type="stop"/>';
  return '';
}

/** Lyric text of a chord given whether the syllable before it continued into this one. */
function lyricXml(chord: ChordItem, previousContinued: boolean): string {
  if (!chord.lyric) return '';
  const syllabic = previousContinued ? (chord.lyric.continues ? 'middle' : 'end') : chord.lyric.continues ? 'begin' : 'single';
  return `<lyric number="1">${tag('syllabic', syllabic)}${tag('text', chord.lyric.text)}</lyric>`;
}

function voiceXml(voice: Voice, context: VoiceContext, measure: Measure, harmonies: Array<{ tick: number; text: string }>): string {
  const out: string[] = [];
  let previousContinued = false;
  for (const item of voice.items) {
    while (harmonies.length > 0 && (harmonies[0] as { tick: number }).tick <= item.tick) out.push(harmonyXml((harmonies.shift() as { text: string }).text));
    if (item.kind === 'rest') {
      out.push(restXml(item, context, measure.ticks));
      continue;
    }
    if (item.dynamic) out.push(dynamicXml(item.dynamic));
    const group = item.beamId === null ? [] : groupOf(voice.items, item);
    const beams = item.beamId === null ? '' : beamsXml(group, group.indexOf(item));
    const state = { beams, tuplet: tupletMark(voice.items, item), lyric: lyricXml(item, previousContinued) };
    previousContinued = !!item.lyric?.continues;
    item.heads.forEach((_, headIndex) => out.push(noteXml(item, headIndex, context, state)));
  }
  return out.join('');
}

function beamsXml(group: readonly ChordItem[], index: number): string {
  const levels = Math.max(...group.map((chord) => chord.flags));
  const out: string[] = [];
  for (let level = 1; level <= levels; level++) {
    const state = beamState(group, index, level);
    if (state) out.push(tag('beam', state, ` number="${level}"`));
  }
  return out.join('');
}

function measureXml(score: Score, measure: Measure, part: { id: string }): string {
  const out: string[] = [`<measure number="${measure.index + 1}">`];
  if (measure.index === 0) out.push(attributesXml(score), tempoXml(score.bpm));
  const harmonies = measure.chordSymbols.map((symbol) => ({ ...symbol })).sort((a, b) => a.tick - b.tick);
  let isFirstVoice = true;
  measure.staves.forEach((staff, staffIndex) => {
    for (const voice of staff.voices) {
      if (!isFirstVoice) out.push(`<backup>${tag('duration', measure.ticks)}</backup>`);
      const context: VoiceContext = {
        staff: staffIndex,
        voiceNumber: staffIndex * 2 + voice.number,
        clefCount: score.clefs.length,
        isPercussion: score.isPercussion,
        partId: part.id,
      };
      out.push(voiceXml(voice, context, measure, isFirstVoice ? harmonies : []));
      isFirstVoice = false;
    }
  });
  // Chord symbols after the last note of the first voice (a bar that holds one rest) still belong to the bar.
  for (const symbol of harmonies) out.push(harmonyXml(symbol.text));
  out.push('</measure>');
  return out.join('');
}

/** The drum keys used in a percussion score, for the instrument list. */
function drumKeysOf(score: Score): number[] {
  const keys = new Set<number>();
  for (const measure of score.measures) {
    for (const staff of measure.staves) {
      for (const voice of staff.voices) for (const item of voice.items) if (item.kind === 'chord') for (const head of item.heads) keys.add(head.key);
    }
  }
  return [...keys].sort((a, b) => a - b);
}

function partListXml(score: Score, partName: string, partId: string): string {
  const instruments = score.isPercussion
    ? drumKeysOf(score)
        .map((key) => `<score-instrument id="${partId}-I${key}">${tag('instrument-name', drumPlace(key).name)}</score-instrument>`)
        .join('') +
      drumKeysOf(score)
        .map((key) => `<midi-instrument id="${partId}-I${key}">${tag('midi-channel', 10)}${tag('midi-unpitched', key + 1)}</midi-instrument>`)
        .join('')
    : '';
  return `<part-list><score-part id="${partId}">${tag('part-name', partName)}${instruments}</score-part></part-list>`;
}

/** Writes the score as a MusicXML 4.0 partwise document. */
export function scoreToMusicXml(score: Score, options: { title: string; partName?: string }): string {
  const partId = 'P1';
  const body = score.measures.map((measure) => measureXml(score, measure, { id: partId })).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `<work>${tag('work-title', options.title)}</work>`,
    '<identification><encoding><software>AGstudio</software></encoding></identification>',
    partListXml(score, options.partName ?? options.title, partId),
    `<part id="${partId}">`,
    body,
    '</part>',
    '</score-partwise>',
    '',
  ].join('\n');
}
