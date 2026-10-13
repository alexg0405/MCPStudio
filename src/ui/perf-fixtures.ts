import type { Services } from '@app/services';
import { addInstrumentChannel } from '@app/actions/channels';
import { newId } from '@core/model/ids';
import type { Note, PatternId } from '@core/model/types';
import { addNotes, setStepCount } from '@core/ops/notes';
import { Rng } from '@agstudio/sdk/dsp/random';
import { openWindow } from './workspace/registry';

/** Dev-only stress fixtures: `?perf=notes10k` adds a channel with 10,000 notes and opens it. */
export function applyPerfFixture(s: Services, name: string): void {
  if (name !== 'notes10k') return;
  const cid = addInstrumentChannel(s, 'agstudio.3xosc');
  const pid = s.view.getState().currentPatternId as PatternId | null;
  if (!cid || !pid) return;
  const rng = new Rng(42);
  const notes: Note[] = [];
  for (let i = 0; i < 10000; i++) {
    notes.push({
      id: newId.note(),
      tick: Math.floor(rng.next() * 3840 * 64),
      length: 60 + Math.floor(rng.next() * 900),
      key: 36 + Math.floor(rng.next() * 48),
      velocity: 0.3 + rng.next() * 0.7,
    });
  }
  s.history.transact('Perf fixture', (d) => {
    addNotes(d, pid, cid, notes);
    setStepCount(d, pid, 16);
  });
  openWindow(s, 'piano-roll');
}
