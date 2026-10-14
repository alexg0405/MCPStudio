import { describe, expect, it } from 'vitest';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { createTestServices } from '../testing';
import { describeTidy, tidyNow, tidyPreview } from './tidy';

describe('Clean up the song', () => {
  it('says what it will fix, fixes it in one undo step', () => {
    const s = createTestServices();
    s.history.transact('song', (d) => void buildStackedSong(d));
    expect(tidyPreview(s)).toEqual([
      'bars 81–112 play the same clips 3 times at once: keep one copy.',
      'Name tracks that play just one thing (11 tracks have no name).',
      '3 automation channels “Cutoff · Dark Pad” are the same curve: keep one.',
      '4 automation channels “Pitch · Riser” are the same curve: keep one.',
      '3 automation channels “Pitch · Downlifter” are the same curve: keep one.',
    ]);
    const steps = s.history.steps().done.length;
    expect(describeTidy(tidyNow(s))).toBe('Cleaned up the song: removed 32 stacked copies, merged 7 automation channels, named 9 tracks.');
    expect(s.history.steps().done).toHaveLength(steps + 1);
    expect(tidyPreview(s)).toEqual(['Name tracks that play just one thing (1 track has no name).']);
  });
});
