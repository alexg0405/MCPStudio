import type { Tour } from '../tour-types';
import { showBrowser, showWindow } from './prepare';

/** Beats, melody, arrangement, mix and export: the road from nothing to a finished file. */
export const FIRST_SONG: Tour = {
  id: 'first-song',
  title: 'Make your first song',
  summary: 'A beat, a melody, an arrangement, a mix and an exported file.',
  minutes: 4,
  area: 'Getting started',
  keywords: ['beat', 'song', 'melody', 'arrange', 'export', 'wav', 'mp3', 'first', 'make music', 'drums', 'sample'],
  windows: ['channel-rack', 'piano-roll', 'playlist', 'samples'],
  steps: [
    {
      id: 'sounds',
      target: 'tour:browser',
      title: '1. Pick your sounds',
      body: 'The browser holds your drum sounds, instruments, effects and ready-made patterns. Click a sound to hear it; double-click to add it. Your own sample folders are in the Sample browser, where every sound is sorted by what it is, its tempo and its key.',
      prepare: showBrowser,
      tryIt: { label: 'Open the Sample browser', command: 'samples.open' },
    },
    {
      id: 'beat',
      target: 'window:channel-rack',
      title: '2. Make a beat',
      body: 'Each row is a sound; each square is a sixteenth of a bar. Click squares to turn them on (drag to paint). The pattern loops while it plays. The Steps menu fills, shifts and randomizes a row.',
      prepare: showWindow('channel-rack'),
    },
    {
      id: 'melody',
      target: 'window:piano-roll',
      title: '3. Write a melody',
      body: 'The piano roll draws notes for the sound selected in the channel rack. Click to add a note, drag its edge to make it longer, and use Tools for quantize, chords and arpeggios. Set the song key and the roll highlights the notes that fit.',
      prepare: showWindow('piano-roll'),
    },
    {
      id: 'song',
      target: 'window:playlist',
      title: '4. Arrange the song',
      body: 'The playlist puts patterns on a timeline. Drag in a track to place the current pattern, then drag clips to move them. Drag across the ruler to loop a part. Switch PAT to SONG in the toolbar to hear the whole arrangement.',
      prepare: showWindow('playlist'),
    },
    {
      id: 'play',
      target: 'tour:transport',
      title: '5. Play it',
      body: 'Press {key:transport.playPause} to play and stop. PAT loops the pattern you are editing; SONG plays the playlist. Drag the BPM number to change the tempo.',
    },
    {
      id: 'mix',
      target: 'window:mixer',
      title: '6. Balance the mix',
      body: 'Every sound plays through a mixer track. Pull the faders until nothing hides anything else, add reverb or an EQ in the effect slots, and keep the master meter out of the red.',
      prepare: showWindow('mixer'),
    },
    {
      id: 'export',
      target: 'menu:file',
      title: '7. Export it',
      body: 'File → Export audio… writes a WAV, FLAC or MP3 of the song. The same menu has stems (one file per track), MIDI and Export as video for a music video. File → Save keeps the project itself.',
    },
  ],
};
