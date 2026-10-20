import { produce } from 'immer';
import { makePattern, makePluginInstance, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type ChannelId, type Note, type PatternClip, type PatternId, type Project } from '@core/model/types';
import { placeChords } from '@core/ops/chords';
import { addChannel } from '@core/ops/channels';
import { addFxSlot } from '@core/ops/mixer';
import { addNote, setBpm, setSongKey, setStep } from '@core/ops/notes';
import { addClips, addPattern } from '@core/ops/playlist';
import { PPQ } from '@core/time/ppq';
import { defaultValues } from '@agstudio/sdk';
import { createDefaultProject, instrumentChannelFor } from './default-project';
import type { PluginRegistry } from './plugins/registry';

/** The name the demo song goes by, in the title bar, the project list and the recovery list. */
export const DEMO_TITLE = 'Tour demo (safe to discard)';

const SYNTH_ID = 'agstudio.3xosc';
const REVERB = 'agstudio.reverb';
const MAXIMIZER = 'agstudio.maximizer';
const LIMITER = 'agstudio.limiter';

/** Ticks in one bar of 4/4. */
const BAR = PPQ * 4;
/** Ticks in one 1/16 step. */
const STEP = PPQ / 4;
const A_MINOR = { root: 9, scale: 'minor' } as const;

/** Chords of the demo, one per bar: Am, F, C, G as root pitch class and quality id. */
const PROGRESSION = [
  { root: 9, quality: 'min' },
  { root: 5, quality: 'maj' },
  { root: 0, quality: 'maj' },
  { root: 7, quality: 'maj' },
] as const;

/** A bass note per bar to go with the chords (MIDI, an octave and a half under middle C). */
const BASS_KEYS = [45, 41, 48, 43] as const;
/** The chord tones the keys play, per bar (MIDI): Am, F, C, G. */
const KEYS_TRIADS: readonly (readonly number[])[] = [
  [57, 60, 64],
  [53, 57, 60],
  [55, 60, 64],
  [55, 59, 62],
];

const note = (tick: number, length: number, key: number, velocity = 0.8): Note => ({
  id: newId.note(),
  tick,
  length,
  key,
  velocity,
});

/**
 * The song every guided tour runs on: a four-bar beat with a bass and chords, a second pattern, both placed in the
 * playlist, a chord track, a little reverb and a mastering chain. It is small on purpose and made from the same
 * pieces a musician's project is made of, so every window a tour opens has something to show. It is built fresh each
 * time (new ids), and it is not the musician's: the tour puts their own project back when it ends.
 */
export function createDemoProject(registry: PluginRegistry): Project {
  const base = createDefaultProject(registry);
  const synth = registry.get(SYNTH_ID);
  return produce(base, (d) => {
    d.meta.title = DEMO_TITLE;
    setBpm(d, 118);
    setSongKey(d, A_MINOR);

    const verse = d.patterns[d.patternOrder[0] as PatternId];
    if (verse) verse.name = 'Verse';
    const chorus = makePattern('Chorus', paletteColor(2));
    addPattern(d, chorus);
    const verseId = d.patternOrder[0] as PatternId;
    const byName = (name: string) =>
      d.channelOrder.find((id) => d.channels[id]?.name === name) as ChannelId | undefined;

    // The beat: kick on every beat, clap on 2 and 4, hats on the off-beats, a snare ghost.
    const beat: [string, number[]][] = [
      ['Kick', [0, 4, 8, 12]],
      ['Clap', [4, 12]],
      ['Hat', [2, 6, 10, 14]],
      ['Snare', [7, 15]],
    ];
    for (const pattern of [verseId, chorus.id]) {
      for (const [name, steps] of beat) {
        const id = byName(name);
        if (!id) continue;
        for (const step of steps) setStep(d, pattern, id, step, true, { rootKey: 60 });
      }
    }

    if (synth) {
      const bass = instrumentChannelFor(synth, 'Bass', d.channelOrder.length);
      bass.output = d.mixer.order[1] ?? MASTER;
      const keys = instrumentChannelFor(synth, 'Keys', d.channelOrder.length + 1);
      keys.output = d.mixer.order[2] ?? MASTER;
      addChannel(d, bass);
      addChannel(d, keys);
      PROGRESSION.forEach((_, bar) => {
        addNote(d, verseId, bass.id, note(bar * BAR, BAR - STEP, BASS_KEYS[bar] ?? 45, 0.85));
        for (const key of KEYS_TRIADS[bar] ?? []) addNote(d, chorus.id, keys.id, note(bar * BAR, BAR, key, 0.7));
      });
    }

    // Verse for four bars, then the chorus for four bars, on the first two tracks.
    const lanes = d.playlist.laneOrder;
    const clip = (patternId: PatternId, laneIndex: number, bar: number): PatternClip => ({
      kind: 'pattern',
      id: newId.clip(),
      laneId: lanes[laneIndex] as PatternClip['laneId'],
      start: bar * BAR,
      length: BAR * 4,
      patternId,
      offset: 0,
    });
    addClips(d, [clip(verseId, 0, 0), clip(chorus.id, 1, 4)]);

    placeChords(
      d,
      PROGRESSION.map((c, bar) => ({ tick: bar * BAR, length: BAR, chord: { root: c.root, quality: c.quality } })),
    );

    // A bit of room on the second mixer track and a mastering chain, so the mixer and the meters have something to show.
    const reverb = registry.get(REVERB);
    const reverbTrack = d.mixer.order[2];
    if (reverb && reverbTrack)
      addFxSlot(d, reverbTrack, makePluginInstance(reverb.id, reverb.version, defaultValues(reverb.params)));
    for (const id of [MAXIMIZER, LIMITER]) {
      const def = registry.get(id);
      if (def) addFxSlot(d, MASTER, makePluginInstance(def.id, def.version, defaultValues(def.params)));
    }
  });
}
