import type { Tour } from '../tour-types';
import { showWindow } from './prepare';

/** The DJ auto-mix, the live decks and DJ controllers. */
export const DJ_MIXING: Tour = {
  id: 'dj-mixing',
  title: 'DJ mixing',
  summary: 'Auto-mix your songs, mix live on two decks, and connect a DJ controller.',
  minutes: 3,
  area: 'Performing',
  keywords: [
    'dj',
    'mix',
    'decks',
    'crossfader',
    'beatmatch',
    'sync',
    'controller',
    'turntable',
    'transition',
    'set',
    'party',
  ],
  windows: ['dj', 'dj-decks', 'dj-controllers'],
  steps: [
    {
      id: 'auto-mix',
      target: 'window:dj',
      title: '1. Let Studio mix your songs',
      body: 'DJ mix: add your own music files or a music folder, choose a shape (party, build, peak time, chill) and press Make the mix. Studio orders the songs by key and tempo, beat-matches them and builds each transition on the playlist.',
      prepare: showWindow('dj'),
      tryIt: { label: 'Open the DJ mix window', command: 'dj.open' },
    },
    {
      id: 'tweak',
      target: 'menu:file',
      title: '2. Tweak and export',
      body: 'Each transition sits on the playlist with a marker per song: change one, then File → Export the DJ mix… writes the whole mix as a file. Streaming-service songs cannot be used, because their audio is locked.',
    },
    {
      id: 'decks',
      target: 'window:dj-decks',
      title: '3. Mix live on two decks',
      body: 'DJ decks: load a song on each deck, press Sync to match tempos, and move the crossfader. Cue, hot cues, loops, beat jumps and key lock are on each deck. Record the live mix to keep it.',
      prepare: showWindow('dj-decks'),
      tryIt: { label: 'Open the DJ decks', command: 'decks.open' },
    },
    {
      id: 'controllers',
      target: 'window:dj-controllers',
      title: '4. Use a DJ controller',
      body: 'Plug in a DJ controller and connect it here. Link a Controller (MIDI learn) lets you teach any knob or button by touching it, so your own gear works with the decks.',
      prepare: showWindow('dj-controllers'),
      tryIt: { label: 'Open DJ controllers', command: 'dj.controllers.open' },
    },
  ],
};
