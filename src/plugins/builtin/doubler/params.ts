import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DOUBLER_ID = 'agstudio.doubler';

export const doublerParams = {
  voices: p.int(2, 4, 2, {
    label: 'Voices',
    group: 'Doubles',
    hint: 'How many extra takes are layered under the voice: 2 is one on each side, 4 is a small crowd',
  }),
  delay: p.float(10, 50, 22, {
    label: 'Delay',
    unit: 'ms',
    group: 'Doubles',
    hint: 'How far behind the original the doubles sing. Around 15-25 ms sounds like a second take; longer starts to sound like an echo',
  }),
  spread: p.float(0, 1, 0.5, {
    label: 'Timing spread',
    unit: '%',
    group: 'Doubles',
    hint: 'How different the voices’ timings are from each other (0% = all behind by the same amount, which sounds like a chorus; more sounds like separate takes)',
  }),
  drift: p.float(0, 15, 6, {
    label: 'Pitch drift',
    unit: 'ct',
    group: 'Doubles',
    hint: 'How far each double wanders sharp and flat, in cents (100 cents = one semitone). A few cents sounds like a real second performance; more is wobbly',
  }),
  width: p.float(0, 1, 0.8, {
    label: 'Width',
    unit: '%',
    group: 'Stereo',
    hint: 'How far the doubles are spread to the left and right (0% = all in the middle, 100% = hard left and right). The original stays in the middle',
  }),
  level: p.float(-24, 0, -9, {
    label: 'Double level',
    unit: 'dB',
    scale: 'db',
    group: 'Stereo',
    hint: 'How loud the doubles are against the original. Quiet doubles thicken the voice; loud ones sound like a duet. Keep them low for a clean mono sum',
  }),
  tone: p.float(2000, 20000, 10000, {
    label: 'Brightness',
    unit: 'Hz',
    scale: 'log',
    group: 'Stereo',
    hint: 'Rolls the highs off the doubles so they sit behind the lead voice (lower is darker and further back)',
  }),
};
