import { describe, expect, it } from 'vitest';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { createTestServices } from '../testing';
import { patternLines, playlistLines, projectContext, songCheckLines } from './context';
import { THIRTY_CHANNEL_SONG, TWO_HUNDRED_CHANNEL_SONG, buildSyntheticSong, withSeededIds } from '../../../test/helpers/context-songs';

function stackedSong() {
  const s = createTestServices();
  let ids!: ReturnType<typeof buildStackedSong>;
  s.history.transact('song', (d) => {
    ids = buildStackedSong(d);
  });
  return { s, ids, p: s.doc.getState().project };
}

describe('the project as the AI sees it', () => {
  it('lists a long track completely, as runs inside the sections (the 40-clip cut is gone)', () => {
    const { p } = stackedSong();
    const lines = playlistLines(p);
    expect(lines[0]).toContain('Bar ranges are 1-based and inclusive');
    expect(lines[0]).toContain('the song is 112 bars long');
    expect(lines[1]).toMatch(/^Sections \(markers\): "Intro" bars 1–8 mk_\S+; "Pre-verse" bars 9–16/);
    const track1 = lines.find((l) => l.startsWith('- Track 1:'))!;
    expect(track1).toContain('"Intro" ×4 bars 1–8');
    expect(track1).toContain('"Drop" ×8 bars 37–52');
    expect(track1).toContain('"Drop 2" ×2 bars 81–84 (STACKED: plays 2× here)');
    expect(track1).toContain('"Intro" ×6 bars 101–112 (STACKED: plays 2× here)');
    // Short runs carry their clip ids; long ones are found by track and bar.
    expect(track1).toMatch(/"Build" ×2 bars 33–36 clip_\S+, clip_\S+;/);
    expect(lines.find((l) => l.startsWith('- Track 11:'))).toContain('"Drop" ×6 bars 89–100');
    expect(lines.find((l) => l.startsWith('- Track 9:'))).toMatch(/"Tom fill" bar 16 clip_\S+/);
  });

  it('says where each pattern plays and what is wrong with the arrangement', () => {
    const { p } = stackedSong();
    const pats = patternLines(p);
    expect(pats.find((l) => l.startsWith('- "Drop 2"'))).toContain('plays at bars 69–84');
    expect(pats.find((l) => l.startsWith('- "Pattern 1"'))).toContain('not in the song');
    const check = songCheckLines(p);
    expect(check[0]).toBe(
      '- bars 81–112 play the same clips 3 times at once (Track 1, Track 11): that part is 3× too loud. The tidy action removes the copies.',
    );
    expect(check).toContain('- "ISOxo 808 slam" repeats 8 times unchanged on Track 1 (bars 17–32).');
    expect(check).toContain('- 4 automation channels "Pitch · Riser" are the same curve: tidy merges them.');
    expect(check.some((l) => l.includes('tracks have no name'))).toBe(true);
  });

  it('shows velocities other than 0.8 on the current pattern', () => {
    const { s, ids } = stackedSong();
    s.view.getState().setCurrentPattern(ids.patterns.Drop!);
    const text = projectContext(s);
    expect(text).toContain('@ = velocity 0–1 when not 0.8');
    expect(text).toMatch(/ {2}Hat: 0@\.9 2@\.5 /);
    expect(text).toContain('Song check (problems in the arrangement right now):');
  });
});

describe('the size budget', () => {
  // The golden files were written by the text builder before the budget existed: a project under the
  // budget must still come out exactly like that.
  it('leaves the stacked song exactly as it was', async () => {
    const s = createTestServices();
    withSeededIds(1, () => {
      s.history.transact('song', (d) => {
        buildStackedSong(d);
      });
    });
    await expect(projectContext(s)).toMatchFileSnapshot('./__snapshots__/context-stacked.txt');
  });

  it('leaves a 30-channel song exactly as it was', async () => {
    const s = createTestServices();
    withSeededIds(THIRTY_CHANNEL_SONG.seed, () => buildSyntheticSong(s, THIRTY_CHANNEL_SONG));
    await expect(projectContext(s)).toMatchFileSnapshot('./__snapshots__/context-thirty-channels.txt');
  });

  it('shortens a 200-channel project, and keeps every channel name and marker', () => {
    const s = createTestServices();
    withSeededIds(TWO_HUNDRED_CHANNEL_SONG.seed, () => buildSyntheticSong(s, TWO_HUNDRED_CHANNEL_SONG));
    const p = s.doc.getState().project;
    const text = projectContext(s);
    expect(text).toContain('(details shortened: the project is very large)');
    for (const ch of Object.values(p.channels)) expect(text).toContain(`"${ch.name}"`);
    for (const marker of Object.values(p.playlist.markers)) expect(text).toContain(`"${marker.name}"`);
  });
});
