import type { Tour } from '../tour-types';
import { showBrowser, showWindow } from './prepare';

/** The first look at the main parts of AGstudio (Help → Take the tour, and "Show me around" on the welcome screen). */
export const OVERVIEW: Tour = {
  id: 'overview',
  title: 'A quick look around',
  summary: 'The main parts of AGstudio and where to find help.',
  minutes: 2,
  area: 'Getting started',
  keywords: ['tour', 'welcome', 'basics', 'start', 'new', 'around', 'help'],
  windows: [
    'shortcuts',
    'keyboard-help',
    'settings',
    'history',
    'projects',
    'versions',
    'piano-keyboard',
    'keys',
    'visualizer',
    'plugin',
    'help',
    'features',
  ],
  steps: [
    {
      id: 'browser',
      target: 'tour:browser',
      title: 'Browser',
      body: 'Your sounds, instruments, effects and patterns. Click a sound to hear it and double-click it to add it. Click an instrument to add it as a new channel.',
      prepare: showBrowser,
    },
    {
      id: 'channel-rack',
      target: 'window:channel-rack',
      title: 'Channel rack: your beat',
      body: 'Each row is a sound or instrument. Click the squares to turn steps on; the pattern loops them. Right-click a row to open its piano roll, rename it or change its color.',
      prepare: showWindow('channel-rack'),
    },
    {
      id: 'transport',
      target: 'tour:transport',
      title: 'Play, stop, record',
      body: 'Space plays and stops. PAT loops the current pattern; SONG plays the whole Playlist. The tempo (BPM) is a number you drag up or down.',
    },
    {
      id: 'piano-roll',
      target: 'window:piano-roll',
      title: 'Piano roll: melodies',
      body: 'Click to draw notes, drag them to move or stretch them, right-click to delete. It edits the channel selected in the Channel rack.',
      prepare: showWindow('piano-roll'),
    },
    {
      id: 'playlist',
      target: 'window:playlist',
      title: 'Playlist: your song',
      body: 'Arrange patterns over time. Drag in a track to place the current pattern (a click on an empty spot opens a menu: place a pattern, paste, ask Studio…), and drag clips to move them. Switch the transport to SONG to hear the arrangement.',
      prepare: showWindow('playlist'),
    },
    {
      id: 'mixer',
      target: 'window:mixer',
      title: 'Mixer: levels and effects',
      body: 'Every channel plays through a mixer track. Click a track to select it, set its volume and pan, and add effects to its slots. Tracks can also send to each other, for example to a shared reverb.',
      prepare: showWindow('mixer'),
    },
    {
      id: 'studio',
      target: 'tour:assistant',
      title: 'Studio',
      body: 'Ask in your own words: “make a lo-fi beat”, “add reverb to the snare”, “turn the 808 down”. Studio can change anything in the project, and every answer can be undone.',
    },
    {
      id: 'windows',
      target: 'tour:windows',
      title: 'More windows',
      body: 'These buttons open the rest: the on-screen Keys, Visualizer, undo History, Versions, Projects and Settings. They are all in the View menu too, and every window has a ? in its title bar with its main moves.',
    },
    {
      id: 'help',
      target: 'tour:hints',
      title: 'Help is everywhere',
      body: 'Point at anything and this bar (and a tooltip) explains it. Press {key:help.palette} and type what you want to do, or type “learn” to find a tour. Help → Help and tours, Features and What’s new bring all of this back.',
    },
  ],
};
