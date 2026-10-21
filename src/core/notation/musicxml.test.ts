import { describe, expect, it } from 'vitest';
import { engrave } from './engrave';
import { scoreToMusicXml } from './musicxml';
import { readMusicXml } from './musicxml-read';
import { input, note, noteAt } from './test-input';
import { childrenNamed, child, parseXml, XmlError } from './xml';
import type { NotationNote } from './types';

const asRows = (notes: ReadonlyArray<{ tick: number; length: number; key: number }>) =>
  notes.map((n) => `${n.tick}:${n.length}:${n.key}`).sort();

/** Engraves, writes MusicXML, reads it back. */
function roundTrip(notes: NotationNote[], extra = {}) {
  const score = engrave(input(notes, extra));
  const xml = scoreToMusicXml(score, { title: 'Test' });
  return { xml, back: readMusicXml(xml) };
}

describe('MusicXML export', () => {
  it('writes a partwise 4.0 document that parses, with the part, the key, the meter and the tempo', () => {
    const { xml, back } = roundTrip([note(0, 4, 60)], { key: { root: 7, scale: 'major' } });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"');
    const root = parseXml(xml);
    expect(root.name).toBe('score-partwise');
    expect(root.attributes.version).toBe('4.0');
    expect(childrenNamed(root, 'part')).toHaveLength(1);
    expect(back.fifths).toBe(1);
    expect(back.timeSig).toEqual({ num: 4, den: 4 });
    expect(back.bpm).toBe(120);
  });

  it('every measure adds up to the bar in every voice', () => {
    const { xml } = roundTrip([note(0, 16, 60), note(0, 4, 72), note(4, 4, 74), note(8, 8, 76)]);
    const measure = childrenNamed(child(parseXml(xml), 'part'), 'measure')[0]!;
    let cursor = 0;
    let furthest = 0;
    for (const element of measure.children) {
      const duration = Number(child(element, 'duration')?.text ?? 0);
      if (element.name === 'note' && !child(element, 'chord')) cursor += duration;
      if (element.name === 'backup') cursor -= duration;
      furthest = Math.max(furthest, cursor);
    }
    expect(furthest).toBe(3840);
    expect(cursor).toBe(3840);
  });

  it('puts the elements of a note in the order the schema asks for', () => {
    const { xml } = roundTrip([note(0, 2, 61), note(2, 2, 62)]);
    const noteNode = childrenNamed(childrenNamed(child(parseXml(xml), 'part'), 'measure')[0], 'note')[0]!;
    const order = noteNode.children.map((element) => element.name);
    const expected = ['pitch', 'duration', 'voice', 'type', 'accidental', 'stem', 'beam'];
    expect(order.filter((name) => expected.includes(name))).toEqual(expected);
  });

  it('escapes text in titles', () => {
    const score = engrave(input([note(0, 4, 60)]));
    const xml = scoreToMusicXml(score, { title: 'Rock & <Roll>' });
    expect(parseXml(xml).children[0]!.children[0]!.text).toBe('Rock & <Roll>');
  });
});

describe('MusicXML round trip of our own output', () => {
  it('keeps pitches, starts and lengths of plain notes, chords and rests', () => {
    const notes = [note(0, 4, 72), note(4, 2, 74), note(8, 4, 60), note(8, 4, 64), note(8, 4, 67), note(14, 2, 71)];
    const { back } = roundTrip(notes);
    expect(asRows(back.notes)).toEqual(asRows(notes.map((n) => ({ tick: n.tick, length: n.length, key: n.key }))));
  });

  it('joins notes that were tied across the middle of the bar and across a bar line', () => {
    const notes = [note(4, 8, 61), note(12, 8, 60)];
    const { back } = roundTrip(notes, { lengthTicks: 7680 });
    expect(asRows(back.notes)).toEqual(asRows(notes.map((n) => ({ tick: n.tick, length: n.length, key: n.key }))));
  });

  it('keeps triplets', () => {
    const notes = [noteAt(0, 320, 60), noteAt(320, 320, 62), noteAt(640, 320, 64), noteAt(960, 960, 65)];
    const { back, xml } = roundTrip(notes);
    expect(xml).toContain('<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>');
    expect(asRows(back.notes)).toEqual(asRows(notes));
  });

  it('keeps two voices and a grand staff', () => {
    const notes = [note(0, 16, 40), note(0, 4, 72), note(4, 4, 74), note(8, 8, 76), note(0, 8, 55)];
    const { back, xml } = roundTrip(notes);
    expect(xml).toContain('<staves>2</staves>');
    expect(asRows(back.notes)).toEqual(asRows(notes.map((n) => ({ tick: n.tick, length: n.length, key: n.key }))));
  });

  it('keeps the drums and their instruments', () => {
    const hits = [noteAt(0, 100, 36), noteAt(0, 100, 42), noteAt(480, 100, 42), noteAt(960, 100, 38), noteAt(960, 100, 42)];
    const { back, xml } = roundTrip(hits, { isPercussion: true });
    expect(xml).toContain('<midi-unpitched>37</midi-unpitched>');
    expect(back.isPercussion).toBe(true);
    expect(back.notes.map((n) => `${n.tick}:${n.key}`).sort()).toEqual(hits.map((n) => `${n.tick}:${n.key}`).sort());
  });

  it('writes lyrics, chord symbols and dynamics', () => {
    const score = engrave(
      input([note(0, 4, 72), note(4, 4, 74)], {
        lyrics: [
          { tick: 0, length: 960, text: 'beau', continues: true },
          { tick: 960, length: 960, text: 'ty', continues: false },
        ],
        chords: [{ tick: 0, length: 3840, text: 'F#m7' }],
        dynamics: true,
      }),
    );
    const xml = scoreToMusicXml(score, { title: 'T' });
    expect(xml).toContain('<syllabic>begin</syllabic><text>beau</text>');
    expect(xml).toContain('<syllabic>end</syllabic><text>ty</text>');
    expect(xml).toContain('<root-step>F</root-step><root-alter>1</root-alter></root><kind text="m7">minor-seventh</kind>');
    expect(xml).toContain('<dynamics><f/></dynamics>');
  });
});

describe('reading other files', () => {
  it('refuses what is not a partwise score, with a sentence', () => {
    expect(() => readMusicXml('<score-timewise version="4.0"/>')).toThrow(/partwise/);
    expect(() => readMusicXml('<html/>')).toThrow(/not a MusicXML/);
    expect(() => readMusicXml('<a><b></a>')).toThrow(XmlError);
  });

  it('reads another divisions value, a backup and a forward', () => {
    const xml = `<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>D</step><alter>-1</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice></note>
      <forward><duration>2</duration></forward></measure>
      <measure number="2"><note><rest/><duration>2</duration></note><note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration></note></measure></part></score-partwise>`;
    const back = readMusicXml(xml);
    expect(back.partName).toBe('Piano');
    expect(back.timeSig).toEqual({ num: 2, den: 4 });
    expect(asRows(back.notes)).toEqual(['0:960:72', '0:960:52', '960:960:73', '2880:960:67'].sort());
  });
});
