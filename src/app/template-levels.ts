import type { LeveledBus } from './mix/auto-level';

/**
 * The mix levels each template is built with: what `autoLevel` measured and set on the template's own song (the busiest 8 bars, its style's
 * loudness within 0.5 dB at the time), baked in so that opening a template needs no rendering. A bus fader in dB, the Limiter's input, and
 * the Maximizer's input when the style's loudness needs one (null: the Limiter alone).
 *
 * They go stale when the beat generator, the arranger or the mix recipes change. `test/browser/template-levels.test.ts` renders every
 * template and fails when one is more than 1 dB from its style's loudness; run it with `VITE_BAKE_TEMPLATE_LEVELS=1` to print this
 * table again (`VITE_BAKE_TEMPLATE_LEVELS=1 npx vitest run --project audio test/browser/template-levels.test.ts`, the `TEMPLATE_LEVELS |` lines).
 */
export interface TemplateLevels {
  faders: Partial<Record<LeveledBus, number>>;
  limiter: number;
  maximizer: number | null;
}

export const TEMPLATE_LEVELS: Readonly<Record<string, TemplateLevels>> = {
  "drill": {"faders":{"kick":-2.05,"drums":-3.3,"bass":-3.43},"limiter":7.75,"maximizer":null}, // -9.97 LUFS (target -10)
  "trap": {"faders":{"kick":-1.25,"drums":-4.39,"bass":-3.02},"limiter":8.06,"maximizer":null}, // -10.34 LUFS (target -10)
  "boom-bap": {"faders":{"kick":2.28,"drums":1.68,"bass":-5.07},"limiter":8.28,"maximizer":null}, // -11.15 LUFS (target -11)
  "lofi": {"faders":{"kick":2.87,"drums":-1.25,"bass":-4.75,"chords":-1.7},"limiter":5.26,"maximizer":null}, // -12.63 LUFS (target -13)
  "house": {"faders":{"kick":1.33,"drums":-2.69,"bass":-1.99},"limiter":0,"maximizer":16.08}, // -9.57 LUFS (target -9.5)
  "big-room": {"faders":{"kick":-0.1,"drums":-3.98,"bass":-2.99,"chords":-0.65,"lead":-1.96},"limiter":0,"maximizer":10.61}, // -8.59 LUFS (target -8.5)
  "progressive-house": {"faders":{"kick":-0.18,"drums":-3.48,"bass":-4.59,"chords":-0.65,"lead":-5.32},"limiter":10,"maximizer":null}, // -10.32 LUFS (target -10)
  "dubstep": {"faders":{"kick":-0.59,"drums":-5.88,"bass":-5.74},"limiter":0,"maximizer":10.23}, // -8.71 LUFS (target -8.5)
  "future-bass": {"faders":{"kick":-1.41,"drums":-6.61,"bass":-5.23,"chords":-1.41,"lead":-1.83},"limiter":0,"maximizer":9.8}, // -8.88 LUFS (target -9)
  "melodic-dubstep": {"faders":{"kick":0.1,"drums":-5.32,"bass":-3.94,"chords":-2.28,"lead":-2.01},"limiter":10,"maximizer":null}, // -9.92 LUFS (target -9.5)
  "drum-and-bass": {"faders":{"kick":0.34,"drums":-1.53,"bass":-2.06},"limiter":0,"maximizer":10.44}, // -9.25 LUFS (target -9)
  "trance": {"faders":{"kick":-0.42,"drums":-3.98,"bass":-2.66,"chords":-0.42,"lead":-5.93},"limiter":0,"maximizer":10.97}, // -9.26 LUFS (target -9)
  "tech-house": {"faders":{"kick":-0.06,"drums":-2.37,"bass":-2.14,"chords":-5,"lead":2.13},"limiter":0,"maximizer":10.38}, // -9.97 LUFS (target -10)
};
