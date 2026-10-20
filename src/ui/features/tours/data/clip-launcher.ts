import type { Tour } from '../tour-types';
import { showWindow } from './prepare';

/** Launching patterns and clips live, like a performance instrument. */
export const CLIP_LAUNCHER: Tour = {
  id: 'clip-launcher',
  title: 'Perform with the clip launcher',
  summary: 'Fill a grid with your patterns, launch them live and record the performance.',
  minutes: 3,
  area: 'Performing',
  keywords: ['launcher', 'clip', 'scene', 'live', 'perform', 'session', 'ableton', 'jam', 'launch', 'pads'],
  windows: ['launcher'],
  steps: [
    {
      id: 'grid',
      target: 'window:launcher',
      title: '1. The grid',
      body: 'Each column is a track and each row is a scene. A square holds a pattern or an audio clip. Click a square to launch it; it starts on the next beat or bar, so it always stays in time.',
      prepare: showWindow('launcher'),
      tryIt: { label: 'Open the clip launcher', command: 'launcher.open' },
    },
    {
      id: 'fill',
      target: 'window:launcher',
      title: '2. Fill it from your song',
      body: 'Put my patterns in the clip launcher fills the grid with the patterns you have already made. You can also send selected playlist clips to it, or drag a pattern or an audio file onto a square.',
      tryIt: { label: 'Put my patterns in the launcher', command: 'launcher.fromPatterns' },
    },
    {
      id: 'perform',
      target: 'window:launcher',
      title: '3. Play it live',
      body: 'Launch a whole row with a scene button and stop a track with its stop button. The launch quantize decides when things start: right now, the next beat, or the next bar. The number keys launch scenes, and a pad controller can play the grid.',
    },
    {
      id: 'record',
      target: 'menu:view',
      title: '4. Record your performance',
      body: 'View → Record performance to playlist writes what you launch onto the playlist as clips in time, so a jam turns into an arrangement you can edit. On a touch screen, tap to launch and hold a square for its menu.',
    },
  ],
};
