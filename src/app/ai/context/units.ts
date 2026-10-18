import { gainToDecibels } from '@core/model/fader';

/** Rounds to two decimals: the precision the project text shows. */
export const round2 = (value: number) => Math.round(value * 100) / 100;

/** A fader gain as text in dB ("-3.5 dB"; "-inf dB" for silence). */
export const formatDb = (gain: number) => (gain <= 0 ? '-inf dB' : `${round2(gainToDecibels(gain))} dB`);
