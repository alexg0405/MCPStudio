import type { Tour } from '../tour-types';
import { showWindow } from './prepare';

/** Faders, snapshots, loudness meters, the Maximizer and matching a reference song. */
export const MIX_MASTER: Tour = {
  id: 'mix-master',
  title: 'Mixing and mastering',
  summary: 'Balance a mix, keep snapshots, read the meters, finish with the Maximizer and compare with a reference.',
  minutes: 4,
  area: 'Mixing',
  keywords: [
    'mix',
    'master',
    'mastering',
    'loudness',
    'lufs',
    'meters',
    'maximizer',
    'limiter',
    'reference',
    'snapshot',
    'eq',
    'compressor',
    'balance',
    'loud',
  ],
  windows: ['mixer', 'rack', 'mix-snapshots', 'meters', 'reference'],
  steps: [
    {
      id: 'strips',
      target: 'window:mixer',
      title: '1. Faders, sends and groups',
      body: 'Each strip has a fader, pan, mute and solo. Shift-click strips to pick several, then Group or Link them so they move together, and a VCA turns a whole group up or down. Send knobs feed a shared reverb or delay.',
      prepare: showWindow('mixer'),
    },
    {
      id: 'snapshots',
      target: 'window:mix-snapshots',
      title: '2. Snapshots: try without fear',
      body: 'Save keeps the whole mix: levels, pans, mutes, sends and effect settings. Recall puts it back in one undo step. Put two mixes on A and B and switch while the song plays to hear which is better.',
      prepare: showWindow('mix-snapshots'),
      tryIt: { label: 'Open Mix snapshots', command: 'view.mixSnapshots' },
    },
    {
      id: 'meters',
      target: 'window:meters',
      title: '3. Read the meters',
      body: 'The Meters window shows loudness (LUFS), true peak, stereo width and a spectrum of the master or any track, measured the way streaming services do. A target line shows where your style or reference should sit.',
      prepare: showWindow('meters'),
      tryIt: { label: 'Open the Meters', command: 'view.meters' },
    },
    {
      id: 'maximizer',
      target: 'window:mixer',
      title: '4. Finish with the Maximizer',
      body: 'On the master track, the Maximizer makes a mix louder without squashing it, and the Limiter after it stops peaks from clipping. The demo song already has both: click one in the master’s effect slots to open it and watch its gain reduction.',
      prepare: showWindow('mixer'),
    },
    {
      id: 'reference',
      target: 'window:reference',
      title: '5. Compare with a reference song',
      body: 'Choose a song you love as a reference. The window shows how your tempo, key, loudness and tone differ, and can match your tempo and key to it or arrange like it. Your reference is never exported.',
      prepare: showWindow('reference'),
      tryIt: { label: 'Open Reference', command: 'reference.open' },
    },
    {
      id: 'balance',
      target: 'menu:playlist',
      title: '6. Let Studio balance it',
      body: 'Playlist → Balance the mix listens to your song and sets the levels of every track for you, in one undo step. File → Loudness report… renders the song and tells you what Spotify, YouTube and Apple Music will do to it.',
    },
  ],
};
