import type { Services } from '@app/services';
import { addInstrumentChannel } from '@app/actions/channels';
import { addEffect, addMixerInsert } from '@app/actions/mixer';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import { buildHugeSong } from '@app/fixtures/huge-song';
import { newId, seededBytes, setIdSource } from '@core/model/ids';
import type { InsertId, Note, PatternId } from '@core/model/types';
import { KIT, kitPiece } from '@core/model/kit';
import { makePattern, paletteColor } from '@core/model/defaults';
import { addChannel, addSample } from '@core/ops/channels';
import { addNotes, setStep, setStepCount } from '@core/ops/notes';
import { addClips, addPattern } from '@core/ops/playlist';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '@app/default-project';
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

/** A long rack, like the songs an earlier AI arranged: 150 channels in all and three step patterns to switch between. */
function rack150(s: Services, total = 150): void {
  const sampler = s.plugins.get(SAMPLER_ID);
  if (!sampler) return;
  const rng = new Rng(11);
  const patternIds: PatternId[] = [s.view.getState().currentPatternId as PatternId];
  s.history.transact('Perf fixture', (d) => {
    for (let k = 1; k < 3; k++) {
      const pattern = makePattern(`Pattern ${k + 1}`, paletteColor(k));
      addPattern(d, pattern);
      patternIds.push(pattern.id);
    }
    const have = d.channelOrder.length;
    for (let i = 0; i < total - have; i++) {
      const piece = KIT[i % KIT.length]!;
      const sample = kitSampleRef(piece.generator);
      addSample(d, sample);
      const ch = instrumentChannelFor(sampler, `${kitPiece(piece.generator)?.short ?? piece.generator} ${i + 1}`, i, { main: sample.id });
      addChannel(d, ch);
      patternIds.forEach((pid, k) => {
        // Each pattern plays on about a fifth of the channels (the others are empty in it), like an arranged song.
        if ((i + 2 * k) % 5) return;
        for (let step = 0; step < 16; step++) if (rng.next() < 0.3) setStep(d, pid, ch.id, step, true, { rootKey: ch.rootKey });
      });
    }
  });
  openWindow(s, 'channel-rack');
}

/** A 113-bar song shaped like one an earlier AI arranged, with its ending stacked three times. */
function stackedSong(s: Services): void {
  s.history.transact('Perf fixture', (d) => void buildStackedSong(d));
  s.view.getState().setMode('song');
  openWindow(s, 'playlist');
}

/** Seed of the ids of the huge project. */
const HUGE_ID_SEED = 20260;

/**
 * The very big project (see `app/fixtures/huge-song.ts`), opened on its playlist in song mode; the piano roll and
 * rack scenarios of `scripts/perf-huge.mjs` open the windows they need.
 */
function huge(s: Services): void {
  let built!: ReturnType<typeof buildHugeSong>;
  // Seeded ids: the same project (and so the same render) on every load, which is what a before/after comparison needs.
  const previousIds = setIdSource(seededBytes(HUGE_ID_SEED));
  try {
    s.history.transact('Perf fixture', (d) => {
      built = buildHugeSong(d);
    });
  } finally {
    setIdSource(previousIds);
  }
  s.view.getState().setCurrentPattern(built.bigPattern);
  s.session.getState().selectChannel(built.bigChannel);
  s.view.getState().setMode('song');
  openWindow(s, 'playlist');
}

/**
 * Dev-only fixtures: `?perf=notes10k` adds a channel with 10,000 notes and opens it;
 * `?perf=mix30` builds a busy song (30 channels, 20 effects) to play; `?perf=stacked-song` loads a long
 * AI-arranged song with stacked copies (for Clean up the song and asking about parts); `?perf=rack150` fills the
 * channel rack with 150 channels and three patterns (switch patterns to time the rack's re-render); `?perf=huge` loads the
 * very big project.
 */
export function applyPerfFixture(s: Services, name: string): void {
  if (name === 'mix30') return mix30(s);
  if (name === 'stacked-song') return stackedSong(s);
  if (name === 'rack150') return rack150(s);
  if (name === 'huge') return huge(s);
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
