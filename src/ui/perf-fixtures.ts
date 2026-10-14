import type { Services } from '@app/services';
import { addInstrumentChannel } from '@app/actions/channels';
import { addEffect, addMixerInsert } from '@app/actions/mixer';
import { newId } from '@core/model/ids';
import type { InsertId, Note, PatternId } from '@core/model/types';
import { addNotes, setStepCount } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { Rng } from '@agstudio/sdk/dsp/random';
import { openWindow } from './workspace/registry';

/** A busy song: 30 channels across the built-in instruments, 20 effects on 10 mixer tracks, 8 × 4 bars. */
function mix30(s: Services): void {
  const instruments = [
    ...Array<string>(6).fill('agstudio.3xosc'),
    ...Array<string>(6).fill('agstudio.wavetable'),
    ...Array<string>(4).fill('agstudio.fm'),
    ...Array<string>(2).fill('agstudio.drum-synth'),
    ...Array<string>(2).fill('agstudio.drum-pads'),
    ...Array<string>(4).fill('agstudio.pluck'),
    ...Array<string>(2).fill('agstudio.bass808'),
  ];
  const pid = s.view.getState().currentPatternId as PatternId | null;
  if (!pid) return;
  const rng = new Rng(7);
  const tracks = Array.from({ length: 10 }, (_, i) => addMixerInsert(s, i));
  const effects = ['agstudio.eq-pro', 'agstudio.compressor', 'agstudio.reverb', 'agstudio.delay', 'agstudio.chorus', 'agstudio.saturator', 'agstudio.stereo', 'agstudio.limiter', 'agstudio.multiband', 'agstudio.phaser'];
  for (let i = 0; i < 20; i++) addEffect(s, tracks[i % tracks.length] as InsertId, effects[i % effects.length] as string);
  const channels = instruments.map((id) => addInstrumentChannel(s, id)).filter((c): c is NonNullable<typeof c> => !!c);
  s.history.transact('Perf fixture', (d) => {
    channels.forEach((cid, i) => {
      const ch = d.channels[cid];
      if (ch && ch.kind !== 'automation') ch.output = tracks[i % tracks.length] as InsertId;
      const notes: Note[] = [];
      const drums = i >= 16 && i < 20;
      for (let step = 0; step < 64; step++) {
        if (rng.next() > (drums ? 0.7 : 0.35)) continue;
        const chord = drums ? 1 : 1 + Math.floor(rng.next() * 3);
        for (let c = 0; c < chord; c++)
          notes.push({
            id: newId.note(),
            tick: step * 240,
            length: drums ? 120 : 240 + Math.floor(rng.next() * 3) * 240,
            key: drums ? 36 + Math.floor(rng.next() * 12) : 48 + Math.floor(rng.next() * 24),
            velocity: 0.5 + rng.next() * 0.5,
          });
      }
      addNotes(d, pid, cid, notes);
    });
    setStepCount(d, pid, 64);
    const lane = d.playlist.laneOrder[0];
    if (lane)
      addClips(
        d,
        Array.from({ length: 8 }, (_, k) => ({ kind: 'pattern' as const, id: newId.clip(), laneId: lane, start: k * 4 * 3840, length: 4 * 3840, patternId: pid, offset: 0 })),
      );
  });
  s.view.getState().setMode('song');
  openWindow(s, 'playlist');
  openWindow(s, 'mixer');
}

/**
 * Dev-only stress fixtures: `?perf=notes10k` adds a channel with 10,000 notes and opens it;
 * `?perf=mix30` builds a busy song (30 channels, 20 effects) to play.
 */
export function applyPerfFixture(s: Services, name: string): void {
  if (name === 'mix30') return mix30(s);
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
