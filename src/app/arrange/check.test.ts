import { describe, expect, it } from 'vitest';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { createTestServices } from '../testing';
import { checkArrangement, findingLines } from './check';

/** The stacked song is the checker's richest input: it trips most of the checks at known bars. */
function stackedSong() {
  const s = createTestServices();
  s.history.transact('song', (d) => {
    buildStackedSong(d);
  });
  return { s, p: s.doc.getState().project };
}

describe('checkArrangement', () => {
  it('has nothing to say about an empty song', () => {
    const s = createTestServices();
    expect(checkArrangement(s, s.doc.getState().project)).toEqual([]);
  });

  it('reports the stacked song’s problems, in song order, with their exact words', () => {
    const { s, p } = stackedSong();
    const findings = checkArrangement(s, p, { style: 'trap' });
    expect(findings.map((f) => `${f.severity} ${f.code} ${f.from}-${f.to}: ${f.message}`)).toMatchInlineSnapshot(`
      [
        "note curve-not-neutral 0-30720: “Cutoff · Filter (Insert 18)” ends at bar 9 away from where its control sits, so it stays there for the rest of the song",
        "bug static-loop 30720-57600: the drums and bass repeat the same bar unchanged over bars 9–15",
        "bug static-loop 30720-57600: the drums and bass repeat the same 2 bars unchanged over bars 9–15",
        "note curve-not-neutral 53760-61440: “Pitch · Riser” ends at bar 17 away from where its control sits, so it stays there for the rest of the song",
        "bug layered-fill 59520-61440: the fill at bar 16.5 to 17 plays on top of the full drums",
        "bug crash-spam 61440-119040: 8 crashes within bars 17–31 (one per 4 bars at most)",
        "bug static-loop 65280-119040: the drums and bass repeat the same 2 bars unchanged over bars 18–31",
        "bug no-fill 88320-92160: bar 24 ends Verse's 8-bar phrase with no fill or change",
        "bug layered-fill 120960-122880: the fill at bar 32.5 to 33 plays on top of the full drums",
        "note curve-not-neutral 122880-138240: “Cutoff · Dark Pad” ends at bar 37 away from where its control sits, so it stays there for the rest of the song",
        "note curve-not-neutral 130560-138240: “Pitch · Riser” ends at bar 37 away from where its control sits, so it stays there for the rest of the song",
        "bug no-gap 137280-138240: drums or bass play right up to “Drop” at bar 37 (a gap before it makes it hit)",
        "bug crash-spam 138240-195840: 8 crashes within bars 37–51 (one per 4 bars at most)",
        "bug static-loop 142080-180480: the drums and bass repeat the same 2 bars unchanged over bars 38–47",
        "bug no-fill 165120-168960: bar 44 ends Drop's 8-bar phrase with no fill or change",
        "bug layered-fill 182400-184320: the fill at bar 48.5 to 49 plays on top of the full drums",
        "bug no-fill 195840-199680: bar 52 ends Drop's 16-bar phrase with no fill or change",
        "note curve-not-neutral 199680-207360: “Pitch · Downlifter” ends at bar 55 away from where its control sits, so it stays there for the rest of the song",
        "bug static-loop 199680-241920: the drums and bass repeat the same bar unchanged over bars 53–63",
        "bug static-loop 199680-241920: the drums and bass repeat the same 2 bars unchanged over bars 53–63",
        "bug no-fill 226560-230400: bar 60 ends Bridge's 8-bar phrase with no fill or change",
        "bug layered-fill 243840-245760: the fill at bar 64.5 to 65 plays on top of the full drums",
        "note curve-not-neutral 245760-261120: “Cutoff · Dark Pad” ends at bar 69 away from where its control sits, so it stays there for the rest of the song",
        "note curve-not-neutral 253440-261120: “Pitch · Riser” ends at bar 69 away from where its control sits, so it stays there for the rest of the song",
        "bug no-gap 260160-261120: drums or bass play right up to “Drop 2” at bar 69 (a gap before it makes it hit)",
        "bug crash-spam 261120-318720: 8 crashes within bars 69–83 (one per 4 bars at most)",
        "bug static-loop 264960-303360: the drums and bass repeat the same 2 bars unchanged over bars 70–79",
        "bug no-fill 288000-291840: bar 76 ends Drop 2's 8-bar phrase with no fill or change",
        "bug layered-fill 305280-307200: the fill at bar 80.5 to 81 plays on top of the full drums",
        "bug stacked 307200-430080: bars 81–112 play the same clips 3 times at once",
        "bug no-fill 318720-322560: bar 84 ends Drop 2's 16-bar phrase with no fill or change",
        "note curve-not-neutral 322560-337920: “Cutoff · Dark Pad” ends at bar 89 away from where its control sits, so it stays there for the rest of the song",
        "note curve-not-neutral 322560-330240: “Pitch · Downlifter” ends at bar 87 away from where its control sits, so it stays there for the rest of the song",
        "note curve-not-neutral 330240-337920: “Pitch · Riser” ends at bar 89 away from where its control sits, so it stays there for the rest of the song",
        "bug crash-spam 337920-380160: 6 crashes within bars 89–99 (one per 4 bars at most)",
        "bug static-loop 341760-364800: the drums and bass repeat the same 2 bars unchanged over bars 90–95",
        "bug layered-fill 366720-368640: the fill at bar 96.5 to 97 plays on top of the full drums",
        "note curve-not-neutral 384000-391680: “Pitch · Downlifter” ends at bar 103 away from where its control sits, so it stays there for the rest of the song",
      ]
    `);
  });

  it('can be limited to bugs or notes', () => {
    const { s, p } = stackedSong();
    const findings = checkArrangement(s, p, { style: 'trap' });
    expect(findingLines(findings, 'note')).toEqual(findings.filter((f) => f.severity === 'note').map((f) => f.message));
    expect(findingLines(findings)).toHaveLength(findings.length);
  });
});
