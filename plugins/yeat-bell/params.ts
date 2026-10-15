import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (dsp.worklet.ts).
export const ID = 'user.yeat-bell';

export const params = {
  decay: p.float(0.5, 12, 5, { label: 'Decay', unit: 's', scale: 'log', group: 'Bell', hint: 'How long the bell rings after each hit' }),
  brightness: p.float(0, 1, 0.6, { label: 'Brightness', unit: '%', group: 'Bell', hint: 'Level of the upper, shimmering partials' }),
  inharmonic: p.float(0, 1, 0.3, { label: 'Inharmonic', unit: '%', group: 'Bell', hint: 'How out-of-tune and clangy the partials are' }),
  strike: p.float(0, 1, 0.7, { label: 'Strike', unit: '%', group: 'Strike', hint: 'Level of the metallic hit at the start of each note' }),
  sub: p.float(0, 1, 0.5, { label: 'Sub', unit: '%', group: 'Sub', hint: 'Level of the sine one octave below the note, for kick-like weight' }),
  subDecay: p.float(0.1, 4, 1.2, { label: 'Sub Decay', unit: 's', scale: 'log', group: 'Sub', hint: 'How long the sub booms' }),
  drive: p.float(0, 1, 0.3, { label: 'Drive', unit: '%', group: 'Output', hint: 'Soft saturation: makes it louder and grittier' }),
  width: p.float(0, 1, 0.6, { label: 'Width', unit: '%', group: 'Output', hint: 'Stereo spread of the upper partials (the sub stays mono)' }),
  velSens: p.float(0, 1, 0.7, { label: 'Velocity', unit: '%', group: 'Output', hint: 'How much note velocity changes the loudness' }),
  level: p.float(-36, 6, -6, { label: 'Level', unit: 'dB', scale: 'db', group: 'Output', hint: 'Overall output level' }),
};
