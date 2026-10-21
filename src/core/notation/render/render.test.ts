import { describe, expect, it } from 'vitest';
import { engrave } from '../engrave';
import { input, note, noteAt } from '../test-input';
import { renderSheet } from './index';
import { layoutScore, locateTick, SPACE } from './layout';

const draw = (notes: ReturnType<typeof note>[], extra = {}, width = 700) => renderSheet(engrave(input(notes, extra)), { width, zoom: 1 });
const count = (svg: string, pattern: RegExp) => (svg.match(pattern) ?? []).length;

describe('SVG rendering', () => {
  it('draws the same text every time (no ids or randomness)', () => {
    const notes = [note(0, 4, 60), note(4, 4, 64), note(8, 8, 67)];
    expect(draw(notes).systems).toEqual(draw(notes).systems);
    expect(draw(notes).systems.join('\n')).toMatchSnapshot();
  });

  it('a small score is one svg per system with a viewBox, hidden from the accessibility tree', () => {
    const sheet = draw([note(0, 4, 72)]);
    expect(sheet.systems).toHaveLength(1);
    expect(sheet.systems[0]).toMatch(/^<svg class="ag-system" data-system="0" xmlns="http:\/\/www.w3.org\/2000\/svg" width="[\d.]+" height="[\d.]+" viewBox="0 0 [\d.]+ [\d.]+" aria-hidden="true" focusable="false">/);
  });

  it('every notehead is a path with its note id, so a click can tell which note it hit', () => {
    const notes = [note(0, 4, 60, 'n_a'), note(0, 4, 64, 'n_b'), note(4, 4, 67, 'n_c')];
    const svg = draw(notes).systems.join('');
    for (const id of ['n_a', 'n_b', 'n_c']) expect(svg).toContain(`data-note="${id}"`);
    expect(count(svg, /class="ag-head"/g)).toBe(3);
    expect(count(svg, /class="ag-notehead"/g)).toBe(3);
  });

  it('chords and rests carry the ticks they sound between, for following the playhead', () => {
    const svg = draw([note(4, 4, 72)]).systems.join('');
    expect(svg).toContain('class="ag-rest" data-t0="0" data-t1="960"');
    expect(svg).toContain('class="ag-chord" data-t0="960" data-t1="1920"');
  });

  it('a note below the staff gets ledger lines, and middle C needs one', () => {
    const middleC = draw([note(0, 4, 60)], { clef: 'treble' }).systems.join('');
    expect(middleC).toMatch(/<path d="M[\d.]+ [\d.]+H[\d.]+" fill="none" stroke="currentColor" stroke-width="1"\/>/);
    const inside = draw([note(0, 4, 71)], { clef: 'treble' }).systems.join('');
    expect(inside).not.toMatch(/<path d="M[\d.]+ [\d.]+H[\d.]+" fill="none" stroke="currentColor" stroke-width="1"\/>/);
  });

  it('writes a tie for a tied note, a triplet number, lyrics, chord symbols and dynamics', () => {
    const tied = draw([note(4, 8, 72)]).systems.join('');
    expect(tied).toContain('class="ag-tie"');
    const triplet = draw([noteAt(0, 320, 72), noteAt(320, 320, 74), noteAt(640, 320, 76)]).systems.join('');
    expect(triplet).toContain('>3</text>');
    const words = renderSheet(
      engrave(input([note(0, 4, 72), note(4, 4, 74)], { lyrics: [{ tick: 0, length: 960, text: 'la', continues: false }], chords: [{ tick: 0, length: 3840, text: 'C<7>' }], dynamics: true })),
      { width: 700, zoom: 1 },
    ).systems.join('');
    expect(words).toContain('class="ag-lyric"');
    expect(words).toContain('>la</text>');
    expect(words).toContain('C&lt;7&gt;');
    expect(words).toContain('class="ag-dynamic"');
  });

  it('a key signature draws one sign for each sharp or flat, and a drum staff none', () => {
    const inD = draw([note(0, 4, 74)], { key: { root: 2, scale: 'major' }, clef: 'treble' }).systems[0] as string;
    const header = inD.slice(inD.indexOf('class="ag-staff"'), inD.indexOf('class="ag-bar"'));
    expect(count(header, /M-0\.2-1\.15V1\.3/g)).toBe(2);
    const drums = draw([noteAt(0, 100, 36)], { isPercussion: true, key: { root: 2, scale: 'major' } }).systems[0] as string;
    expect(count(drums, /M-0\.2-1\.15V1\.3/g)).toBe(0);
  });

  it('the zoom scales the drawing and not the viewBox', () => {
    const score = engrave(input([note(0, 4, 72)]));
    const one = renderSheet(score, { width: 700, zoom: 1 }).systems[0] as string;
    const two = renderSheet(score, { width: 700, zoom: 2 }).systems[0] as string;
    const size = (svg: string) => Number(/ width="([\d.]+)"/.exec(svg)?.[1]);
    expect(size(two)).toBeCloseTo(size(one) * 2, 1);
    expect(/viewBox="([^"]+)"/.exec(one)?.[1]).toBe(/viewBox="([^"]+)"/.exec(two)?.[1]);
  });
});

describe('layout', () => {
  const eightBars = (width: number) => layoutScore(engrave(input([note(0, 4, 72), note(8, 4, 74)], { lengthTicks: 3840 * 8 })), { width });

  it('breaks bars into systems that fit the page width', () => {
    const wide = eightBars(900);
    const narrow = eightBars(380);
    expect(narrow.systems.length).toBeGreaterThan(wide.systems.length);
    expect(wide.systems.reduce((sum, system) => sum + system.measures.length, 0)).toBe(8);
    for (const system of wide.systems.slice(0, -1)) expect(system.width).toBeLessThanOrEqual(900 + 1);
  });

  it('fills the line: every system but a short last one is stretched to the page width', () => {
    const layout = eightBars(700);
    for (const system of layout.systems.slice(0, -1)) expect(system.width).toBeCloseTo(700, 0);
  });

  it('a bar with a longer note is wider than a bar of short notes', () => {
    const score = engrave(input([note(0, 16, 72), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((step) => note(16 + step, 1, 72))], { lengthTicks: 7680 }));
    const layout = layoutScore(score, { width: 2000 });
    const [whole, sixteenths] = layout.systems[0]!.measures;
    expect(sixteenths!.width / whole!.width).toBeGreaterThan(1.5);
  });

  it('puts two staves of a piano part under each other', () => {
    const layout = layoutScore(engrave(input([note(0, 4, 40), note(0, 4, 79)])), { width: 700 });
    const tops = layout.systems[0]!.staffTops;
    expect(tops).toHaveLength(2);
    expect((tops[1] as number) - (tops[0] as number)).toBeGreaterThan(8 * SPACE);
  });

  it('finds where a tick is drawn, between columns too', () => {
    const score = engrave(input([note(0, 4, 72), note(8, 4, 74)], { lengthTicks: 3840 * 3 }));
    const layout = layoutScore(score, { width: 700 });
    const start = locateTick(layout, 3840, 0)!;
    const later = locateTick(layout, 3840, 1920)!;
    const nextBar = locateTick(layout, 3840, 3840)!;
    expect(later.x).toBeGreaterThan(start.x);
    expect(nextBar.x).toBeGreaterThan(0);
    expect(locateTick(layout, 3840, 3840 * 9)).toBeNull();
  });
});
