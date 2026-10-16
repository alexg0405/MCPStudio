import { describe, expect, it } from 'vitest';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { addMarker } from '@core/ops/markers';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

const BAR = 3840;

function song() {
  const s = createTestServices();
  s.history.transact('song', (d) => {
    buildStackedSong(d);
    addMarker(d, 16 * BAR, 'Chorus');
    addMarker(d, 24 * BAR, 'Verse 2');
  });
  return s;
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

describe('the Studio’s filter action', () => {
  it('asks for the render after the answer, on the part it names', () => {
    const s = song();
    const res = run(s, [{ op: 'filter', filter: 'telephone', section: 'chorus' }]);
    expect(res.warnings).toEqual([]);
    expect(res.after).toContainEqual({ kind: 'filter', filter: 'telephone', target: { kind: 'range', from: 16 * BAR, to: 24 * BAR, name: 'Chorus' } });
    expect(res.touched).toEqual({ from: 16 * BAR, to: 24 * BAR });
    expect(res.changes.join(' ')).toMatch(/Telephone on “Chorus” \(bars 17–24\)/);

    const bars = run(s, [{ op: 'filter', filter: 'Slowed + reverb', from_bar: 5, to_bar: 8 }]);
    expect(bars.after).toContainEqual({ kind: 'filter', filter: 'slowed-reverb', target: { kind: 'range', from: 4 * BAR, to: 8 * BAR } });
    const all = run(s, [{ op: 'filter', filter: 'nightcore', whole_song: true }]);
    expect(all.after.find((a) => a.kind === 'filter')).toMatchObject({ target: { kind: 'song', from: 0 } });
  });

  it('says so when the filter or the part is unknown', () => {
    const s = song();
    expect(run(s, [{ op: 'filter', filter: 'kazoo' }]).warnings.join(' ')).toMatch(/filter must be one of/);
    expect(run(s, [{ op: 'filter', filter: 'lofi', section: 'kazoo solo' }]).warnings.join(' ')).toMatch(/no marker “kazoo solo”/);
    expect(run(s, [{ op: 'remove_filter', bar: 3 }]).warnings.join(' ')).toMatch(/no filtered part/);
  });
});
