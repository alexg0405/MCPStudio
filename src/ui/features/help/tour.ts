import type { Services } from '@app/services';
import { openWindow } from '../../workspace/registry';

/**
 * The guided tour: one step per part of the app, highlighted in place. `anchor` is a CSS selector;
 * `prepare` makes sure it is on screen (opens the window it points at). `{key:command}` in a body
 * becomes that command's shortcut on this computer.
 */
export interface TourStep {
  anchor: string;
  title: string;
  body: string;
  prepare?(s: Services): void;
}

const show = (type: string) => (s: Services) => {
  openWindow(s, type);
};

export const TOUR: readonly TourStep[] = [
  {
    anchor: '[data-tour="browser"]',
    title: 'Browser',
    body: 'Your sounds, instruments, effects and patterns. Click a sound to hear it and double-click it to add it. Click an instrument to add it as a new channel.',
    prepare: (s) => {
      if (!s.view.getState().browser.visible) s.commands.run('view.browser');
    },
  },
  {
    anchor: '[data-window-type="channel-rack"]',
    title: 'Channel rack: your beat',
    body: 'Each row is a sound or instrument. Click the squares to turn steps on; the pattern loops them. Right-click a row to open its piano roll, rename it or change its color.',
    prepare: show('channel-rack'),
  },
  {
    anchor: '[data-tour="transport"]',
    title: 'Play, stop, record',
    body: 'Space plays and stops. PAT loops the current pattern; SONG plays the whole Playlist. The tempo (BPM) is a number you drag up or down.',
  },
  {
    anchor: '[data-window-type="piano-roll"]',
    title: 'Piano roll: melodies',
    body: 'Click to draw notes, drag them to move or stretch them, right-click to delete. It edits the channel selected in the Channel rack.',
    prepare: show('piano-roll'),
  },
  {
    anchor: '[data-window-type="playlist"]',
    title: 'Playlist: your song',
    body: 'Arrange patterns over time. Click in a lane to place the current pattern and drag to move it. Switch the transport to SONG to hear the arrangement.',
    prepare: show('playlist'),
  },
  {
    anchor: '[data-window-type="mixer"]',
    title: 'Mixer: levels and effects',
    body: 'Every channel plays through a mixer track. Click a track to select it, set its volume and pan, and add effects to its slots. Tracks can also send to each other, for example to a shared reverb.',
    prepare: show('mixer'),
  },
  {
    anchor: '[data-tour="assistant"]',
    title: 'AI studio',
    body: 'Ask in your own words: “make a lo-fi beat”, “add reverb to the snare”, “turn the 808 down”. The AI can change anything in the project, and every answer can be undone.',
  },
  {
    anchor: '[data-tour="hints"]',
    title: 'Help is everywhere',
    body: 'Point at anything and this bar (and a tooltip) explains it. Press {key:help.palette} and type what you want to do. Help → Getting started brings this back.',
  },
];
