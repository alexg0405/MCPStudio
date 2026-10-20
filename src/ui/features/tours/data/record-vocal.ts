import type { Tour } from '../tour-types';
import { showWindow } from './prepare';

/** From the microphone to a polished, harmonized vocal. */
export const RECORD_VOCAL: Tour = {
  id: 'record-vocal',
  title: 'Record and polish a vocal',
  summary: 'Pick your microphone, record takes, comp the best parts, tune, clean, align, add effects and harmonies.',
  minutes: 5,
  area: 'Recording',
  keywords: [
    'vocal',
    'record',
    'microphone',
    'mic',
    'takes',
    'comp',
    'pitch',
    'tune',
    'autotune',
    'cleanup',
    'noise',
    'harmonies',
    'singing',
    'voice',
  ],
  windows: ['pitch-editor', 'vocal-cleanup', 'vocal-align'],
  steps: [
    {
      id: 'input',
      target: 'menu:options',
      title: '1. Choose your microphone',
      body: 'Options → Audio input… picks the microphone, mono or stereo and which mixer track it records onto. Turn on Input monitoring to hear yourself (with headphones, or it will feed back), and Calibrate latency… once so recordings line up with the beat.',
      tryIt: { label: 'Open the audio input settings', command: 'options.audioInput' },
    },
    {
      id: 'record',
      target: 'tour:transport',
      title: '2. Record',
      body: 'Press Record to arm it, then play. A count-in plays first. Record over a loop and every pass becomes its own take. Set a punch range in the playlist ruler to record only one part of a line.',
    },
    {
      id: 'takes',
      target: 'window:playlist',
      title: '3. Choose the best takes (comp)',
      body: 'Passes recorded over a loop sit under one comp track; ▸ opens them. With the Comp tool, drag across the part of a take you like and it is used in the comp. [ and ] swap in the previous or next take, and comp crossfades keep the joins smooth.',
      prepare: showWindow('playlist'),
      tryIt: { label: 'Pick the Comp tool', command: 'playlist.tool.comp' },
    },
    {
      id: 'pitch',
      target: 'window:pitch-editor',
      title: '4. Fix the pitch',
      body: 'Select a sung audio clip, then Playlist → Pitch editor for the selected audio clip (or right-click the clip) opens its notes on a piano grid. Drag a note onto the right pitch, Snap to key pulls them all into the song key, and A/B compares with the original.',
      prepare: showWindow('pitch-editor'),
    },
    {
      id: 'cleanup',
      target: 'window:vocal-cleanup',
      title: '5. Clean it up',
      body: 'Playlist → Clean up vocal for the selected audio clip takes out background noise (learned from a quiet part), tones down breaths and repairs mouth clicks. It is made in the background as a new sound, your recording stays, and Undo goes back.',
      prepare: showWindow('vocal-cleanup'),
    },
    {
      id: 'align',
      target: 'window:vocal-align',
      title: '6. Line up doubles and ad-libs',
      body: 'Playlist → Align vocals… makes a double or a backing vocal follow the lead’s timing, syllable by syllable, with a Tightness knob. The same window can snap a vocal to the beat grid.',
      prepare: showWindow('vocal-align'),
    },
    {
      id: 'chain',
      target: 'menu:add',
      title: '7. Add a vocal effect chain',
      body: 'Select the vocal’s mixer track, then Add → Effect chain on the selected track: clean pop, rap, airy ballad, lo-fi, trap auto-tune or podcast, a whole row of effects in one click. You can save your own track as a chain too.',
    },
    {
      id: 'harmonies',
      target: 'menu:playlist',
      title: '8. Add harmonies',
      body: 'Playlist → Make harmonies… (or right-click the clip) turns a sung clip into one to four backing voices: a third above, a fifth below or the tones of your chord track. Hear them first, and one undo removes them all.',
    },
  ],
};
