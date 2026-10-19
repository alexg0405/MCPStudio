import { formatValue, type ParamValue, type PluginUIProps } from '@agstudio/sdk';
import { hasGain, type BandType } from './design.kernel';
import { BAND_COUNT, bandIds, TYPE_LABELS, type eqProParams } from './params';

export type EqProProps = PluginUIProps<typeof eqProParams>;

/** One band's settings as the editor reads them. */
export interface BandView {
  /** The band's number, 1 to 8. */
  number: number;
  isOn: boolean;
  type: BandType;
  frequencyHz: number;
  gainDb: number;
  q: number;
}

/** The bands' settings from the param values (band params are addressed by id strings: b3Freq…). */
export function readBands(values: Record<string, ParamValue>): BandView[] {
  return Array.from({ length: BAND_COUNT }, (_, i) => {
    const ids = bandIds(i + 1);
    return {
      number: i + 1,
      isOn: Boolean(values[ids.on]),
      type: values[ids.type] as BandType,
      frequencyHz: Number(values[ids.freq]),
      gainDb: Number(values[ids.gain]),
      q: Number(values[ids.q]),
    };
  });
}

/** "Band 3 · Bell: 2.40 kHz, +3.5 dB, Q 1.20" (what a handle's hint and the readout say). */
export function describeBand(band: BandView, specs: EqProProps['specs']): string {
  const ids = bandIds(band.number);
  const spec = specs as unknown as Record<string, Parameters<typeof formatValue>[0]>;
  const parts = [formatValue(spec[ids.freq]!, band.frequencyHz)];
  if (hasGain(band.type)) parts.push(formatValue(spec[ids.gain]!, band.gainDb));
  parts.push(`Q ${formatValue(spec[ids.q]!, band.q)}`);
  return `Band ${band.number} · ${TYPE_LABELS[band.type]}${band.isOn ? '' : ' (off)'}: ${parts.join(', ')}`;
}
