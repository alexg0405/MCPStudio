/**
 * An offline song as an AI answer: the same actions Studio's AI would write for a song (the key and tempo, the chord track,
 * one beat per pattern, one arrange), so applying it, undoing it, leveling the mix and playing it all work exactly as they do
 * for an AI's song. Pure: no services, nothing is written here.
 */
import { pitchName } from '@core/harmony/chord';
import type { SongPlan } from '@core/song/types';
import type { AiAction, AiAnswer } from '../ai/schema';

/** The song's key as the `song` action reads it ("F# minor"). */
const keyText = (plan: SongPlan): string => `${pitchName(plan.key.root, false)} ${plan.key.minor ? 'minor' : 'major'}`;

/** The actions that write a song plan into a project. */
export function songToAnswer(plan: SongPlan): AiAnswer {
  const actions: AiAction[] = [
    { op: 'song', bpm: plan.bpm, swing: plan.swing, key: keyText(plan) },
    {
      op: 'chords',
      action: 'set',
      text: plan.chordLine.text,
      bars_per_chord: plan.chordLine.barsPerChord,
      from_bar: 1,
    },
  ];
  for (const pattern of plan.patterns) {
    const { spec } = pattern;
    actions.push({
      op: 'beat',
      pattern: 'new',
      ref: pattern.ref,
      title: spec.title,
      bars: spec.bars,
      ...(spec.style ? { style: spec.style } : {}),
      tracks: spec.tracks,
    });
  }
  actions.push({
    op: 'arrange',
    style: plan.style,
    sections: plan.sections.map((section) => ({
      name: section.name,
      bars: section.bars,
      role: section.role,
      energy: section.energy,
      play: section.play,
      ...(section.without.length > 0 ? { without: section.without } : {}),
    })),
    fx: 'auto',
    mix: 'auto',
    outro: 'auto',
  });
  // The arranger would level the mix on the song's first seconds, which are the intro. A song is as loud as its loudest part,
  // so the leveling listens there instead (the last level_mix of an answer is the one that runs).
  actions.push({ op: 'level_mix', style: plan.style, ...loudestPart(plan) });
  return { message: plan.message, actions };
}

/** The most bars the leveling listens to, as the AI's own level_mix does. */
const LISTENING_BARS = 8;

/** Where the song is loudest: the first section at the highest energy, as the bar it starts on (1-based) and how many bars to listen to. */
function loudestPart(plan: SongPlan): { from_bar: number; bars: number } {
  const peak = Math.max(...plan.sections.map((section) => section.energy));
  let startBar = 1;
  for (const section of plan.sections) {
    if (section.energy === peak) return { from_bar: startBar, bars: Math.min(LISTENING_BARS, section.bars) };
    startBar += section.bars;
  }
  return { from_bar: 1, bars: LISTENING_BARS };
}
