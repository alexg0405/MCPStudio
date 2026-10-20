import type { Tour } from '../tour-types';
import { showChordLane, showWindow } from './prepare';

/** The chord track and what is written from it. */
export const HARMONY_CHORDS: Tour = {
  id: 'harmony-chords',
  title: 'Harmony and the chord track',
  summary:
    'Put chords on a track, then write chords, a bass line, a melody and harmonies that fit them, and add lyrics.',
  minutes: 3,
  area: 'Harmony',
  keywords: [
    'chord',
    'chords',
    'harmony',
    'progression',
    'bass',
    'bassline',
    'melody',
    'key',
    'scale',
    'detect',
    'roman',
  ],
  windows: ['chords', 'lyrics'],
  steps: [
    {
      id: 'lane',
      target: 'window:playlist',
      title: '1. The chord lane',
      body: 'The chord lane runs above the playlist: one chord per stretch of the song, lined up with the bars. Click to place a chord and drag its edges to resize. Playlist → Show the chord lane turns it on or off.',
      prepare: showChordLane,
      tryIt: { label: 'Show the chord lane', command: 'chords.showLane' },
    },
    {
      id: 'chords-window',
      target: 'window:chords',
      title: '2. Type, detect or pick a progression',
      body: 'The Chords window types chords from text (Am7 | F | C | G), detects them from the song you play or an audio clip, and offers progressions by mood or genre, shown with Roman numerals in your key.',
      prepare: showWindow('chords'),
      tryIt: { label: 'Open the Chords window', command: 'view.chords' },
    },
    {
      id: 'write',
      target: 'menu:edit',
      title: '3. Write parts that fit',
      body: 'Edit → Make chords from the chord track writes voiced chords with smooth voice leading. Make a bassline from the chord track follows the roots or an 808 pattern, and Fit the melody to the chords nudges a melody onto chord and scale tones. Each is one undo step.',
    },
    {
      id: 'roll',
      target: 'window:piano-roll',
      title: '4. See the chords in the piano roll',
      body: 'The piano roll can highlight the chord tones under the playhead or the rows of the song’s scale, and lock notes to the scale. Right-click an empty spot for the chord track entries.',
      prepare: showWindow('piano-roll'),
    },
    {
      id: 'harmonies',
      target: 'menu:playlist',
      title: '5. Harmonies from a vocal',
      body: 'Playlist → Make harmonies… builds backing voices from a sung clip, using the chord track for the notes. Update harmonies redoes them when the vocal, the chords or the key change.',
    },
    {
      id: 'lyrics',
      target: 'window:lyrics',
      title: '6. Lyrics',
      body: 'Paste your words, one line per line, and they go onto the notes you selected, the notes sung in an audio clip, or evenly over the bars. The Lyrics window shows them big and follows the song so you can read along while you record.',
      prepare: showWindow('lyrics'),
      tryIt: { label: 'Open the Lyrics window', command: 'view.lyrics' },
    },
  ],
};
