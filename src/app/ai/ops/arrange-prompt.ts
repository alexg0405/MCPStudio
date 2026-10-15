/**
 * The "Song craft" section of the studio prompt (order 20): how a song is built from sections and
 * beats, what the arranger does by itself, and a worked example (a trap song: three beats and one
 * arrange). `arrange.test.ts` applies the example and checks it comes out clean.
 */

/** The worked example's answer (a test parses and applies it). */
export const SONG_EXAMPLE = {
  message: 'Here is a dark trap song in F minor: an intro on keys and a bell, two verses, a build into the drop, a break and a bigger second drop, ending on a stop.',
  actions: [
    { op: 'song', bpm: 150, key: 'F minor' },
    {
      op: 'beat',
      pattern: 'new',
      ref: '@intro',
      title: 'Intro keys',
      bars: 2,
      tracks: [
        {
          name: 'Keys',
          sound: 'pad',
          notes: [
            { step: 0, len: 16, key: 53 },
            { step: 0, len: 16, key: 56 },
            { step: 0, len: 16, key: 60 },
            { step: 16, len: 16, key: 49 },
            { step: 16, len: 16, key: 53 },
            { step: 16, len: 16, key: 56 },
          ],
        },
        {
          name: 'Bell',
          sound: 'pluck',
          notes: [
            { step: 0, len: 2, key: 72 },
            { step: 3, len: 2, key: 75 },
            { step: 6, len: 2, key: 77 },
            { step: 8, len: 4, key: 79 },
            { step: 16, len: 2, key: 72 },
            { step: 19, len: 2, key: 75 },
            { step: 22, len: 2, key: 80 },
            { step: 24, len: 4, key: 79 },
          ],
        },
      ],
    },
    {
      op: 'beat',
      pattern: 'new',
      ref: '@verse',
      title: 'Verse beat',
      bars: 2,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 10 }, { step: 16 }, { step: 26 }] },
        { name: 'Clap', sound: 'clap', notes: [{ step: 8 }, { step: 24 }] },
        { name: 'Hat', sound: 'hat', notes: Array.from({ length: 16 }, (_, i) => ({ step: i * 2 })) },
        {
          name: '808',
          sound: '808',
          notes: [
            { step: 0, len: 10, key: 29 },
            { step: 10, len: 6, key: 29 },
            { step: 16, len: 10, key: 25 },
            { step: 26, len: 6, key: 27 },
          ],
        },
      ],
    },
    {
      op: 'beat',
      pattern: 'new',
      ref: '@drop',
      title: 'Drop beat',
      bars: 2,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 6 }, { step: 10 }, { step: 16 }, { step: 22 }, { step: 26 }] },
        { name: 'Clap', sound: 'clap', notes: [{ step: 8 }, { step: 24 }] },
        {
          name: 'Hat',
          sound: 'hat',
          notes: [...Array.from({ length: 16 }, (_, i) => ({ step: i * 2 })), { step: 13 }, { step: 29 }, { step: 30.5 }, { step: 31 }, { step: 31.5 }],
        },
        { name: 'Open hat', sound: 'open-hat', notes: [{ step: 14 }] },
        {
          name: '808',
          sound: '808',
          notes: [
            { step: 0, len: 6, key: 29 },
            { step: 6, len: 4, key: 29 },
            { step: 10, len: 7, key: 32 },
            { step: 16, len: 8, key: 25 },
            { step: 24, len: 8, key: 27 },
          ],
        },
        {
          name: 'Lead',
          sound: 'lead',
          notes: [
            { step: 0, len: 3, key: 77 },
            { step: 3, len: 3, key: 80 },
            { step: 6, len: 2, key: 79 },
            { step: 8, len: 6, key: 75 },
            { step: 16, len: 3, key: 77 },
            { step: 19, len: 3, key: 80 },
            { step: 22, len: 2, key: 84 },
            { step: 24, len: 6, key: 82 },
          ],
        },
      ],
    },
    {
      op: 'arrange',
      style: 'trap',
      sections: [
        { name: 'Intro', role: 'intro', bars: 8, energy: 1, play: ['@intro'] },
        { name: 'Verse', role: 'verse', bars: 8, energy: 3, play: ['@verse', '@intro'], without: ['Bell'] },
        { name: 'Verse 2', role: 'verse', bars: 8, energy: 3, play: ['@verse', '@intro'] },
        { name: 'Build', role: 'build', bars: 4, energy: 3, play: ['@verse', '@intro'], without: ['808'] },
        { name: 'Drop', role: 'drop', bars: 16, energy: 5, play: ['@drop', '@intro'], without: ['Bell'] },
        { name: 'Break', role: 'break', bars: 8, energy: 2, play: ['@intro'] },
        { name: 'Drop 2', role: 'drop', bars: 16, energy: 5, play: ['@drop', '@intro'] },
        { name: 'Outro', role: 'outro', bars: 8, energy: 1, play: ['@intro'], without: ['Bell'] },
      ],
    },
  ],
} as const;

const compact = (v: unknown) => JSON.stringify(v);

export const SONG_CRAFT = `Song craft (making and arranging songs). You decide the structure: the sections, which beats play in each, and the energy. The arranger does the craft: variations every 4 and 8 bars, fills that replace the drums, gaps before drops, risers, reverse crashes, impacts, crashes, filter sweeps, markers and the ending.
- Sections and their usual size and energy (1–5): intro 4–8 bars at 1–2, verse 8–16 at 3, build (pre-chorus) 4–8 rising, drop/hook/chorus 8–16 at 4–5, break 4–8 at 2, outro 4–8 at 1–2. Lengths in 4s and 8s (music phrases in 4 and 8 bars).
- Shape an energy arc: a sparse intro, verses, a build, the peak, a break, a bigger peak, an outro. The bar before a drop is the emptiest moment of the song (the arranger leaves a gap there).
- Bring something in or take something out every 4–8 bars: split a long section into two (the second with more playing), and leave parts out with without (an intro playing the drop's keys without its drums, a build without the 808).
- For a new song: one beat per kind of section with the beat action, pattern "new" and a ref ("@verse"), each a complete 2- or 4-bar loop at that section's energy; then ONE arrange action with every section in order, each playing beats by ref. Don't place the beats with place_pattern yourself, and never hand-place risers, impacts, crashes, sweeps, fades or automation for transitions: arrange (and develop, transition) add them, timed to the downbeat, on their own tracks.
- Arranging again (same from_bar) replaces your earlier arrangement and cleans up after itself.
- A song that already exists: develop adds the fills, variations and transitions in place (its cleanup removes stacked copies and makes fills on their own track replace the drums under them). transition adds one transition into a bar (auto, a kind, or one element). vary changes one spot: a fill, hat_roll, 808_slide, dropout or stutter at the end of a bar, thin, double_hats or without over bars, a crash at a bar, or a variant of a pattern to place yourself.
- Variants (patterns named like "Drop · fill + slide") follow their source pattern: to change the music, edit the source; its variants are rebuilt.
Example: "make me a dark trap song":
${compact(SONG_EXAMPLE)}`;
